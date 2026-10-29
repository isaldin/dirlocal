import type { Accountability, PrimaryKey, SchemaOverview } from '@directus/types';
import type { ApiContext } from '../types';
import { claim, complete, release } from './applied';
import { entriesSince } from './journal';
import { toPrimaryKeys } from './visibility';

type Item = Record<string, unknown>;

export interface Mutation {
	mutation_id: string;
	collection: string;
	op: 'create' | 'update' | 'delete';
	key: string;
	data?: Item;
	patch?: Item;
	base_version?: number;
}

export interface MutationResult {
	mutation_id: string;
	status: 'applied' | 'conflict' | 'rejected';
	server_key?: PrimaryKey;
	conflicts?: { field: string; server_value: unknown }[];
	error?: { code: string; message: string };
}

/** Thrown when another request is applying the same mutation right now; push answers 409. */
export class MutationInProgressError extends Error {}

interface PushContext {
	services: ApiContext['services'];
	database: ApiContext['database'];
	schema: SchemaOverview;
	accountability: Accountability & { user: string };
}

/** Applies one mutation at most once per mutation_id (plan §6, push). */
export async function applyOnce(ctx: PushContext, mutation: Mutation): Promise<MutationResult> {
	const { database, accountability } = ctx;
	const claimed = await claim<MutationResult>(database, mutation.mutation_id, accountability.user);

	if (claimed.state === 'done') return claimed.result;
	if (claimed.state === 'busy') throw new MutationInProgressError(mutation.mutation_id);
	if (claimed.state === 'foreign') {
		return rejected(mutation, 'MUTATION_ID_TAKEN', 'mutation_id was used by another user');
	}

	let result: MutationResult;
	try {
		result = await apply(ctx, mutation, claimed.state === 'recovering');
	} catch (error) {
		const clientError = asClientError(error);
		if (!clientError) {
			await release(database, mutation.mutation_id);
			throw error;
		}
		result = rejected(mutation, clientError.code, clientError.message);
	}
	await complete(database, mutation.mutation_id, result);
	return result;
}

async function apply({ services, database, schema, accountability }: PushContext, mutation: Mutation, recovering: boolean) {
	const { mutation_id, collection } = mutation;
	const info = schema.collections[collection]!;
	const primary = info.primary;
	const items = new services.ItemsService(collection, { schema, accountability });
	const key = toPrimaryKeys(schema, collection, [mutation.key])[0]!;
	const exists = async () => (await items.readMany([key], { fields: [primary] })).length > 0;
	const serverValues = async (fields: string[]) => {
		const [row] = fields.length > 0 ? await items.readMany([key], { fields }).catch(() => []) : [];
		return fields.map((field) => ({ field, server_value: (row as Item | undefined)?.[field] ?? null }));
	};

	if (mutation.op === 'create') {
		const data = { ...mutation.data };
		const type = info.fields[primary]?.type;
		// ADR 0003: the client always sends a UUID; integer keys are assigned by the database instead.
		if ((type === 'integer' || type === 'bigInteger') && !/^-?\d+$/.test(mutation.key)) {
			delete data[primary];
			const serverKey = await items.createOne(data);
			return { mutation_id, status: 'applied', server_key: serverKey } satisfies MutationResult;
		}
		if (!(recovering && (await exists()))) await items.createOne({ ...data, [primary]: key });
		return { mutation_id, status: 'applied' } satisfies MutationResult;
	}

	const entries = mutation.base_version === undefined ? [] : await entriesSince(database, collection, mutation.key, mutation.base_version);
	if (entries.at(-1)?.op === 'd') return rejected(mutation, 'DELETED', 'the item was deleted on the server');
	// Same actor (another device of this user) is last-write-wins in v1 (ADR 0002).
	const changed = new Set(entries.filter((entry) => entry.actor !== accountability.user).flatMap((entry) => entry.fields ?? []));

	if (mutation.op === 'delete') {
		if (changed.size > 0) return { mutation_id, status: 'conflict', conflicts: await serverValues([...changed]) } satisfies MutationResult;
		if (!(recovering && !(await exists()))) await items.deleteOne(key);
		return { mutation_id, status: 'applied' } satisfies MutationResult;
	}

	const patch = { ...mutation.patch };
	const conflicting = Object.keys(patch).filter((field) => changed.has(field));
	for (const field of conflicting) delete patch[field];
	if (Object.keys(patch).length > 0) await items.updateOne(key, patch);
	if (conflicting.length === 0) return { mutation_id, status: 'applied' } satisfies MutationResult;
	return { mutation_id, status: 'conflict', conflicts: await serverValues(conflicting) } satisfies MutationResult;
}

/** Replaces client keys the server has re-keyed earlier in the batch, in `key` and top-level field values. */
export function resolveKeys(mutation: Mutation, serverKeys: Map<string, PrimaryKey>): Mutation {
	if (serverKeys.size === 0) return mutation;
	const map = (item: Item | undefined) =>
		item && Object.fromEntries(Object.entries(item).map(([field, value]) => [field, typeof value === 'string' ? (serverKeys.get(value) ?? value) : value]));
	const key = serverKeys.get(mutation.key);
	return {
		...mutation,
		key: key === undefined ? mutation.key : String(key),
		...(mutation.data && { data: map(mutation.data) }),
		...(mutation.patch && { patch: map(mutation.patch) }),
	};
}

function rejected(mutation: Mutation, code: string, message: string): MutationResult {
	return { mutation_id: mutation.mutation_id, status: 'rejected', error: { code, message } };
}

/** Directus errors carry `code` and an HTTP `status`; below 500 the request itself was at fault. */
function asClientError(error: unknown): { code: string; message: string } | null {
	const { status, code, message } = (error ?? {}) as { status?: unknown; code?: unknown; message?: unknown };
	if (typeof status !== 'number' || status >= 500 || typeof code !== 'string') return null;
	return { code, message: typeof message === 'string' ? message : code };
}
