import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '../src/storage/memory.js';
import { FakeServer, ME } from './fake-server.js';
import { ids, setup } from './setup.js';

afterEach(() => {
	vi.useRealTimers();
});

/** Engine that has snapshotted `tasks` (t1) and `projects`, then lost the network. */
async function offlineAfterSnapshot(options: Parameters<typeof setup>[0] = {}) {
	const ctx = setup(options);
	ctx.server.put('tasks', { id: 't1', title: 'Fit the shower', status: 'todo' });
	await ctx.offline.sync();
	ctx.server.offline = true;
	return ctx;
}

describe('mutate', () => {
	it('applies create, update and delete locally at once and queues them', async () => {
		const { offline, seen } = await offlineAfterSnapshot();

		const key = await offline.mutate('tasks', { op: 'create', data: { title: 'New task' } });
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });
		await offline.mutate('tasks', { op: 'delete', key });

		expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(await offline.query('tasks')).toEqual([{ id: 't1', title: 'Fit the shower', status: 'done' }]);
		expect((await offline.pending()).map((m) => m.op)).toEqual(['create', 'update', 'delete']);
		expect(seen.outbox.at(-1)).toEqual({ pending: 3 });
		expect(seen.change.filter((c) => c.collections.includes('tasks')).length).toBeGreaterThanOrEqual(3);
	});

	it('pushes the outbox in order when the network is back, then empties it', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		const key = await offline.mutate('tasks', { op: 'create', data: { title: 'Made offline' } });
		await offline.mutate('tasks', { op: 'update', key, patch: { status: 'in_progress' } });
		await expect(offline.sync()).rejects.toThrow('fetch failed');

		server.offline = false;
		await offline.sync();

		expect(server.tables.get('tasks')!.get(key)).toEqual({ id: key, title: 'Made offline', status: 'in_progress' });
		expect(await offline.pending()).toEqual([]);
		expect(seen.outbox.at(-1)).toEqual({ pending: 0 });
		expect(await offline.get('tasks', key)).toMatchObject({ title: 'Made offline', status: 'in_progress' });
	});

	it('sends the cursor at edit time as base_version', async () => {
		const { offline, storage } = await offlineAfterSnapshot();
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });

		expect((await offline.pending())[0]!.base_version).toBe(Number(await storage.getState('cursor')));
	});

	it('keeps an edit made during sync visible over the row pulled from the server', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		server.offline = false;
		server.put('tasks', { id: 't1', title: 'Renamed on the server' });
		// The user edits after push ran and before pull's rows are written.
		const pull = server.pull.bind(server);
		vi.spyOn(server, 'pull').mockImplementationOnce(async (params) => {
			await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });
			return pull(params);
		});

		await offline.sync();

		expect(await offline.get('tasks', 't1')).toEqual({ id: 't1', title: 'Renamed on the server', status: 'done' });
		expect(await offline.pending()).toHaveLength(1);
	});

	it('server wins on conflicting fields: emits conflict and shows the server value', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { title: 'Mine', status: 'done' } });
		server.put('tasks', { id: 't1', title: 'Theirs' });

		server.offline = false;
		await offline.sync();

		expect(seen.conflict).toEqual([
			{ mutation: expect.objectContaining({ key: 't1', op: 'update' }), conflicts: [{ field: 'title', server_value: 'Theirs' }] },
		]);
		expect(await offline.get('tasks', 't1')).toEqual({ id: 't1', title: 'Theirs', status: 'done' });
		expect(await offline.pending()).toEqual([]);
	});

	it('keeps edits of different fields from two devices', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });
		server.put('tasks', { id: 't1', title: 'Renamed elsewhere' });

		server.offline = false;
		await offline.sync();

		const expected = { id: 't1', title: 'Renamed elsewhere', status: 'done' };
		expect(server.tables.get('tasks')!.get('t1')).toEqual(expected);
		expect(await offline.get('tasks', 't1')).toEqual(expected);
	});

	it('restores the server row when a mutation is rejected', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		server.denied.add('tasks/delete').add('tasks/create');
		await offline.mutate('tasks', { op: 'delete', key: 't1' });
		const created = await offline.mutate('tasks', { op: 'create', data: { title: 'Not allowed' } });

		server.offline = false;
		await offline.sync();

		expect(seen.rejected.map((r) => [r.mutation.op, r.error.code])).toEqual([
			['delete', 'FORBIDDEN'],
			['create', 'FORBIDDEN'],
		]);
		expect(ids(await offline.query('tasks'))).toEqual(['t1']);
		expect(await offline.get('tasks', created)).toBeNull();
	});

	it('drops a local edit of an item deleted on the server', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });
		server.remove('tasks', 't1');

		server.offline = false;
		await offline.sync();

		expect(seen.rejected[0]!.error.code).toBe('DELETED');
		expect(await offline.query('tasks')).toEqual([]);
	});

	it('does not apply a mutation twice when the push response is lost', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		const key = await offline.mutate('tasks', { op: 'create', data: { title: 'Once' } });
		server.offline = false;
		server.loseNextPushResponse = true;

		await expect(offline.sync()).rejects.toThrow('response lost');
		expect(await offline.pending()).toHaveLength(1);
		await offline.sync();

		expect(server.calls.push).toBe(2);
		expect(server.journal.filter((e) => e.key === key && e.op === 'c')).toHaveLength(1);
		expect(await offline.pending()).toEqual([]);
	});

	it('re-keys rows created with an integer key on the server, including references and later mutations', async () => {
		const server = new FakeServer(['tasks', 'projects', 'notes']);
		server.integerKeys.add('notes');
		server.put('notes', { id: 1, body: 'existing' });
		const { offline } = await offlineAfterSnapshot({ server, collections: ['tasks', 'notes'] });

		const note = await offline.mutate('notes', { op: 'create', data: { body: 'draft' } });
		const task = await offline.mutate('tasks', { op: 'create', data: { title: 'Has a note', note } });
		server.offline = false;
		// Push only the first mutation, so the second is rewritten in the outbox rather than by the server.
		const push = vi.spyOn(server, 'push');
		push.mockImplementationOnce((mutations) => FakeServer.prototype.push.call(server, mutations.slice(0, 1)));
		await offline.sync();

		const serverKey = String([...server.tables.get('notes')!.keys()].find((k) => k !== '1'));
		expect(await offline.get('notes', note)).toBeNull();
		expect(await offline.get('notes', serverKey)).toEqual({ id: Number(serverKey), body: 'draft' });
		expect(await offline.get('tasks', task)).toMatchObject({ note: Number(serverKey) });
		expect(server.tables.get('tasks')!.get(task)).toMatchObject({ note: Number(serverKey) });
	});

	it('keeps unsent creates when a re-snapshot no longer lists them', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		server.offline = false;
		server.changePermissions();
		// Created after push ran, while the 410 re-snapshot is listing keys.
		let key = '';
		const snapshotKeys = server.snapshotKeys.bind(server);
		vi.spyOn(server, 'snapshotKeys').mockImplementation(async (collection) => {
			const head = await snapshotKeys(collection);
			if (collection === 'tasks' && !key) key = await offline.mutate('tasks', { op: 'create', data: { title: 'Pending' } });
			return head;
		});

		await offline.sync();

		expect(seen.reset).toHaveLength(1);
		expect(await offline.get('tasks', key)).toMatchObject({ title: 'Pending' });
		expect(await offline.pending()).toHaveLength(1);
	});

	it('pushes soon after a mutation while running', async () => {
		vi.useFakeTimers();
		const { server, offline } = setup();
		server.put('tasks', { id: 't1', title: 'a' });
		await offline.start();

		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { title: 'b' } });
		await vi.advanceTimersByTimeAsync(0);

		expect(server.tables.get('tasks')!.get('t1')).toMatchObject({ title: 'b' });
		offline.stop();
	});

	it('refuses collections without local data', async () => {
		const { offline } = setup();
		await expect(offline.mutate('tasks', { op: 'create', data: {} })).rejects.toThrow(/first snapshot/);
		await expect(offline.mutate('invoices', { op: 'create', data: {} })).rejects.toThrow(/not configured/);
	});

	it('clear() wipes rows, cursor and outbox and stops syncing', async () => {
		const storage = memoryStorage();
		const { offline, seen } = await offlineAfterSnapshot({ storage });
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });

		await offline.clear();

		expect(await offline.query('tasks')).toEqual([]);
		expect(await offline.pending()).toEqual([]);
		expect(await storage.getState('cursor')).toBeNull();
		expect(offline.getStatus()).toBe('stopped');
		expect(seen.outbox.at(-1)).toEqual({ pending: 0 });
	});

	it('journals pushed edits as the client user', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { status: 'done' } });
		server.offline = false;
		await offline.sync();
		expect(server.journal.at(-1)).toMatchObject({ key: 't1', actor: ME, fields: ['status', 'id'] });
	});
});
