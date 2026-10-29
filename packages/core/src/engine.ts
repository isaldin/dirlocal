import type { RestClient } from '@directus/sdk';
import { Emitter } from './emitter.js';
import { CollectionInactiveError, ForbiddenError, GoneError, NetworkError } from './errors.js';
import { createLock, groupByItem, itemId, overlay, rekeyMutation, replaceValue, uuid as defaultUuid } from './outbox.js';
import { directusTransport } from './transport/directus.js';
import type { LocalQuery, Mutation, MutationResult, OfflineEvents, Row, Storage, SyncStatus, Transport, WriteOp } from './types.js';

export interface OfflineOptions {
	/** @directus/sdk client with rest() and auth. Ignored when `transport` is given. */
	directus?: RestClient<any>;
	transport?: Transport;
	storage: Storage;
	collections: string[];
	/** Delay between background syncs, ms. */
	pollInterval?: number;
	/** Rows per snapshot request, changes per pull request and mutations per push (the server may cap it lower). */
	batchSize?: number;
	/** UUID v4 generator for new keys and mutation ids. Default: crypto.randomUUID, else a getRandomValues/Math.random fallback. */
	uuid?: () => string;
}

export type MutationInput =
	| { op: 'create'; data: Row; key?: string }
	| { op: 'update'; key: string; patch: Row }
	| { op: 'delete'; key: string };

export interface Offline {
	/** Starts background sync. Resolves after the first attempt; never rejects — failures go to `status`/`error`. */
	start(): Promise<void>;
	stop(): void;
	/** Syncs now: push the outbox, snapshot new collections, pull. Concurrent calls share one run (plus one follow-up). Rejects on failure. */
	sync(): Promise<void>;
	/** Tell the engine about connectivity (e.g. from NetInfo). Going online triggers a sync. */
	setOnline(online: boolean): void;
	getStatus(): SyncStatus;
	query(collection: string, query?: LocalQuery): Promise<Row[]>;
	get(collection: string, key: string): Promise<Row | null>;
	/**
	 * Applies the change locally at once and queues it for the server. Resolves with the item key
	 * (a new UUID for create unless `key` is given). The collection must have been snapshotted.
	 */
	mutate(collection: string, mutation: MutationInput): Promise<string>;
	/** Unsent mutations, oldest first. */
	pending(): Promise<Mutation[]>;
	/** Stops syncing and wipes local rows, cursor and unsent mutations: for logout or switching users. */
	clear(): Promise<void>;
	on<K extends keyof OfflineEvents>(event: K, handler: (payload: OfflineEvents[K]) => void): () => void;
	readonly storage: Storage;
}

/** A row as the server sees it; null = deleted or not visible. */
interface ServerRow {
	collection: string;
	key: string;
	row: Row | null;
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
	const uuid = options.uuid ?? defaultUuid;
	const events = new Emitter<OfflineEvents>();
	// Everything that reads the outbox and then writes rows runs under this lock (see applyFromServer).
	const lock = createLock();

	const unavailable = new Set<string>();
	const primaryKeys = new Map<string, string>();
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

	async function emitOutbox() {
		events.emit('outbox', { pending: (await storage.outbox()).length });
	}

	/** Writes rows from the server, replaying unsent mutations on top so local edits stay visible until pushed. */
	function applyFromServer(rows: ServerRow[], state?: Record<string, string | null>) {
		return lock(async () => {
			const pending = groupByItem(await storage.outbox());
			const ops = rows.map(({ collection, key, row }): WriteOp => {
				const queued = pending.get(itemId(collection, key));
				const next = queued ? overlay(row, queued) : row;
				return next ? { type: 'upsert', collection, row: next } : { type: 'delete', collection, key };
			});
			await write(ops, state);
		});
	}

