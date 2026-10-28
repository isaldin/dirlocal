import type { ApiContext } from './types';

export interface Config {
	collections: Set<string>;
	retentionDays: number;
	maxBatch: number;
	settleMs: number;
}

/** Settings come from Directus env, not a collection: on the Core tier a collection would take one of 25 slots. */
export function getConfig(env: ApiContext['env']): Config {
	const raw: unknown = env['DIRLOCAL_COLLECTIONS'];
	// Directus env casts comma-separated values to arrays, so accept both shapes.
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');

	return {
		collections: new Set(list.map((name) => String(name).trim()).filter(Boolean)),
		retentionDays: positiveInt(env['DIRLOCAL_RETENTION_DAYS'], 30),
		maxBatch: positiveInt(env['DIRLOCAL_MAX_BATCH'], 500),
		settleMs: positiveInt(env['DIRLOCAL_SETTLE_MS'], 2000),
	};
}

function positiveInt(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isInteger(n) && n >= 0 && value !== undefined && value !== '' ? n : fallback;
}
