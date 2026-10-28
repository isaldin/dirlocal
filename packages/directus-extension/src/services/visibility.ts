import type { Accountability, SchemaOverview } from '@directus/types';
import type { ApiContext } from '../types';

export type Visibility = { inactive: true } | { inactive: false; rows: Map<string, Record<string, unknown>> };

/**
 * Re-reads keys through ItemsService under the caller's accountability.
 * Keys missing from the result are deleted or no longer visible — the caller can't tell which, and doesn't need to.
 */
export async function readVisible(
	services: ApiContext['services'],
	schema: SchemaOverview,
	accountability: Accountability,
	collection: string,
	keys: string[],
): Promise<Visibility> {
	const info = schema.collections[collection];
	if (!info) return { inactive: false, rows: new Map() };

	const primary = info.primary;
	const items = new services.ItemsService(collection, { schema, accountability });

	try {
		const rows: Record<string, unknown>[] = await items.readMany(toPrimaryKeys(schema, collection, keys), { fields: ['*'] });
		return { inactive: false, rows: new Map(rows.map((row) => [String(row[primary]), row])) };
	} catch (error) {
		const code = (error as { code?: string }).code;
		if (code === 'FORBIDDEN') return { inactive: false, rows: new Map() };
		if (code === 'COLLECTION_INACTIVE') return { inactive: true };
		throw error;
	}
}

/** The journal stores keys as strings; integer primary keys must be numbers again for Directus key validation. */
export function toPrimaryKeys(schema: SchemaOverview, collection: string, keys: string[]): (string | number)[] {
	const info = schema.collections[collection];
	const type = info?.fields[info.primary]?.type;
	return type === 'integer' ? keys.map(Number) : keys;
}