	async function markUnavailable(collection: string, reason: 'inactive' | 'forbidden') {
		unavailable.add(collection);
		await lock(async () => {
			const keys = await storage.keys(collection);
			await write(
				keys.map((key) => ({ type: 'delete', collection, key })),
				{ [snapshotKey(collection)]: null },
			);
		});
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
			if (primaryKey === null) continue;
			primaryKeys.set(collection, primaryKey);
			infos.push({ collection, primaryKey });
		}
		await storage.prepare(infos);
		prepared = true;
	}

	async function snapshot(collection: string) {
		let head;
		try {
			head = await transport!.snapshotKeys(collection);
			const primaryKey = head.primary_key;
			await storage.prepare([{ collection, primaryKey }]);
			await storage.write([], { [primaryKeyKey(collection)]: primaryKey });
			primaryKeys.set(collection, primaryKey);
			for (let i = 0; i < head.keys.length; i += batchSize) {
				const rows = await transport!.snapshotItems(collection, head.keys.slice(i, i + batchSize));
				await applyFromServer(rows.map((row) => ({ collection, key: String(row[primaryKey]), row })));
			}
		} catch (error) {
			if (await handledAsUnavailable(collection, error)) return;
			throw error;
		}

		// Rows the server no longer lists are gone or invisible, unless created locally and not pushed yet
		// (applyFromServer keeps those). Rows deleted after the key list was taken stay until pull delivers
		// their delete (the cursor predates the key list).
		const listed = new Set(head.keys);
		const stale = (await storage.keys(collection)).filter((key) => !listed.has(key));
		const current = await storage.getState(CURSOR);
		// One cursor for all collections: the oldest wins, re-delivery is harmless, a gap is not.
		const cursor = current === null ? head.cursor : Math.min(Number(current), head.cursor);
		await applyFromServer(
			stale.map((key) => ({ collection, key, row: null })),
			{ [snapshotKey(collection)]: '1', [CURSOR]: String(cursor) },
		);
	}

	async function pull() {
		for (;;) {
			const names = active();
			if (names.length === 0) return;

			const cursor = Number((await storage.getState(CURSOR)) ?? 0);
			const response = await transport!.pull({ cursor, collections: names, limit: batchSize });
			await applyFromServer(
				response.changes.map((change) => ({ collection: change.collection, key: change.key, row: change.op === 'upsert' ? change.data! : null })),
				{ [CURSOR]: String(response.next_cursor) },
			);
			for (const collection of response.inactive) await markUnavailable(collection, 'inactive');
			if (!response.has_more) return;
		}
	}

	/** Server rows for items whose local state may be wrong: the server refused all or part of the edit. */
	async function fetchRows(items: Map<string, Set<string>>): Promise<ServerRow[]> {
		const result: ServerRow[] = [];
		for (const [collection, keySet] of items) {
			const keys = [...keySet];
			const primaryKey = primaryKeys.get(collection)!;
			let rows: Row[] = [];
			try {
				rows = await transport!.snapshotItems(collection, keys);
			} catch (error) {
				if (!(error instanceof ForbiddenError || error instanceof CollectionInactiveError)) throw error;
			}
			const found = new Map(rows.map((row) => [String(row[primaryKey]), row]));
			for (const key of keys) result.push({ collection, key, row: found.get(key) ?? null });
		}
		return result;
	}

	/**
	 * Replaces a client key with the server's (integer primary keys, ADR 0003): the row, top-level references
	 * in every local row, and unsent mutations. Scans all local rows — integer keys are the rare path.
	 * Idempotent: a retry after a crash finds nothing left to rewrite.
	 */
	async function rekey(collection: string, from: string, to: string | number, sent: Set<string>) {
		const ops: WriteOp[] = [{ type: 'delete', collection, key: from }];
		for (const name of collections) {
			for (const row of await storage.query(name)) {
				const replaced = replaceValue(row, from, to);
				if (replaced) ops.push({ type: 'upsert', collection: name, row: replaced });
			}
		}
		const unsent = (await storage.outbox()).filter((mutation) => !sent.has(mutation.mutation_id));
		const put = unsent.map((mutation) => rekeyMutation(mutation, collection, from, to)).filter((mutation, i) => mutation !== unsent[i]);
		await storage.write(ops, undefined, { put });
	}

	async function push() {
		for (;;) {
			const batch = (await storage.outbox()).slice(0, batchSize);
			if (batch.length === 0) return;

			const results = new Map<string, MutationResult>((await transport!.push(batch)).map((r) => [r.mutation_id, r]));
			const done = batch.filter((mutation) => results.has(mutation.mutation_id));
			if (done.length === 0) throw new Error('push: the server returned no results for the batch');

			// Keys the server replaced earlier in the batch, so later mutations of the batch refer to the new key.
			const serverKeys = new Map<string, string>();
			const refresh = new Map<string, Set<string>>();
			for (const mutation of done) {
				const result = results.get(mutation.mutation_id)!;
				const key = serverKeys.get(itemId(mutation.collection, mutation.key)) ?? mutation.key;
				if (result.server_key !== undefined) serverKeys.set(itemId(mutation.collection, mutation.key), String(result.server_key));
				if (result.status !== 'applied') refresh.set(mutation.collection, (refresh.get(mutation.collection) ?? new Set()).add(key));
			}
			const fresh = await fetchRows(refresh);

			await lock(async () => {
				const sent = new Set(done.map((mutation) => mutation.mutation_id));
				for (const mutation of done) {
					const serverKey = results.get(mutation.mutation_id)!.server_key;
					if (serverKey !== undefined) await rekey(mutation.collection, mutation.key, serverKey, sent);
				}
				await storage.write([], undefined, { remove: [...sent] });
			});
			await applyFromServer(fresh);
			changedLocally(new Set(done.map((mutation) => mutation.collection)));

			for (const mutation of done) {
				const result = results.get(mutation.mutation_id)!;
				if (result.status === 'conflict') events.emit('conflict', { mutation, conflicts: result.conflicts ?? [] });
				if (result.status === 'rejected') events.emit('rejected', { mutation, error: result.error ?? { code: 'UNKNOWN', message: 'rejected' } });
			}
			await emitOutbox();
		}
	}

	function changedLocally(names: Set<string>) {
		if (names.size > 0) events.emit('change', { collections: [...names] });
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
			// Push first: local edits reach the server even if a snapshot below fails.
			await push();
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

	async function mutate(collection: string, input: MutationInput): Promise<string> {
		if (!collections.includes(collection)) throw new Error(`mutate: collection not configured: ${collection}`);
		if (!prepared) await prepare();
		const primaryKey = primaryKeys.get(collection);
		if (!primaryKey) throw new Error(`mutate: ${collection} has no local data yet (first snapshot pending)`);

		const key = await lock(async () => {
			const base_version = Number((await storage.getState(CURSOR)) ?? 0);
			const mutation_id = uuid();

			if (input.op === 'create') {
				const key = input.key ?? (input.data[primaryKey] == null ? uuid() : String(input.data[primaryKey]));
				const data = { ...input.data, [primaryKey]: key };
				await storage.write([{ type: 'upsert', collection, row: data }], undefined, {
					put: [{ mutation_id, collection, op: 'create', key, data }],
				});
				return key;
			}

			const current = await storage.get(collection, input.key);
			if (!current) throw new Error(`mutate: ${collection}/${input.key} not found locally`);
			const [op, mutation]: [WriteOp, Mutation] =
				input.op === 'update'
					? [
							{ type: 'upsert', collection, row: { ...current, ...input.patch } },
							{ mutation_id, collection, op: 'update', key: input.key, patch: input.patch, base_version },
						]
					: [{ type: 'delete', collection, key: input.key }, { mutation_id, collection, op: 'delete', key: input.key, base_version }];
			await storage.write([op], undefined, { put: [mutation] });
			return input.key;
		});

		changedLocally(new Set([collection]));
		await emitOutbox();
		if (running && online) schedule(0);
		return key;
	}

	function stop() {
		running = false;
		clearTimeout(timer);
		setStatus('stopped');
	}

	return {
		storage,
		async start() {
			if (running) return;
			running = true;
			await tick();
		},
		stop,
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
		get: (collection, key) => storage.get(collection, key),
		mutate,
		pending: () => storage.outbox(),
		async clear() {
			stop();
			// A running sync would write the previous user's data after the wipe.
			await inFlight?.catch(() => undefined);
			await lock(() => storage.clear());
			unavailable.clear();
			primaryKeys.clear();
			prepared = false;
			changedLocally(new Set(collections));
			await emitOutbox();
		},
		on: (event, handler) => events.on(event, handler),
	};
}
