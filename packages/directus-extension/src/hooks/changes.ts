import { getTrackedCollections } from '../config';
import type { ApiContext, Register } from '../types';
import { CHANGES_TABLE, ensureTables } from './schema';

type Op = 'c' | 'u' | 'd';
type Key = string | number;

/**
 * Journals items.create/update/delete for tracked collections.
 *
 * Directus emits these actions after the transaction commits and does not await handlers,
 * so a failed insert here loses the change silently unless logged. See docs/adr/0001.
 */
export function registerChangeLog({ action }: Register, { database, env, logger }: ApiContext): void {
	const tracked = getTrackedCollections(env);

	if (tracked.size === 0) {
		logger.warn('[dirlocal] DIRLOCAL_COLLECTIONS is empty, change journal is idle');
		return;
	}

	async function log(collection: string, keys: Key[], op: Op, fields: string[] | null, actor: string | null) {
		if (!tracked.has(collection) || keys.length === 0) return;

		try {
			await ensureTables(database);
			await database(CHANGES_TABLE).insert(
				keys.map((key) => ({
					collection,
					item_key: String(key),
					op,
					fields: fields === null ? null : JSON.stringify(fields),
					actor,
				})),
			);
		} catch (error) {
			logger.error(error, `[dirlocal] failed to journal ${op} on ${collection} keys=${keys.join(',')}`);
		}
	}

	action('items.create', ({ collection, key, payload }, { accountability }) =>
		log(collection, [key], 'c', Object.keys(payload ?? {}), accountability?.user ?? null),
	);

	// updateByQuery/updateMany apply one payload to all keys, so its keys are the changed fields for each item.
	action('items.update', ({ collection, keys, payload }, { accountability }) =>
		log(collection, keys, 'u', Object.keys(payload ?? {}), accountability?.user ?? null),
	);

	action('items.delete', ({ collection, keys }, { accountability }) =>
		log(collection, keys, 'd', null, accountability?.user ?? null),
	);
}
