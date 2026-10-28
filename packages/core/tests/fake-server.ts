import { CollectionInactiveError, ForbiddenError, GoneError, NetworkError } from '../src/errors.js';
import type { PullResponse, Row, Transport } from '../src/types.js';

/**
 * In-process stand-in for the dirlocal endpoints with the same semantics as plan §6:
 * journal with collapse, re-read visibility, 410 on permission change, inactive collections.
 * No settle window: everything is visible immediately.
 */
export class FakeServer implements Transport {
	tables = new Map<string, Map<string, Row>>();
	journal: { id: number; collection: string; key: string }[] = [];
	permissionsChangedAt = 0;
	inactive = new Set<string>();
	forbidden = new Set<string>();
	offline = false;
	calls = { pull: 0, snapshotKeys: 0, snapshotItems: 0 };

	constructor(collections: string[]) {
		for (const collection of collections) this.tables.set(collection, new Map());
	}

	private get maxId() {
		return this.journal.at(-1)?.id ?? 0;
	}

	put(collection: string, row: Row) {
		this.tables.get(collection)!.set(String(row['id']), row);
		this.journal.push({ id: this.maxId + 1, collection, key: String(row['id']) });
	}

	remove(collection: string, key: string) {
		this.tables.get(collection)!.delete(key);
		this.journal.push({ id: this.maxId + 1, collection, key });
	}

	changePermissions() {
		this.journal.push({ id: this.maxId + 1, collection: '$permissions', key: 'epoch' });
		this.permissionsChangedAt = this.maxId;
	}

	private guard(collection?: string) {
		if (this.offline) throw new NetworkError('fetch failed');
		if (collection && this.inactive.has(collection)) throw new CollectionInactiveError(collection);
		if (collection && this.forbidden.has(collection)) throw new ForbiddenError(collection);
	}

	async snapshotKeys(collection: string) {
		this.calls.snapshotKeys++;
		this.guard(collection);
		return { cursor: this.maxId, primary_key: 'id', keys: [...this.tables.get(collection)!.keys()] };
	}

	async snapshotItems(collection: string, keys: string[]) {
		this.calls.snapshotItems++;
		this.guard(collection);
		const table = this.tables.get(collection)!;
		return keys.flatMap((key) => (table.has(key) ? [structuredClone(table.get(key)!)] : []));
	}

	async pull({ cursor, collections, limit }: { cursor: number; collections: string[]; limit: number }): Promise<PullResponse> {
		this.calls.pull++;
		this.guard();
		if (this.permissionsChangedAt > cursor) throw new GoneError('permissions_changed');
		if (cursor > this.maxId) throw new GoneError('cursor_ahead');

		const rows = this.journal.filter((e) => e.id > cursor && collections.includes(e.collection)).slice(0, limit);
		const latest = new Map(rows.map((e) => [`${e.collection}/${e.key}`, e]));
		const inactive = collections.filter((c) => this.inactive.has(c));
		const changes = [...latest.values()]
			.filter((e) => !this.inactive.has(e.collection))
			.map((e) => {
				const row = this.forbidden.has(e.collection) ? undefined : this.tables.get(e.collection)!.get(e.key);
				return row
					? { collection: e.collection, key: e.key, op: 'upsert' as const, version: e.id, data: structuredClone(row) }
					: { collection: e.collection, key: e.key, op: 'delete' as const, version: e.id };
			});
		return { changes, next_cursor: rows.at(-1)?.id ?? cursor, has_more: rows.length === limit, inactive };
	}
}
