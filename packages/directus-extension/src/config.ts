import type { ApiContext } from './types';

/**
 * Collections tracked by the change journal.
 * Phase 0: read from DIRLOCAL_COLLECTIONS. Phase 1 replaces this with the `dirlocal_config` collection.
 */
export function getTrackedCollections(env: ApiContext['env']): Set<string> {
	const raw: unknown = env['DIRLOCAL_COLLECTIONS'];
	// Directus env casts comma-separated values to arrays, so accept both shapes.
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
	return new Set(list.map((name) => String(name).trim()).filter(Boolean));
}
