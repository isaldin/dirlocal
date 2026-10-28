import type { Database } from '../types';

export const CHANGES_TABLE = 'dirlocal_changes';

let pending: Promise<void> | undefined;

/**
 * Creates the dirlocal_* tables if missing. Memoized: safe to await from every hook and endpoint,
 * including after an extension reload, where `app.before` does not fire again.
 */
export function ensureTables(database: Database): Promise<void> {
	pending ??= createTables(database).catch((error: unknown) => {
		pending = undefined;
		throw error;
	});
	return pending;
}

async function createTables(database: Database): Promise<void> {
	if (await database.schema.hasTable(CHANGES_TABLE)) return;

	try {
		await database.schema.createTable(CHANGES_TABLE, (table) => {
			table.bigIncrements('id');
			table.string('collection', 64).notNullable();
			table.string('item_key', 255).notNullable();
			table.string('op', 1).notNullable();
			table.json('fields').nullable();
			table.uuid('actor').nullable();
			// Written by the app, not a DB default: the settle window compares it with app time (ADR 0001).
			table.timestamp('created_at', { useTz: true }).notNullable();
			table.index(['collection', 'item_key']);
			table.index(['collection', 'id']);
		});
	} catch (error) {
		// Another Directus instance may have created the table concurrently.
		if (!(await database.schema.hasTable(CHANGES_TABLE))) throw error;
	}
}
