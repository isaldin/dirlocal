import type { Router } from 'express';
import { getTrackedCollections } from '../config';
import { CHANGES_TABLE, ensureTables } from '../hooks/schema';
import type { ApiContext } from '../types';

/**
 * Phase 0 spike: proves ItemsService honours the caller's accountability inside a bundle endpoint.
 * GET /dirlocal/visible?collection=tasks → { user, cursor, keys } — keys are only those the caller may read.
 * Replaced by /pull and /snapshot in phase 1.
 */
export function registerVisible(router: Router, { services, getSchema, database, env }: ApiContext): void {
	const tracked = getTrackedCollections(env);

	router.get('/visible', async (req, res, next) => {
		try {
			const accountability = req.accountability;
			if (!accountability?.user) return void res.status(401).json({ error: 'authentication required' });

			const collection = String(req.query['collection'] ?? '');
			if (!tracked.has(collection)) return void res.status(400).json({ error: `collection not tracked: ${collection}` });

			await ensureTables(database);
			const schema = await getSchema();
			const primary = schema.collections[collection]?.primary;
			if (!primary) return void res.status(400).json({ error: `unknown collection: ${collection}` });

			const items = new services.ItemsService(collection, { schema, accountability });
			const rows: Record<string, unknown>[] = await items.readByQuery({ fields: [primary], limit: -1 });
			const max = await database(CHANGES_TABLE).max({ cursor: 'id' }).first();

			res.json({ user: accountability.user, cursor: Number(max?.cursor ?? 0), keys: rows.map((row) => row[primary]) });
		} catch (error) {
			next(error);
		}
	});
}
