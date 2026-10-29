export type Row = Record<string, unknown>;
export type Primitive = string | number | boolean | null;

/** Rows are stored whole (as JSON in SQLite); only the primary key field name is needed. */
export interface CollectionInfo {
	collection: string;
	primaryKey: string;
}

export interface LocalQuery {
	/** Equality only. */
	where?: Record<string, Primitive>;
	orderBy?: { field: string; direction?: 'asc' | 'desc' }[];
	limit?: number;
}

export type WriteOp = { type: 'upsert'; collection: string; row: Row } | { type: 'delete'; collection: string; key: string };

/** A local write waiting in the outbox; sent to `POST /dirlocal/push` as is (plan §6). */
export interface Mutation {
	mutation_id: string;
	collection: string;
	op: 'create' | 'update' | 'delete';
	key: string;
	data?: Row;
	patch?: Row;
	/** Client cursor when the edit was made: every journal entry up to it had been seen. */
	base_version?: number;
}

export interface MutationResult {
	mutation_id: string;
	status: 'applied' | 'conflict' | 'rejected';
	/** Key assigned by the server (integer primary keys, ADR 0003); typed like the primary key. */
	server_key?: string | number;
	conflicts?: { field: string; server_value: unknown }[];
	error?: { code: string; message: string };
}

/** Outbox changes applied together with row writes. `put` replaces an entry with the same id in place. */
export interface OutboxWrite {
	put?: Mutation[];
	remove?: string[];
}

/**
 * Local database. Implementations: memoryStorage() here, expoSqlite() in @dirlocal/expo.
 * Keys are strings (as in the protocol); an upsert takes its key from the row's primary key field.
 */
export interface Storage {
	/** Creates local tables if missing. Called on start and before a collection's first snapshot. Idempotent. */
	prepare(collections: CollectionInfo[]): Promise<void>;
	getState(key: string): Promise<string | null>;
	/** Applies row operations, state updates and outbox changes atomically. A null state value removes the key. */
	write(ops: WriteOp[], state?: Record<string, string | null>, outbox?: OutboxWrite): Promise<void>;
	/** One row by key, or null. */
	get(collection: string, key: string): Promise<Row | null>;
	/** Local keys of a collection; empty for a collection never prepared. */
	keys(collection: string): Promise<string[]>;
	query(collection: string, query?: LocalQuery): Promise<Row[]>;
	/** Unsent mutations in the order they were added. */
	outbox(): Promise<Mutation[]>;
	/** Removes rows, state and the outbox. */
	clear(): Promise<void>;
}

export interface PullChange {
	collection: string;
	key: string;
	op: 'upsert' | 'delete';
	version: number;
	data?: Row;
}

export interface PullResponse {
	changes: PullChange[];
	next_cursor: number;
	has_more: boolean;
	inactive: string[];
}

export interface SnapshotHead {
	cursor: number;
	primary_key: string;
	keys: string[];
}

/** Server API (plan §6). Errors are thrown as the classes from errors.ts. */
export interface Transport {
	snapshotKeys(collection: string): Promise<SnapshotHead>;
	snapshotItems(collection: string, keys: string[]): Promise<Row[]>;
	pull(params: { cursor: number; collections: string[]; limit: number }): Promise<PullResponse>;
	/** Results in request order. */
	push(mutations: Mutation[]): Promise<MutationResult[]>;
}

export type SyncStatus = 'stopped' | 'idle' | 'syncing' | 'offline' | 'error';

export interface OfflineEvents {
	/** Local rows of these collections changed. */
	change: { collections: string[] };
	status: { status: SyncStatus; error?: unknown };
	/** The server invalidated the cursor; collections are being re-snapshotted. Local rows stay until reconciled. */
	reset: { reason: string };
	/** The collection dropped out: inactive on the server (COLLECTION_INACTIVE) or not readable. Local rows were removed. */
	unavailable: { collection: string; reason: 'inactive' | 'forbidden' };
	error: { error: unknown };
	/** Number of unsent mutations changed. */
	outbox: { pending: number };
	/** The server kept its values for these fields (ADR 0002); local rows now show the server's version. */
	conflict: { mutation: Mutation; conflicts: NonNullable<MutationResult['conflicts']> };
	/** The server refused the mutation (permissions, validation, deleted item); the local row was restored from the server. */
	rejected: { mutation: Mutation; error: NonNullable<MutationResult['error']> };
}
