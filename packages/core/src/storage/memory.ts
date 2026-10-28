import type { CollectionInfo, LocalQuery, Row, Storage, WriteOp } from '../types.js';

/** In-memory Storage: for tests and as the reference behaviour for platform adapters. Not persistent. */
export function memoryStorage(): Storage {
	const tables = new Map<string, { primaryKey: string; rows: Map<string, Row> }>();
	const state = new Map<string, string>();

	return {
		async prepare(collections: CollectionInfo[]) {
			for (const info of collections) {
				const table = tables.get(info.collection);
				if (table) table.primaryKey = info.primaryKey;
				else tables.set(info.collection, { primaryKey: info.primaryKey, rows: new Map() });
			}
		},

		async getState(key) {
			return state.get(key) ?? null;
		},

		async write(ops: WriteOp[], updates = {}) {
			for (const op of ops) {
				const table = tables.get(op.collection);
				if (op.type === 'delete') {
					table?.rows.delete(op.key);
					continue;
				}
				if (!table) throw new Error(`collection not prepared: ${op.collection}`);
				table.rows.set(String(op.row[table.primaryKey]), structuredClone(op.row));
			}
			for (const [key, value] of Object.entries(updates)) {
				if (value === null) state.delete(key);
				else state.set(key, value);
			}
		},

		async keys(collection) {
			return [...(tables.get(collection)?.rows.keys() ?? [])];
		},

		async query(collection, query: LocalQuery = {}) {
			let rows = [...(tables.get(collection)?.rows.values() ?? [])];
			const where = Object.entries(query.where ?? {});
			if (where.length > 0) rows = rows.filter((row) => where.every(([field, value]) => (row[field] ?? null) === value));
			for (const { field, direction } of [...(query.orderBy ?? [])].reverse()) {
				const sign = direction === 'desc' ? -1 : 1;
				rows.sort((a, b) => sign * compare(a[field], b[field]));
			}
			if (query.limit !== undefined) rows = rows.slice(0, query.limit);
			return rows.map((row) => structuredClone(row));
		},

		async clear() {
			tables.forEach((table) => table.rows.clear());
			state.clear();
		},
	};
}

/** Nulls first, like SQLite. */
function compare(a: unknown, b: unknown): number {
	if (a === b) return 0;
	if (a === null || a === undefined) return -1;
	if (b === null || b === undefined) return 1;
	return (a as number | string) < (b as number | string) ? -1 : 1;
}
