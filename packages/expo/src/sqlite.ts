import { type SqlDriver, type SqlExecutor, sqliteStorage, type Storage } from '@dirlocal/core';
import { openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';

/** The subset of expo-sqlite's SQLiteDatabase the adapter uses. */
type Database = Pick<SQLiteDatabase, 'execAsync' | 'runAsync' | 'getAllAsync' | 'withExclusiveTransactionAsync'>;

export interface ExpoSqliteOptions {
	/** File name for openDatabaseAsync. Default `dirlocal.db`. */
	databaseName?: string;
	/** An already opened database; `databaseName` is ignored. */
	database?: Database | Promise<Database>;
}

/** Storage on expo-sqlite. Opens the database lazily on first use and switches it to WAL. */
export function expoSqlite(options: ExpoSqliteOptions = {}): Storage {
	let opened: Promise<Database> | undefined;
	const db = () =>
		(opened ??= (async () => {
			const database = await (options.database ?? openDatabaseAsync(options.databaseName ?? 'dirlocal.db'));
			await database.execAsync('PRAGMA journal_mode = WAL');
			return database;
		})());

	const executor = (database: Pick<Database, 'runAsync' | 'getAllAsync'>): SqlExecutor => ({
		async run(sql, params = []) {
			await database.runAsync(sql, params);
		},
		all: (sql, params = []) => database.getAllAsync(sql, params),
	});

	const driver: SqlDriver = {
		run: async (sql, params) => executor(await db()).run(sql, params),
		all: async (sql, params) => executor(await db()).all(sql, params),
		// Exclusive: other statements on the main connection can't interleave with the batch.
		transaction: async (fn) => (await db()).withExclusiveTransactionAsync((tx) => fn(executor(tx))),
	};

	return sqliteStorage(driver);
}
