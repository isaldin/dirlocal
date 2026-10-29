import type { PrimaryKey } from '@directus/types';
import type { Router } from 'express';
import type { Config } from '../config';
import { ensureTables } from '../hooks/schema';
import { applyOnce, type Mutation, MutationInProgressError, type MutationResult, resolveKeys } from '../services/push';
import type { ApiContext } from '../types';
import { badRequest, requireUser } from './http';

const OPS = new Set(['create', 'update', 'delete']);

/** POST /dirlocal/push {mutations} → {results} — contract in plan §6. */
export function registerPush(router: Router, { services, getSchema, database }: ApiContext, config: Config): void {
	router.post('/push', async (req, res, next) => {
		try {
			const accountability = requireUser(req, res);
			if (!accountability) return;

			const mutations = parseMutations((req.body as { mutations?: unknown } | undefined)?.mutations, config);
			if (typeof mutations === 'string') return badRequest(res, mutations);

			await ensureTables(database);
			const schema = await getSchema();
			const ctx = { services, database, schema, accountability: { ...accountability, user: accountability.user! } };
			const serverKeys = new Map<string, PrimaryKey>();
			const results: MutationResult[] = [];

			for (const mutation of mutations) {
				const result = await applyOnce(ctx, resolveKeys(mutation, serverKeys));
				if (result.server_key !== undefined) serverKeys.set(mutation.key, result.server_key);
				results.push(result);
			}

			res.json({ results });
		} catch (error) {
			if (error instanceof MutationInProgressError) return void res.status(409).json({ error: 'conflict', reason: 'mutation_in_progress' });
			next(error);
		}
	});
}

function parseMutations(value: unknown, config: Config): Mutation[] | string {
	if (!Array.isArray(value) || value.length === 0 || value.length > config.maxBatch) {
		return `mutations must be a non-empty array of at most ${config.maxBatch}`;
	}
	for (const [i, m] of (value as Record<string, unknown>[]).entries()) {
		const where = `mutations[${i}]`;
		if (typeof m !== 'object' || m === null) return `${where} must be an object`;
		if (typeof m['mutation_id'] !== 'string' || m['mutation_id'].length === 0 || m['mutation_id'].length > 64) {
			return `${where}.mutation_id must be a string of 1-64 characters`;
		}
		if (typeof m['collection'] !== 'string' || !config.collections.has(m['collection'])) {
			return `${where}.collection not tracked: ${String(m['collection'])}`;
		}
		if (typeof m['op'] !== 'string' || !OPS.has(m['op'])) return `${where}.op must be create, update or delete`;
		if (typeof m['key'] !== 'string' || m['key'].length === 0) return `${where}.key must be a non-empty string`;
		if (m['op'] === 'create' && !isObject(m['data'])) return `${where}.data must be an object`;
		if (m['op'] === 'update' && !isObject(m['patch'])) return `${where}.patch must be an object`;
		const base = m['base_version'];
		if (base !== undefined && (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0)) {
			return `${where}.base_version must be a non-negative integer`;
		}
	}
	return value as Mutation[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
