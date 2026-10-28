import type { RestClient } from '@directus/sdk';
import { Emitter } from './emitter.js';
import { CollectionInactiveError, ForbiddenError, GoneError, NetworkError } from './errors.js';
import { directusTransport } from './transport/directus.js';
import type { LocalQuery, OfflineEvents, Row, Storage, SyncStatus, Transport, WriteOp } from './types.js';

export interface OfflineOptions {
	/** @directus/sdk client with rest() and auth. Ignored when `transport` is given. */
	directus?: RestClient<any>;
	transport?: Transport;
	storage: Storage;
	collections: string[];
	/** Delay between background syncs, ms. */
	pollInterval?: number;
	/** Rows per snapshot request and changes per pull request (the server may cap it lower). */
	batchSize?: number;
}

export interface Offline {
	/** Starts background sync. Resolves after the first attempt; never rejects — failures go to `status`/`error`. */
	start(): Promise<void>;
	stop(): void;
	/** Syncs now. Concurrent calls share one run (plus one follow-up). Rejects on failure. */
	sync(): Promise<void>;
	/** Tell the engine about connectivity (e.g. from NetInfo). Going online triggers a sync. */
	setOnline(online: boolean): void;
	getStatus(): SyncStatus;
	query(collection: string, query?: LocalQuery): Promise<Row[]>;
	on<K extends keyof OfflineEvents>(event: K, handler: (payload: OfflineEvents[K]) => void): () => void;
	readonly storage: Storage;
}

const CURSOR = 'cursor';
const snapshotKey = (collection: string) => `snapshot:${collection}`;
const primaryKeyKey = (collection: string) => `pk:${collection}`;
const MAX_RESETS_PER_SYNC = 2;

