import type { Router } from 'express';
import type { Config } from '../config';
import { compact } from '../services/journal';
import type { ApiContext } from '../types';
import { requireUser } from './http';

/** POST /dirlocal/compact — admin only; same as the nightly schedule. */
export function registerCompact(router: Router, { database }: ApiContext, config: Config): void {
	router.post('/compact', async (req, res, next) => {
		try {
			const accountability = requireUser(req, res);
			if (!accountability) return;
			if (!accountability.admin) return void res.status(403).json({ error: 'forbidden' });

			const days = req.query['retention_days'] === undefined ? config.retentionDays : Number(req.query['retention_days']);
			if (!Number.isFinite(days) || days < 0) return void res.status(400).json({ error: 'bad_request' });

			res.json({ deleted: await compact(database, days) });
		} catch (error) {
			next(error);
		}
	});
}
