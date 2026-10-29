import { CollectionInactiveError, ForbiddenError, GoneError, NetworkError } from '../src/errors.js';
import type { Mutation, MutationResult, PullResponse, Row, Transport } from '../src/types.js';

/** The client's user in FakeServer's journal; server-side edits from tests default to someone else. */
export const ME = 'me';

interface Entry {
	id: number;
	collection: string;
	key: string;
	op: 'c' | 'u' | 'd';
	fields: string[] | null;
	actor: string;
}

/**
 * In-process stand-in for the dirlocal endpoints with the same semantics as plan §6:
 * journal with collapse, re-read visibility, 410 on permission change, inactive collections,
 * push with idempotency, v1 conflicts and server-assigned integer keys.
 * No settle window: everything is visible immediately.
 */
export class FakeServer implements Transport {
	tables = new Map<string, Map<string, Row>>();
	journal: Entry[] = [];
	applied = new Map<string, MutationResult>();
	permissionsChangedAt = 0;
	inactive = new Set<string>();
	forbidden = new Set<string>();
	/** Collections with database-assigned integer keys (ADR 0003). */
	integerKeys = new Set<string>();
	/** Push applies, then fails as if the response was lost on the way back. */
	loseNextPushResponse = false;
	/** Mutations the client may not apply, as `collection/op`. */
	denied = new Set<string>();
	offline = false;
	calls = { pull: 0, snapshotKeys: 0, snapshotItems: 0, push: 0, upload: 0 };
	private nextInt = 100;

	constructor(collections: string[]) {
		for (const collection of collections) this.tables.set(collection, new Map());
	}

	private get maxId() {
		return this.journal.at(-1)?.id ?? 0;
	}

	private log(collection: string, key: string, op: Entry['op'], fields: string[] | null, actor: string) {
		this.journal.push({ id: this.maxId + 1, collection, key, op, fields, actor });
	}

	/** Creates or patches a row as `actor` (another user by default). */
	put(collection: string, row: Row, actor = 'other') {
		const table = this.tables.get(collection)!;
		const key = String(row['id']);
		const existing = table.get(key);
		table.set(key, { ...existing, ...row });
		this.log(collection, key, existing ? 'u' : 'c', Object.keys(row), actor);
	}

	remove(collection: string, key: string, actor = 'other') {
		this.tables.get(collection)!.delete(key);
		this.log(collection, key, 'd', null, actor);
	}

	changePermissions() {
		this.log('$permissions', 'epoch', 'u', null, 'admin');
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

	/** Uploaded file contents by id, as the URI the client sent. */
	files = new Map<string, string>();

	async upload(mutation: Mutation): Promise<MutationResult> {
		this.calls.upload++;
		this.guard();
		const { mutation_id, key } = mutation;
		if (this.denied.has('directus_files/upload')) return { mutation_id, status: 'rejected', error: { code: 'FORBIDDEN', message: 'denied' } };
		if (!this.files.has(key)) {
			if (!this.tables.has('directus_files')) this.tables.set('directus_files', new Map());
			this.files.set(key, mutation.file!.uri);
			this.put('directus_files', { ...mutation.data, id: key }, ME);
		}
		if (this.loseNextPushResponse) {
			this.loseNextPushResponse = false;
			throw new NetworkError('response lost');
		}
		return { mutation_id, status: 'applied' };
	}

	async push(mutations: Mutation[]): Promise<MutationResult[]> {
		this.calls.push++;
		this.guard();
		const serverKeys = new Map<string, string | number>();
		const resolve = (item?: Row) =>
			item && Object.fromEntries(Object.entries(item).map(([f, v]) => [f, typeof v === 'string' ? (serverKeys.get(v) ?? v) : v]));

		const results = mutations.map((original) => {
			const stored = this.applied.get(original.mutation_id);
			const result = stored ?? this.apply({ ...original, key: String(serverKeys.get(original.key) ?? original.key), data: resolve(original.data), patch: resolve(original.patch) });
			if (result.server_key !== undefined) serverKeys.set(original.key, result.server_key);
			this.applied.set(original.mutation_id, result);
			return structuredClone(result);
		});

		if (this.loseNextPushResponse) {
			this.loseNextPushResponse = false;
			throw new NetworkError('response lost');
		}
		return results;
	}

	private apply(m: Mutation): MutationResult {
		const { mutation_id, collection } = m;
		const table = this.tables.get(collection)!;
		if (this.denied.has(`${collection}/${m.op}`)) return { mutation_id, status: 'rejected', error: { code: 'FORBIDDEN', message: 'denied' } };

		if (m.op === 'create') {
			if (this.integerKeys.has(collection)) {
				const id = this.nextInt++;
				this.put(collection, { ...m.data, id }, ME);
				return { mutation_id, status: 'applied', server_key: id };
			}
			if (table.has(m.key)) return { mutation_id, status: 'rejected', error: { code: 'RECORD_NOT_UNIQUE', message: 'taken' } };
			this.put(collection, { ...m.data, id: m.key }, ME);
			return { mutation_id, status: 'applied' };
		}

		const entries = this.journal.filter((e) => e.collection === collection && e.key === m.key && e.id > (m.base_version ?? Infinity));
		if (entries.at(-1)?.op === 'd' || !table.has(m.key)) return { mutation_id, status: 'rejected', error: { code: 'DELETED', message: 'gone' } };
		const changed = new Set(entries.filter((e) => e.actor !== ME).flatMap((e) => e.fields ?? []));
		const values = (fields: string[]) => fields.map((field) => ({ field, server_value: table.get(m.key)![field] ?? null }));

		if (m.op === 'delete') {
			if (changed.size > 0) return { mutation_id, status: 'conflict', conflicts: values([...changed]) };
			this.remove(collection, m.key, ME);
			return { mutation_id, status: 'applied' };
		}

		const conflicting = Object.keys(m.patch!).filter((field) => changed.has(field));
		const rest = Object.fromEntries(Object.entries(m.patch!).filter(([field]) => !changed.has(field)));
		if (Object.keys(rest).length > 0) this.put(collection, { ...rest, id: table.get(m.key)!['id'] }, ME);
		return conflicting.length > 0 ? { mutation_id, status: 'conflict', conflicts: values(conflicting) } : { mutation_id, status: 'applied' };
	}
}
