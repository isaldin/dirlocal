// One behaviour suite for every Storage: memoryStorage is the reference, sqliteStorage must match it.
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../src/storage/memory.js';
import { type SqlDriver, type SqlValue, sqliteStorage } from '../src/storage/sqlite.js';
import type { Storage } from '../src/types.js';

/** node:sqlite wrapped as the async driver; mirrors what the expo adapter does with expo-sqlite. */
function nodeSqlite(db = new DatabaseSync(':memory:')): SqlDriver {
	const executor = {
		async run(sql: string, params: SqlValue[] = []) {
			db.prepare(sql).run(...params);
		},
		async all<T>(sql: string, params: SqlValue[] = []) {
			return db.prepare(sql).all(...params) as T[];
		},
	};
	return {
		...executor,
		async transaction(fn) {
			db.exec('BEGIN IMMEDIATE');
			try {
				await fn(executor);
				db.exec('COMMIT');
			} catch (error) {
				db.exec('ROLLBACK');
				throw error;
			}
		},
	};
}

const upsert = (collection: string, row: Record<string, unknown>) => ({ type: 'upsert' as const, collection, row });
const ids = (rows: Record<string, unknown>[]) => rows.map((r) => r['id']);

describe.each([
	['memoryStorage', () => memoryStorage()],
	['sqliteStorage', () => sqliteStorage(nodeSqlite())],
])('%s', (_name, create: () => Storage) => {
	async function seeded() {
		const storage = create();
		await storage.prepare([
			{ collection: 'tasks', primaryKey: 'id' },
			{ collection: 'notes', primaryKey: 'note_id' },
		]);
		await storage.write([
			upsert('tasks', { id: 'a', status: 'done', rank: 2, urgent: true, meta: { tags: ['x'] } }),
			upsert('tasks', { id: 'b', status: 'todo', rank: 1, urgent: false }),
			upsert('tasks', { id: 'c', status: 'done', rank: null, urgent: false }),
			upsert('notes', { note_id: 7, body: 'int key' }),
		]);
		return storage;
	}

	it('round-trips rows, including nested JSON', async () => {
		const storage = await seeded();
		expect((await storage.query('tasks', { where: { id: 'a' } }))[0]).toEqual({ id: 'a', status: 'done', rank: 2, urgent: true, meta: { tags: ['x'] } });
		expect(await storage.keys('notes')).toEqual(['7']);
	});

	it('upserts by primary key and deletes by string key', async () => {
		const storage = await seeded();
		await storage.write([upsert('tasks', { id: 'a', status: 'todo' }), { type: 'delete', collection: 'notes', key: '7' }]);
		expect(await storage.query('tasks', { where: { id: 'a' } })).toEqual([{ id: 'a', status: 'todo' }]);
		expect(await storage.query('notes')).toEqual([]);
	});

	it('filters by equality on strings, booleans and null', async () => {
		const storage = await seeded();
		expect(ids(await storage.query('tasks', { where: { status: 'done' } })).sort()).toEqual(['a', 'c']);
		expect(ids(await storage.query('tasks', { where: { urgent: true } }))).toEqual(['a']);
		expect(ids(await storage.query('tasks', { where: { rank: null } }))).toEqual(['c']);
		expect(ids(await storage.query('tasks', { where: { status: 'done', urgent: false } }))).toEqual(['c']);
	});

	it('orders with nulls first and limits', async () => {
		const storage = await seeded();
		expect(ids(await storage.query('tasks', { orderBy: [{ field: 'rank' }] }))).toEqual(['c', 'b', 'a']);
		expect(ids(await storage.query('tasks', { orderBy: [{ field: 'rank', direction: 'desc' }], limit: 2 }))).toEqual(['a', 'b']);
	});

	it('keeps state, removes it with null', async () => {
		const storage = await seeded();
		await storage.write([], { cursor: '12', 'snapshot:tasks': '1' });
		await storage.write([], { 'snapshot:tasks': null });
		expect(await storage.getState('cursor')).toBe('12');
		expect(await storage.getState('snapshot:tasks')).toBeNull();
	});

	it('treats unknown collections as empty and ignores deletes there', async () => {
		const storage = await seeded();
		expect(await storage.keys('missing')).toEqual([]);
		expect(await storage.query('missing')).toEqual([]);
		await expect(storage.write([{ type: 'delete', collection: 'missing', key: 'x' }])).resolves.toBeUndefined();
		await expect(storage.write([upsert('missing', { id: 'x' })])).rejects.toThrow(/not prepared/);
	});

	it('does not let field names inject SQL', async () => {
		const storage = await seeded();
		expect(await storage.query('tasks', { where: { "x') OR 1=1 --": 'y' } })).toEqual([]);
	});

	it('clears rows and state', async () => {
		const storage = await seeded();
		await storage.write([], { cursor: '5' });
		await storage.clear();
		expect(await storage.query('tasks')).toEqual([]);
		expect(await storage.getState('cursor')).toBeNull();
	});
});

describe('sqliteStorage', () => {
	it('is atomic: a failing batch leaves rows and state untouched', async () => {
		const storage = sqliteStorage(nodeSqlite());
		await storage.prepare([{ collection: 'tasks', primaryKey: 'id' }]);
		await storage.write([upsert('tasks', { id: 'a' })], { cursor: '1' });

		await expect(storage.write([upsert('tasks', { id: 'b' }), upsert('unprepared', { id: 'c' })], { cursor: '2' })).rejects.toThrow();
		expect(await storage.keys('tasks')).toEqual(['a']);
		expect(await storage.getState('cursor')).toBe('1');
	});

	it('persists across instances on the same database (restart)', async () => {
		const db = new DatabaseSync(':memory:');
		const first = sqliteStorage(nodeSqlite(db));
		await first.prepare([{ collection: 'tasks', primaryKey: 'id' }]);
		await first.write([upsert('tasks', { id: 'a' })], { cursor: '3' });

		const second = sqliteStorage(nodeSqlite(db));
		expect(await second.getState('cursor')).toBe('3');
		expect(await second.keys('tasks')).toEqual(['a']); // readable before prepare()
		await second.write([{ type: 'delete', collection: 'tasks', key: 'a' }]);
		expect(await second.keys('tasks')).toEqual([]);
	});
});
