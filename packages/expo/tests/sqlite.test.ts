// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { expoSqlite } from '../src/sqlite.js';

// The real module pulls in react-native (Flow sources); the tests pass a database explicitly.
vi.mock('expo-sqlite', () => ({ openDatabaseAsync: vi.fn() }));

/**
 * node:sqlite behind the expo-sqlite method shapes the adapter uses. Checks the wiring;
 * the real native module is exercised by examples/expo-demo.
 */
function fakeExpoDatabase(db = new DatabaseSync(':memory:')) {
	const statements: string[] = [];
	const connection = {
		async runAsync(sql: string, params: (string | number | null)[]) {
			statements.push(sql);
			db.prepare(sql).run(...params);
			return { lastInsertRowId: 0, changes: 0 };
		},
		async getAllAsync<T>(sql: string, params: (string | number | null)[]) {
			return db.prepare(sql).all(...params) as T[];
		},
	};
	return {
		statements,
		database: {
			...connection,
			async execAsync(sql: string) {
				statements.push(sql);
				db.exec(sql);
			},
			async withExclusiveTransactionAsync(task: (tx: typeof connection) => Promise<void>) {
				db.exec('BEGIN IMMEDIATE');
				try {
					await task(connection);
					db.exec('COMMIT');
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			},
		},
	};
}

describe('expoSqlite', () => {
	it('stores and queries rows through the expo-sqlite API, in WAL mode', async () => {
		const { database, statements } = fakeExpoDatabase();
		const storage = expoSqlite({ database: database as never });

		await storage.prepare([{ collection: 'tasks', primaryKey: 'id' }]);
		await storage.write([{ type: 'upsert', collection: 'tasks', row: { id: 't1', status: 'done' } }], { cursor: '4' });

		expect(statements[0]).toBe('PRAGMA journal_mode = WAL');
		expect(await storage.query('tasks', { where: { status: 'done' } })).toEqual([{ id: 't1', status: 'done' }]);
		expect(await storage.getState('cursor')).toBe('4');
	});

	it('rolls back a failed batch', async () => {
		const { database } = fakeExpoDatabase();
		const storage = expoSqlite({ database: database as never });
		await storage.prepare([{ collection: 'tasks', primaryKey: 'id' }]);

		await expect(
			storage.write([
				{ type: 'upsert', collection: 'tasks', row: { id: 't1' } },
				{ type: 'upsert', collection: 'nope', row: { id: 'x' } },
			]),
		).rejects.toThrow();
		expect(await storage.keys('tasks')).toEqual([]);
	});
});
