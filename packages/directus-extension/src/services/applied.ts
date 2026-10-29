import { APPLIED_TABLE, ensureTables } from '../hooks/schema';
import type { Database } from '../types';

/** A claim younger than this is a concurrent request applying the same mutation; older means the server died mid-way. */
const IN_PROGRESS_MS = 60_000;

export type Claim<R> =
	| { state: 'new' }
	| { state: 'done'; result: R }
	| { state: 'foreign' }
	| { state: 'busy' }
	/** Claimed earlier without a result: the mutation may or may not have been applied. */
	| { state: 'recovering' };

/**
 * Claims a mutation id before applying it (plan §6, push step 1). The mutation itself runs through ItemsService
 * in its own transaction, so the claim is what makes a retry after a lost response idempotent.
 */
export async function claim<R>(database: Database, mutationId: string, userId: string): Promise<Claim<R>> {
	await ensureTables(database);
	const row = await database(APPLIED_TABLE).where({ mutation_id: mutationId }).first();

	if (!row) {
		try {
			await database(APPLIED_TABLE).insert({ mutation_id: mutationId, user_id: userId, result: null, created_at: new Date() });
			return { state: 'new' };
		} catch {
			// Unique violation: a concurrent request claimed it first.
			return { state: 'busy' };
		}
	}

	if (row.user_id !== userId) return { state: 'foreign' };
	if (row.result !== null) return { state: 'done', result: typeof row.result === 'string' ? JSON.parse(row.result) : row.result };
	if (Date.now() - new Date(row.created_at).getTime() < IN_PROGRESS_MS) return { state: 'busy' };

	await database(APPLIED_TABLE).where({ mutation_id: mutationId }).update({ created_at: new Date() });
	return { state: 'recovering' };
}

export async function complete(database: Database, mutationId: string, result: unknown): Promise<void> {
	await database(APPLIED_TABLE).where({ mutation_id: mutationId }).update({ result: JSON.stringify(result) });
}

/** Drops the claim so a retry applies the mutation from scratch. */
export async function release(database: Database, mutationId: string): Promise<void> {
	await database(APPLIED_TABLE).where({ mutation_id: mutationId }).whereNull('result').delete();
}

export async function compactApplied(database: Database, retentionDays: number): Promise<number> {
	await ensureTables(database);
	const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
	return database(APPLIED_TABLE).where('created_at', '<', cutoff).delete();
}
