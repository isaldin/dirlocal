import type { Router } from 'express';
import type { Config } from '../config';
import { ensureTables } from '../hooks/schema';
import { settledCursor } from '../services/journal';
import { toPrimaryKeys } from '../services/visibility';
import type { ApiContext } from '../types';
import { badRequest, requireUser } from './http';

/**
 * GET  /dirlocal/snapshot?collection=      → { cursor, primary_key, keys }
 * POST /dirlocal/snapshot/items {collection, keys} → { data }
 * Contract in plan §6. Keys first, then data by key: offset paging loses rows when earlier ones are deleted,
 * and Directus rejects `_gt` on uuid fields, so keyset paging isn't available.
 */
export function registerSnapshot(router: Router, { services, getSchema, database }: ApiContext, config: Config): void {
	router.get('/snapshot', async (req, res, next) => {
		try {
			const accountability = requireUser(req, res);
			if (!accountability) return;

			const collection = String(req.query['collection'] ?? '');
			if (!config.collections.has(collection)) return badRequest(res, `collection not tracked: ${collection}`);

			// Fixed before reading: anything changed while the snapshot is fetched comes again via pull.
			await ensureTables(database);
			const cursor = await settledCursor(database, config.settleMs);

			const schema = await getSchema();
			const primary = schema.collections[collection]?.primary;
			if (!primary) return badRequest(res, `unknown collection: ${collection}`);

			const items = new services.ItemsService(collection, { schema, accountability });
			const rows: Record<string, unknown>[] = await items.readByQuery({ fields: [primary], sort: [primary], limit: -1 });

			res.json({ cursor, primary_key: primary, keys: rows.map((row) => String(row[primary])) });
		} catch (error) {
			next(error);
		}
	});

	router.post('/snapshot/items', async (req, res, next) => {
		try {
			const accountability = requireUser(req, res);
			if (!accountability) return;

			const { collection, keys } = (req.body ?? {}) as { collection?: unknown; keys?: unknown };
			if (typeof collection !== 'string' || !config.collections.has(collection)) {
				return badRequest(res, `collection not tracked: ${String(collection)}`);
			}
			if (!Array.isArray(keys) || keys.length === 0 || keys.length > config.maxBatch) {
				return badRequest(res, `keys must be a non-empty array of at most ${config.maxBatch}`);
			}

			const schema = await getSchema();
			const items = new services.ItemsService(collection, { schema, accountability });
			const data: Record<string, unknown>[] = await items.readMany(toPrimaryKeys(schema, collection, keys.map(String)), {
				fields: ['*'],
			});

			res.json({ data });
		} catch (error) {
			next(error);
		}
	});
}
