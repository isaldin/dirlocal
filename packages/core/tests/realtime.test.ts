import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOffline } from '../src/engine.js';
import { memoryStorage } from '../src/storage/memory.js';
import type { CollectionInfo, RealtimeSource } from '../src/types.js';
import { FakeServer } from './fake-server.js';

afterEach(() => {
	vi.useRealTimers();
});

function fakeRealtime() {
	const calls = { start: [] as CollectionInfo[][], stop: 0 };
	let notify = () => {};
	const source: RealtimeSource = {
		start(collections, onChange) {
			calls.start.push(collections);
			notify = onChange;
		},
		stop() {
			calls.stop++;
		},
	};
	return { source, calls, notify: () => notify() };
}

describe('realtime and settling', () => {
	it('pulls again after retry_after_ms instead of waiting for the poll interval', async () => {
		vi.useFakeTimers();
		const server = new FakeServer(['tasks']);
		const offline = createOffline({ transport: server, storage: memoryStorage(), collections: ['tasks'], pollInterval: 60_000 });
		server.settlingFor = 300;

		await offline.start();
		const after = server.calls.pull;
		await vi.advanceTimersByTimeAsync(300);
		expect(server.calls.pull).toBe(after + 1);

		await vi.advanceTimersByTimeAsync(30_000); // no more settling: back to the poll interval
		expect(server.calls.pull).toBe(after + 1);
		offline.stop();
	});

	it('starts the realtime source after the first sync and pulls when it reports a change', async () => {
		vi.useFakeTimers();
		const server = new FakeServer(['tasks', 'projects']);
		const realtime = fakeRealtime();
		const offline = createOffline({
			transport: server,
			storage: memoryStorage(),
			collections: ['tasks', 'projects'],
			pollInterval: 60_000,
			realtime: realtime.source,
		});

		await offline.start();
		expect(realtime.calls.start).toEqual([
			[
				{ collection: 'tasks', primaryKey: 'id' },
				{ collection: 'projects', primaryKey: 'id' },
			],
		]);

		server.put('tasks', { id: 't1' });
		realtime.notify();
		await vi.advanceTimersByTimeAsync(0);
		expect((await offline.query('tasks')).map((r) => r['id'])).toEqual(['t1']);

		offline.stop();
		expect(realtime.calls.stop).toBe(1);
	});

	it('does not start realtime while the first sync fails', async () => {
		const server = new FakeServer(['tasks']);
		server.offline = true;
		const realtime = fakeRealtime();
		const offline = createOffline({ transport: server, storage: memoryStorage(), collections: ['tasks'], realtime: realtime.source });

		await offline.start();
		expect(realtime.calls.start).toEqual([]);
		offline.stop();
	});
});
