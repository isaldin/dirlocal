import type { CollectionInfo, LocalQuery, Primitive, Row, Storage, WriteOp } from '../types.js';

export type SqlValue = string | number | null;

export interface SqlExecutor {
	run(sql: string, params?: SqlValue[]): Promise<void>;
	all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
}

/** Minimal async SQLite driver; adapters wrap expo-sqlite, node:sqlite, wa-sqlite… The database needs JSON1. */
export interface SqlDriver extends SqlExecutor {
	/** Runs `fn` in an exclusive transaction; statements must go through `tx`. */
	transaction(fn: (tx: SqlExecutor) => Promise<void>): Promise<void>;
}

const STATE_TABLE = 'dirlocal_state';
const TABLE_PREFIX = 'dirlocal_c_';

/**
 * Storage on SQLite. One table per collection, `(key TEXT PRIMARY KEY, data TEXT)`, rows stored as JSON
 * and filtered with json_extract — no field schema (plan §7).
 */
export function sqliteStorage(driver: SqlDriver): Storage {
	const primaryKeys = new Map<string, string>();
	let ready: Promise<void> | undefined;

	const init = () =>
		(ready ??= driver.run(`CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL)`));

	async function tableExists(collection: string): Promise<boolean> {
		if (primaryKeys.has(collection)) return true;
		const rows = await driver.all("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", [tableName(collection)]);
		return rows.length > 0;
	}

	return {
		async prepare(collections: CollectionInfo[]) {
			await init();
			for (const { collection, primaryKey } of collections) {
				await driver.run(`CREATE TABLE IF NOT EXISTS ${table(collection)} (key TEXT PRIMARY KEY, data TEXT NOT NULL)`);
				primaryKeys.set(collection, primaryKey);
			}
		},

		async getState(key) {
			await init();
			const rows = await driver.all<{ value: string }>(`SELECT value FROM ${STATE_TABLE} WHERE key = ?`, [key]);
			return rows[0]?.value ?? null;
		},

		async write(ops: WriteOp[], state = {}) {
			await init();
			const deletable = new Set<string>();
			for (const op of ops) if (op.type === 'delete' && (await tableExists(op.collection))) deletable.add(op.collection);

			await driver.transaction(async (tx) => {
				for (const op of ops) {
					if (op.type === 'delete') {
						if (deletable.has(op.collection)) await tx.run(`DELETE FROM ${table(op.collection)} WHERE key = ?`, [op.key]);
						continue;
					}
					const primaryKey = primaryKeys.get(op.collection);
					if (!primaryKey) throw new Error(`collection not prepared: ${op.collection}`);
					await tx.run(
						`INSERT INTO ${table(op.collection)} (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data`,
						[String(op.row[primaryKey]), JSON.stringify(op.row)],
					);
				}
				for (const [key, value] of Object.entries(state)) {
					if (value === null) await tx.run(`DELETE FROM ${STATE_TABLE} WHERE key = ?`, [key]);
					else await tx.run(`INSERT INTO ${STATE_TABLE} (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [key, value]);
				}
			});
		},

		async keys(collection) {
			if (!(await tableExists(collection))) return [];
			return (await driver.all<{ key: string }>(`SELECT key FROM ${table(collection)}`)).map((row) => row.key);
		},

		async query(collection, query: LocalQuery = {}) {
			if (!(await tableExists(collection))) return [];
			const params: SqlValue[] = [];
			const where = Object.entries(query.where ?? {}).map(([field, value]) => {
				params.push(jsonPath(field));
				if (value === null) return 'json_extract(data, ?) IS NULL';
				params.push(toSql(value));
				return 'json_extract(data, ?) = ?';
			});
			// ASC puts NULLs first in SQLite, matching memoryStorage.
			const orderBy = (query.orderBy ?? []).map(({ field, direction }) => {
				params.push(jsonPath(field));
				return `json_extract(data, ?) ${direction === 'desc' ? 'DESC' : 'ASC'}`;
			});
			let sql = `SELECT data FROM ${table(collection)}`;
			if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
			if (orderBy.length > 0) sql += ` ORDER BY ${orderBy.join(', ')}`;
			if (query.limit !== undefined) {
				sql += ' LIMIT ?';
				params.push(query.limit);
			}
			return (await driver.all<{ data: string }>(sql, params)).map((row) => JSON.parse(row.data) as Row);
		},

		async clear() {
			await init();
			const tables = await driver.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?", [
				`${TABLE_PREFIX}%`,
			]);
			await driver.transaction(async (tx) => {
				for (const { name } of tables) await tx.run(`DELETE FROM ${quote(name)}`);
				await tx.run(`DELETE FROM ${STATE_TABLE}`);
			});
		},
	};
}

const tableName = (collection: string) => `${TABLE_PREFIX}${collection}`;
const table = (collection: string) => quote(tableName(collection));
const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
/** Bound as a parameter, so a field name can't inject SQL. */
const jsonPath = (field: string) => `$."${field.replaceAll('"', '\\"')}"`;
/** json_extract returns 1/0 for JSON booleans. */
const toSql = (value: Exclude<Primitive, null>): SqlValue => (typeof value === 'boolean' ? Number(value) : value);
