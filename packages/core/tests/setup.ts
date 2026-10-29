import { createOffline } from '../src/engine.js';
import { memoryStorage } from '../src/storage/memory.js';
import type { OfflineEvents, Storage } from '../src/types.js';
import { FakeServer } from './fake-server.js';

export const ids = (rows: { id?: unknown }[]) => rows.map((r) => r.id).sort();

/** Engine over a FakeServer, recording every event. */
export function setup(options: { collections?: string[]; storage?: Storage; server?: FakeServer; batchSize?: number } = {}) {
	const collections = options.collections ?? ['tasks', 'projects'];
	const server = options.server ?? new FakeServer(['tasks', 'projects', 'invoices', 'notes']);
	const storage = options.storage ?? memoryStorage();
	const offline = createOffline({ transport: server, storage, collections, pollInterval: 60_000, batchSize: options.batchSize ?? 2 });
	const seen: { [K in keyof OfflineEvents]: OfflineEvents[K][] } = {
		change: [],
		status: [],
		reset: [],
		unavailable: [],
		error: [],
		outbox: [],
		conflict: [],
		rejected: [],
	};
	for (const event of Object.keys(seen) as (keyof OfflineEvents)[]) offline.on(event, (p) => (seen[event] as unknown[]).push(p));
	return { server, storage, offline, seen };
}
