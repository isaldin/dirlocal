import { CHANGES_TABLE, ensureTables } from '../hooks/schema';
import type { Database } from '../types';

/** Pseudo-collection for "permissions changed" markers; pull answers 410 when one is newer than the cursor. */
export const PERMISSIONS_MARKER = '$permissions';

export type Op = 'c' | 'u' | 'd';

export interface ChangeInput {
	collection: string;
	key: string | number;
	op: Op;
	fields: string[] | null;
	actor: string | null;
}

export interface ChangeRow {
	id: number;
	collection: string;
	item_key: string;
	op: Op;
}

export async function appendChanges(database: Database, changes: ChangeInput[]): Promise<void> {
	if (changes.length === 0) return;
	await ensureTables(database);

	const created_at = new Date();
	await database(CHANGES_TABLE).insert(
		changes.map((change) => ({
			collection: change.collection,
			item_key: String(change.key),
			op: change.op,
			fields: change.fields === null ? null : JSON.stringify(change.fields),
			actor: change.actor,
			created_at,
		})),
	);
}

export async function maxId(database: Database): Promise<number> {
	const row = await database(CHANGES_TABLE).max({ id: 'id' }).first();
	return Number(row?.id ?? 0);
}

/** Highest id whose entry is older than the settle window: every id below it is either visible or rolled back. */
export async function settledCursor(database: Database, settleMs: number): Promise<number> {
	const row = await database(CHANGES_TABLE)
		.where('created_at', '<=', new Date(Date.now() - settleMs))
		.max({ id: 'id' })
		.first();
	return Number(row?.id ?? 0);
}

export async function readChanges(
	database: Database,
	options: { cursor: number; collections: string[]; settleMs: number; limit: number },
): Promise<ChangeRow[]> {
	const rows = await database(CHANGES_TABLE)
		.select('id', 'collection', 'item_key', 'op')
		.where('id', '>', options.cursor)
		.whereIn('collection', options.collections)
		.where('created_at', '<=', new Date(Date.now() - options.settleMs))
		.orderBy('id')
		.limit(options.limit);
	return rows.map((row) => ({ ...row, id: Number(row.id) }));
}

export interface Entry {
	id: number;
	op: Op;
	fields: string[] | null;
	actor: string | null;
}

/** Journal entries of one item newer than `version`, oldest first. */
export async function entriesSince(database: Database, collection: string, key: string, version: number): Promise<Entry[]> {
	const rows = await database(CHANGES_TABLE)
		.select('id', 'op', 'fields', 'actor')
		.where({ collection, item_key: key })
		.where('id', '>', version)
		.orderBy('id');
	// json columns come back parsed on Postgres and as text on SQLite/MySQL.
	return rows.map((row) => ({
		id: Number(row.id),
		op: row.op,
		fields: typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields,
		actor: row.actor,
	}));
}

/** True when entries past `cursor` exist but are still inside the settle window. */
export async function hasUnsettled(database: Database, cursor: number, collections: string[]): Promise<boolean> {
	const row = await database(CHANGES_TABLE).where('id', '>', cursor).whereIn('collection', collections).first('id');
	return row !== undefined;
}

export async function hasPermissionChange(database: Database, cursor: number): Promise<boolean> {
	const row = await database(CHANGES_TABLE).where({ collection: PERMISSIONS_MARKER }).where('id', '>', cursor).first('id');
	return row !== undefined;
}

/**
 * Drops entries older than the retention period unless they are the latest for their key.
 * The latest entry per key always survives, so an old cursor still sees every key changed since.
 */
export async function compact(database: Database, retentionDays: number): Promise<number> {
	await ensureTables(database);
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	// Derived table instead of a plain subquery: MySQL refuses to read the table it deletes from.
	const latest = database
		.select('id')
		.from(database(CHANGES_TABLE).max({ id: 'id' }).groupBy('collection', 'item_key').as('latest'));

	return database(CHANGES_TABLE).where('created_at', '<', cutoff).whereNotIn('id', latest).delete();
}
