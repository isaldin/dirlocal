import type { Mutation, Row } from './types.js';

export const itemId = (collection: string, key: string) => `${collection}\u0000${key}`;

/** Unsent mutations grouped by item, in outbox order. */
export function groupByItem(outbox: Mutation[]): Map<string, Mutation[]> {
	const groups = new Map<string, Mutation[]>();
	for (const mutation of outbox) {
		const id = itemId(mutation.collection, mutation.key);
		groups.set(id, [...(groups.get(id) ?? []), mutation]);
	}
	return groups;
}

/** The row the UI should see: the server's version (null = none) with unsent mutations replayed on top. */
export function overlay(row: Row | null, pending: Mutation[]): Row | null {
	let current = row;
	for (const mutation of pending) {
		if (mutation.op === 'create' || mutation.op === 'upload') current = { ...current, ...mutation.data };
		else if (mutation.op === 'update') current = current && { ...current, ...mutation.patch };
		else current = null;
	}
	return current;
}

/** Replaces `from` in top-level values; null when nothing matched. */
export function replaceValue(item: Row, from: string, to: unknown): Row | null {
	let changed = false;
	const result: Row = {};
	for (const [field, value] of Object.entries(item)) {
		if (value === from) changed = true;
		result[field] = value === from ? to : value;
	}
	return changed ? result : null;
}

/** Rewrites a client key the server replaced (ADR 0003) in an unsent mutation; the same object when nothing matched. */
export function rekeyMutation(mutation: Mutation, collection: string, from: string, to: string | number): Mutation {
	const sameItem = mutation.collection === collection && mutation.key === from;
	const data = mutation.data && replaceValue(mutation.data, from, to);
	const patch = mutation.patch && replaceValue(mutation.patch, from, to);
	if (!sameItem && !data && !patch) return mutation;
	return { ...mutation, ...(sameItem && { key: String(to) }), ...(data && { data }), ...(patch && { patch }) };
}

/** UUID v4. Hermes (React Native) has no crypto.randomUUID; adapters can pass a native generator instead. */
export function uuid(): string {
	const crypto = (globalThis as { crypto?: Partial<Crypto> }).crypto;
	if (crypto?.randomUUID) return crypto.randomUUID();

	const bytes = new Uint8Array(16);
	if (crypto?.getRandomValues) crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6]! & 0x0f) | 0x40;
	bytes[8] = (bytes[8]! & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Serializes async sections that read the outbox and then write rows, so a mutation can't slip in between. */
export function createLock() {
	let tail: Promise<unknown> = Promise.resolve();
	return <T>(fn: () => Promise<T>): Promise<T> => {
		const run = tail.then(fn, fn);
		tail = run.catch(() => undefined);
		return run;
	};
}