export function createOffline(options: OfflineOptions): Offline {
	const transport = options.transport ?? (options.directus ? directusTransport(options.directus) : undefined);
	if (!transport) throw new Error('createOffline: pass `directus` (an @directus/sdk client) or `transport`');

	const { storage, collections } = options;
	const pollInterval = options.pollInterval ?? 60_000;
	const batchSize = options.batchSize ?? 500;
	const events = new Emitter<OfflineEvents>();

	const unavailable = new Set<string>();
	let prepared = false;
	let running = false;
	let online = true;
	let status: SyncStatus = 'stopped';
	let failures = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let inFlight: Promise<void> | null = null;
	let again = false;

	const active = () => collections.filter((collection) => !unavailable.has(collection));

	function setStatus(next: SyncStatus, error?: unknown) {
		if (next === status && error === undefined) return;
		status = next;
		events.emit('status', error === undefined ? { status } : { status, error });
	}

	async function write(ops: WriteOp[], state?: Record<string, string | null>) {
		await storage.write(ops, state);
		const changed = [...new Set(ops.map((op) => op.collection))];
		if (changed.length > 0) events.emit('change', { collections: changed });
	}

	async function markUnavailable(collection: string, reason: 'inactive' | 'forbidden') {
		unavailable.add(collection);
		const keys = await storage.keys(collection);
		await write(
			keys.map((key) => ({ type: 'delete', collection, key })),
			{ [snapshotKey(collection)]: null },
		);
		events.emit('unavailable', { collection, reason });
	}

	/** True when the error means the collection dropped out (and it has been handled). */
	async function handledAsUnavailable(collection: string, error: unknown): Promise<boolean> {
		if (error instanceof CollectionInactiveError) await markUnavailable(collection, 'inactive');
		else if (error instanceof ForbiddenError) await markUnavailable(collection, 'forbidden');
		else return false;
		return true;
	}

	/** Re-creates tables for collections snapshotted in an earlier session; new ones are prepared by snapshot(). */
	async function prepare() {
		const infos = [];
		for (const collection of collections) {
			const primaryKey = await storage.getState(primaryKeyKey(collection));
			if (primaryKey !== null) infos.push({ collection, primaryKey });
		}
		await storage.prepare(infos);
		prepared = true;
	}

	async function snapshot(collection: string) {
		let head;
		try {
			head = await transport!.snapshotKeys(collection);
			await storage.prepare([{ collection, primaryKey: head.primary_key }]);
			await storage.write([], { [primaryKeyKey(collection)]: head.primary_key });
			for (let i = 0; i < head.keys.length; i += batchSize) {
				const rows = await transport!.snapshotItems(collection, head.keys.slice(i, i + batchSize));
				await write(rows.map((row) => ({ type: 'upsert', collection, row })));
			}
		} catch (error) {
			if (await handledAsUnavailable(collection, error)) return;
			throw error;
		}

		// Rows the server no longer lists are gone or invisible. Rows deleted after the key list was taken
		// stay until pull delivers their delete (the cursor predates the key list).
		const listed = new Set(head.keys);
		const stale = (await storage.keys(collection)).filter((key) => !listed.has(key));
		const current = await storage.getState(CURSOR);
		// One cursor for all collections: the oldest wins, re-delivery is harmless, a gap is not.
		const cursor = current === null ? head.cursor : Math.min(Number(current), head.cursor);
		await write(
			stale.map((key) => ({ type: 'delete', collection, key })),
			{ [snapshotKey(collection)]: '1', [CURSOR]: String(cursor) },
		);
	}

	async function pull() {
		for (;;) {
			const names = active();
			if (names.length === 0) return;

			const cursor = Number((await storage.getState(CURSOR)) ?? 0);
			const response = await transport!.pull({ cursor, collections: names, limit: batchSize });
			await write(
				response.changes.map(
					(change): WriteOp =>
						change.op === 'upsert'
							? { type: 'upsert', collection: change.collection, row: change.data! }
							: { type: 'delete', collection: change.collection, key: change.key },
				),
				{ [CURSOR]: String(response.next_cursor) },
			);
			for (const collection of response.inactive) await markUnavailable(collection, 'inactive');
			if (!response.has_more) return;
		}
	}

	async function reset(reason: string) {
		events.emit('reset', { reason });
		// Local rows stay so the UI isn't emptied; the next snapshot reconciles them.
		await storage.write([], Object.fromEntries([[CURSOR, null], ...collections.map((c) => [snapshotKey(c), null])]));
		unavailable.clear();
		prepared = false;
	}

	async function runOnce() {
		for (let resets = 0; ; resets++) {
			if (!prepared) await prepare();
			for (const collection of active()) {
				if ((await storage.getState(snapshotKey(collection))) === null) await snapshot(collection);
			}
			try {
				await pull();
				return;
			} catch (error) {
				if (!(error instanceof GoneError) || resets >= MAX_RESETS_PER_SYNC) throw error;
				await reset(error.reason);
			}
		}
	}

	async function sync(): Promise<void> {
		if (inFlight) {
			again = true;
			return inFlight;
		}
		inFlight = (async () => {
			setStatus('syncing');
			try {
				do {
					again = false;
					await runOnce();
				} while (again);
				failures = 0;
				setStatus('idle');
			} catch (error) {
				failures++;
				setStatus(error instanceof NetworkError ? 'offline' : 'error', error);
				events.emit('error', { error });
				throw error;
			}
		})().finally(() => {
			inFlight = null;
		});
		return inFlight;
	}

	function schedule(delay: number) {
		clearTimeout(timer);
		if (running) timer = setTimeout(() => void tick(), delay);
	}

	async function tick() {
		if (!running) return;
		if (!online) return setStatus('offline');
		try {
			await sync();
			schedule(pollInterval);
		} catch {
			// Exponential backoff from 1 s, capped by the poll interval.
			schedule(Math.min(pollInterval, 1000 * 2 ** Math.min(failures - 1, 16)));
		}
	}

	return {
		storage,
		async start() {
			if (running) return;
			running = true;
			await tick();
		},
		stop() {
			running = false;
			clearTimeout(timer);
			setStatus('stopped');
		},
		sync,
		setOnline(next) {
			const wasOnline = online;
			online = next;
			if (!running) return;
			if (next && !wasOnline) schedule(0);
			if (!next) setStatus('offline');
		},
		getStatus: () => status,
		query: (collection, query) => storage.query(collection, query),
		on: (event, handler) => events.on(event, handler),
	};
}
