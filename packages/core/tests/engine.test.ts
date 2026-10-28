import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOffline } from '../src/engine.js';
import { memoryStorage } from '../src/storage/memory.js';
import type { OfflineEvents, Storage } from '../src/types.js';
import { FakeServer } from './fake-server.js';

const ids = (rows: { id?: unknown }[]) => rows.map((r) => r.id).sort();

function setup(options: { collections?: string[]; storage?: Storage; server?: FakeServer; batchSize?: number } = {}) {
	const collections = options.collections ?? ['tasks', 'projects'];
	const server = options.server ?? new FakeServer(['tasks', 'projects', 'invoices']);
	const storage = options.storage ?? memoryStorage();
	const offline = createOffline({ transport: server, storage, collections, pollInterval: 60_000, batchSize: options.batchSize ?? 2 });
	const seen: { [K in keyof OfflineEvents]: OfflineEvents[K][] } = { change: [], status: [], reset: [], unavailable: [], error: [] };
	for (const event of Object.keys(seen) as (keyof OfflineEvents)[]) offline.on(event, (p) => (seen[event] as unknown[]).push(p));
	return { server, storage, offline, seen };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('createOffline', () => {
	it('snapshots every collection on first start and is idle afterwards', async () => {
		const { server, offline, seen, storage } = setup();
		for (let i = 1; i <= 5; i++) server.put('tasks', { id: `t${i}`, title: `task ${i}` });
		server.put('projects', { id: 'p1' });

		await offline.start();
		offline.stop();

		expect(ids(await offline.query('tasks'))).toEqual(['t1', 't2', 't3', 't4', 't5']);
		expect(ids(await offline.query('projects'))).toEqual(['p1']);
		expect(server.calls.snapshotItems).toBe(4); // 5 tasks in batches of 2, 1 project
		expect(await storage.getState('cursor')).toBe('6');
		expect(seen.status.map((s) => s.status)).toEqual(['syncing', 'idle', 'stopped']);
		expect(seen.change.flatMap((c) => c.collections)).toContain('tasks');
	});

	it('applies pulled upserts and deletes and pages until has_more is false', async () => {
		const { server, offline } = setup();
		server.put('tasks', { id: 't1', title: 'old' });
		server.put('tasks', { id: 't2' });
		await offline.sync();

		server.put('tasks', { id: 't1', title: 'new' });
		server.remove('tasks', 't2');
		for (let i = 3; i <= 7; i++) server.put('tasks', { id: `t${i}` });
		const before = server.calls.pull;
		await offline.sync();

		expect(server.calls.pull - before).toBeGreaterThanOrEqual(4); // 7 entries, batch 2
		const rows = await offline.query('tasks');
		expect(ids(rows)).toEqual(['t1', 't3', 't4', 't5', 't6', 't7']);
		expect(rows.find((r) => r['id'] === 't1')).toMatchObject({ title: 'new' });
		expect(server.calls.snapshotKeys).toBe(2); // only the first sync snapshotted
	});

	it('resumes from the stored cursor without re-snapshotting', async () => {
		const storage = memoryStorage();
		const server = new FakeServer(['tasks', 'projects']);
		server.put('tasks', { id: 't1' });
		await setup({ storage, server }).offline.sync();

		server.put('tasks', { id: 't2' });
		const second = setup({ storage, server });
		await second.offline.sync();

		expect(server.calls.snapshotKeys).toBe(2); // tasks + projects, once
		expect(ids(await second.offline.query('tasks'))).toEqual(['t1', 't2']);
	});

	it('snapshots a newly configured collection and keeps the oldest cursor', async () => {
		const storage = memoryStorage();
		const server = new FakeServer(['tasks', 'projects']);
		server.put('tasks', { id: 't1' });
		await setup({ storage, server, collections: ['tasks'] }).offline.sync();
		const cursor = await storage.getState('cursor');

		server.put('projects', { id: 'p1' });
		server.put('tasks', { id: 't2' });
		const widened = setup({ storage, server, collections: ['tasks', 'projects'] });
		await widened.offline.sync();

		expect(ids(await widened.offline.query('projects'))).toEqual(['p1']);
		expect(ids(await widened.offline.query('tasks'))).toEqual(['t1', 't2']);
		expect(Number(await storage.getState('cursor'))).toBeGreaterThan(Number(cursor));
	});

	it('re-snapshots on 410, reconciling local rows instead of wiping them', async () => {
		const { server, offline, seen } = setup();
		server.put('tasks', { id: 't1' });
		server.put('tasks', { id: 't2' });
		await offline.sync();

		// t2 vanished without a journal entry (e.g. lost access), then permissions changed.
		server.tables.get('tasks')!.delete('t2');
		server.tables.get('tasks')!.set('t3', { id: 't3' });
		server.changePermissions();
		const removals: string[][] = [];
		offline.on('change', async () => removals.push(ids(await offline.query('tasks')) as string[]));
		await offline.sync();

		expect(seen.reset).toEqual([{ reason: 'permissions_changed' }]);
		expect(ids(await offline.query('tasks'))).toEqual(['t1', 't3']);
		expect(removals.every((r) => r.includes('t1'))).toBe(true); // never emptied
	});

	it('drops a collection that becomes inactive and stops pulling it', async () => {
		const { server, offline, seen } = setup();
		server.put('tasks', { id: 't1' });
		server.put('projects', { id: 'p1' });
		await offline.sync();

		server.inactive.add('projects');
		server.put('tasks', { id: 't2' });
		await offline.sync();
		const spy = vi.spyOn(server, 'pull');
		await offline.sync();

		expect(seen.unavailable).toEqual([{ collection: 'projects', reason: 'inactive' }]);
		expect(await offline.query('projects')).toEqual([]);
		expect(ids(await offline.query('tasks'))).toEqual(['t1', 't2']);
		expect(spy.mock.calls[0]![0].collections).toEqual(['tasks']);
	});

	it('treats an unreadable collection as unavailable and syncs the rest', async () => {
		const server = new FakeServer(['tasks', 'projects', 'invoices']);
		server.forbidden.add('invoices');
		server.put('tasks', { id: 't1' });
		const { offline, seen } = setup({ server, collections: ['tasks', 'invoices'] });

		await offline.sync();

		expect(seen.unavailable).toEqual([{ collection: 'invoices', reason: 'forbidden' }]);
		expect(ids(await offline.query('tasks'))).toEqual(['t1']);
		expect(offline.getStatus()).toBe('idle');
	});

	it('goes offline on network errors and retries with backoff until it recovers', async () => {
		vi.useFakeTimers();
		const { server, offline, seen } = setup();
		server.put('tasks', { id: 't1' });
		server.offline = true;

		await offline.start();
		expect(offline.getStatus()).toBe('offline');
		expect(seen.error).toHaveLength(1);

		await vi.advanceTimersByTimeAsync(1000); // 1 s
		await vi.advanceTimersByTimeAsync(2000); // 2 s
		expect(seen.error).toHaveLength(3);

		server.offline = false;
		await vi.advanceTimersByTimeAsync(4000); // 4 s
		expect(offline.getStatus()).toBe('idle');
		expect(ids(await offline.query('tasks'))).toEqual(['t1']);
		offline.stop();
	});

	it('pauses while told it is offline and syncs when back online', async () => {
		vi.useFakeTimers();
		const { server, offline } = setup();
		await offline.start();
		offline.setOnline(false);
		expect(offline.getStatus()).toBe('offline');

		server.put('tasks', { id: 't1' });
		await vi.advanceTimersByTimeAsync(120_000);
		expect(await offline.query('tasks')).toEqual([]);

		offline.setOnline(true);
		await vi.advanceTimersByTimeAsync(0);
		expect(ids(await offline.query('tasks'))).toEqual(['t1']);
		offline.stop();
	});

	it('coalesces concurrent sync calls into one run plus one follow-up', async () => {
		const { server, offline } = setup();
		await offline.sync();
		const before = server.calls.pull;

		await Promise.all([offline.sync(), offline.sync(), offline.sync(), offline.sync()]);
		expect(server.calls.pull - before).toBe(2);
	});

	it('stays usable with local data when the first start fails', async () => {
		const storage = memoryStorage();
		const server = new FakeServer(['tasks', 'projects']);
		server.put('tasks', { id: 't1' });
		await setup({ storage, server }).offline.sync();

		server.offline = true;
		const restarted = setup({ storage, server });
		await expect(restarted.offline.start()).resolves.toBeUndefined();
		expect(ids(await restarted.offline.query('tasks'))).toEqual(['t1']);
		restarted.offline.stop();
	});
});

describe('memoryStorage.query', () => {
	it('filters by equality, orders and limits', async () => {
		const storage = memoryStorage();
		await storage.prepare([{ collection: 'tasks', primaryKey: 'id' }]);
		await storage.write(
			[
				{ id: 'a', status: 'done', rank: 2 },
				{ id: 'b', status: 'todo', rank: 1 },
				{ id: 'c', status: 'done', rank: null },
			].map((row) => ({ type: 'upsert' as const, collection: 'tasks', row })),
		);

		expect(ids(await storage.query('tasks', { where: { status: 'done' } }))).toEqual(['a', 'c']);
		expect((await storage.query('tasks', { orderBy: [{ field: 'rank' }] })).map((r) => r['id'])).toEqual(['c', 'b', 'a']);
		expect((await storage.query('tasks', { orderBy: [{ field: 'rank', direction: 'desc' }], limit: 1 })).map((r) => r['id'])).toEqual(['a']);
	});
});
