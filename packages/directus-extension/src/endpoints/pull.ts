import type { Router } from 'express';
import type { Config } from '../config';
import { ensureTables } from '../hooks/schema';
import { hasPermissionChange, maxId, readChanges } from '../services/journal';
import { readVisible } from '../services/visibility';
import type { ApiContext } from '../types';
import { badRequest, intParam, requireUser } from './http';

interface Change {
	collection: string;
	key: string;
	op: 'upsert' | 'delete';
	version: number;
	data?: Record<string, unknown>;
}

/** GET /dirlocal/pull?cursor=&collections=&limit= — contract in plan §6. */
export function registerPull(router: Router, { services, getSchema, database }: ApiContext, config: Config): void {
	router.get('/pull', async (req, res, next) => {
		try {
			const accountability = requireUser(req, res);
			if (!accountability) return;

			const cursor = intParam(req.query['cursor'], 0);
			const limit = intParam(req.query['limit'], config.maxBatch);
			if (cursor === null) return badRequest(res, 'cursor must be a non-negative integer');
			if (limit === null || limit === 0) return badRequest(res, 'limit must be a positive integer');

			const requested = req.query['collections'] ? String(req.query['collections']).split(',') : [...config.collections];
			const untracked = requested.filter((name) => !config.collections.has(name));
			if (untracked.length > 0) return badRequest(res, `collections not tracked: ${untracked.join(',')}`);

			await ensureTables(database);
			if (await hasPermissionChange(database, cursor)) return void res.status(410).json({ error: 'gone', reason: 'permissions_changed' });
			if (cursor > (await maxId(database))) return void res.status(410).json({ error: 'gone', reason: 'cursor_ahead' });

			const rows = await readChanges(database, {
				cursor,
				collections: requested,
				settleMs: config.settleMs,
				limit: Math.min(limit, config.maxBatch),
			});

			// Collapse to the latest entry per key; the op is only a hint, visibility is decided by re-reading.
			const latest = new Map<string, Map<string, number>>();
			for (const row of rows) {
				const keys = latest.get(row.collection) ?? new Map<string, number>();
				keys.set(row.item_key, row.id);
				latest.set(row.collection, keys);
			}

			const schema = await getSchema();
			const changes: Change[] = [];
			const inactive: string[] = [];

			for (const [collection, keys] of latest) {
				const visible = await readVisible(services, schema, accountability, collection, [...keys.keys()]);
				if (visible.inactive) {
					inactive.push(collection);
					continue;
				}
				for (const [key, version] of keys) {
					const data = visible.rows.get(key);
					changes.push(data ? { collection, key, op: 'upsert', version, data } : { collection, key, op: 'delete', version });
				}
			}
			changes.sort((a, b) => a.version - b.version);

			res.json({
				changes,
				next_cursor: rows.at(-1)?.id ?? cursor,
				has_more: rows.length === Math.min(limit, config.maxBatch),
				inactive,
			});
		} catch (error) {
			next(error);
		}
	});
}
