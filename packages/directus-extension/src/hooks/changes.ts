import type { SchemaOverview } from '@directus/types';
import { getConfig } from '../config';
import { appendChanges, type ChangeInput } from '../services/journal';
import type { ApiContext, Register } from '../types';

type Key = string | number;

// Deleting from these can cascade into tracked collections through FKs (tasks.assignee → directus_users).
const CASCADE_DELETE_EVENTS = ['items.delete', 'users.delete', 'files.delete'];
const SYSTEM_PREFIX = 'directus_';
const PENDING_TTL_MS = 60_000;

/**
 * Journals items.create/update/delete for tracked collections, plus rows changed by DB-level
 * ON DELETE CASCADE / SET NULL, which Directus applies without emitting events.
 *
 * Directus emits actions after commit and does not await handlers, so a failed insert here
 * loses the change unless logged. See docs/adr/0001.
 */
export function registerChangeLog({ filter, action }: Register, { database, env, logger, services }: ApiContext): void {
	const { collections: tracked } = getConfig(env);

	if (tracked.size === 0) {
		logger.warn('[dirlocal] DIRLOCAL_COLLECTIONS is empty, change journal is idle');
		return;
	}

	// Children are collected in the delete filter (before the rows are gone) and journaled in the action (after commit).
	const pendingChildren = new Map<string, { at: number; changes: ChangeInput[] }>();
	const token = (collection: string, keys: Key[]) => `${collection}\u0000${keys.map(String).join('\u0001')}`;

	async function journal(changes: ChangeInput[]) {
		try {
			await appendChanges(database, changes);
		} catch (error) {
			const summary = changes.map((c) => `${c.op}:${c.collection}/${c.key}`).join(',');
			logger.error(error, `[dirlocal] failed to journal ${summary}`);
		}
	}

	const own = (collection: string, keys: Key[], op: ChangeInput['op'], fields: string[] | null, actor: string | null) =>
		tracked.has(collection) ? keys.map((key): ChangeInput => ({ collection, key, op, fields, actor })) : [];

	// System collections emit `<name>.*` instead of `items.*` (directus_files → files.create). An upload emits only
	// files.upload: FilesService creates and updates the row with events off.
	const scopes = ['items', ...[...tracked].filter((c) => c.startsWith(SYSTEM_PREFIX)).map((c) => c.slice(SYSTEM_PREFIX.length))];
	const createEvents = [...scopes.map((scope) => `${scope}.create`), ...(scopes.includes('files') ? ['files.upload'] : [])];
	const deleteEvents = [...new Set([...CASCADE_DELETE_EVENTS, ...scopes.map((scope) => `${scope}.delete`)])];

	for (const event of createEvents) {
		action(event, ({ collection, key, payload }, { accountability }) =>
			journal(own(collection, [key], 'c', Object.keys(payload ?? {}), accountability?.user ?? null)),
		);
	}

	// updateByQuery/updateMany apply one payload to all keys, so its keys are the changed fields for each item.
	for (const scope of scopes) {
		action(`${scope}.update`, ({ collection, keys, payload }, { accountability }) =>
			journal(own(collection, keys, 'u', Object.keys(payload ?? {}), accountability?.user ?? null)),
		);
	}

	for (const event of deleteEvents) {
		filter<Key[]>(event, async (keys, { collection }, { schema, accountability }) => {
			if (!schema) return keys;
			try {
				const children = await collectDependents(services, schema, tracked, collection, keys, accountability?.user ?? null);
				const now = Date.now();
				for (const [k, entry] of pendingChildren) if (now - entry.at > PENDING_TTL_MS) pendingChildren.delete(k);
				if (children.length > 0) pendingChildren.set(token(collection, keys), { at: now, changes: children });
			} catch (error) {
				logger.error(error, `[dirlocal] failed to collect cascade dependents of ${collection}`);
			}
			return keys;
		});

		action(event, ({ collection, keys }, { accountability }) => {
			const t = token(collection, keys);
			const children = pendingChildren.get(t)?.changes ?? [];
			pendingChildren.delete(t);
			return journal([...own(collection, keys, 'd', null, accountability?.user ?? null), ...children]);
		});
	}
}

/**
 * Rows in tracked collections that the database itself will delete (CASCADE) or rewrite (SET NULL/DEFAULT)
 * when `keys` of `collection` are deleted. Follows cascades transitively.
 */
async function collectDependents(
	services: ApiContext['services'],
	schema: SchemaOverview,
	tracked: Set<string>,
	collection: string,
	keys: Key[],
	actor: string | null,
): Promise<ChangeInput[]> {
	const result: ChangeInput[] = [];
	const seen = new Set<string>();
	const queue: [string, Key[]][] = [[collection, keys]];

	while (queue.length > 0) {
		const [parent, parentKeys] = queue.shift()!;

		for (const relation of schema.relations) {
			const onDelete = relation.schema?.on_delete;
			if (relation.related_collection !== parent || !onDelete || onDelete === 'NO ACTION' || onDelete === 'RESTRICT') continue;

			const child = schema.collections[relation.collection];
			if (!child) continue;

			// No accountability: this only lists keys for the journal, nothing is returned to a client.
			const items = new services.ItemsService(relation.collection, { schema });
			const rows: Record<string, Key>[] = await items.readByQuery(
				{ fields: [child.primary], filter: { [relation.field]: { _in: parentKeys } }, limit: -1 },
				{ emitEvents: false },
			);
			const childKeys = rows.map((row) => row[child.primary]!).filter((key) => !seen.has(`${relation.collection}:${key}`));
			if (childKeys.length === 0) continue;
			childKeys.forEach((key) => seen.add(`${relation.collection}:${key}`));

			const cascade = onDelete === 'CASCADE';
			if (tracked.has(relation.collection)) {
				result.push(
					...childKeys.map(
						(key): ChangeInput => ({
							collection: relation.collection,
							key,
							op: cascade ? 'd' : 'u',
							fields: cascade ? null : [relation.field],
							actor,
						}),
					),
				);
			}
			if (cascade) queue.push([relation.collection, childKeys]);
		}
	}

	return result;
}
