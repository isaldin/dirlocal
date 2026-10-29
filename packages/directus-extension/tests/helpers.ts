// Integration helpers against the dev Directus from examples/directus (`pnpm dev:up && pnpm dev:seed`).
import { execFileSync } from 'node:child_process';

export const URL = process.env['DIRECTUS_URL'] ?? 'http://localhost:8055';
/** Must match DIRLOCAL_SETTLE_MS in examples/directus/docker-compose.yml. */
export const SETTLE_MS = 300;

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const settle = () => sleep(SETTLE_MS + 200);

export interface Response<T = any> {
	status: number;
	body: T;
}

export async function request<T = any>(method: string, path: string, token?: string, body?: unknown): Promise<Response<T>> {
	const res = await fetch(`${URL}${path}`, {
		method,
		headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const text = await res.text();
	return { status: res.status, body: text ? JSON.parse(text) : undefined };
}

/** Directus REST call that must succeed; returns `data`. */
export async function api<T = any>(method: string, path: string, token: string, body?: unknown): Promise<T> {
	const res = await request(method, path, token, body);
	if (res.status >= 300) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body?.data as T;
}

const tokens = new Map<string, string>();

/** Seed users; password is the part of the email before @. */
export async function login(user: 'admin' | 'manager' | 'worker' | 'worker2'): Promise<string> {
	const cached = tokens.get(user);
	if (cached) return cached;
	const res = await request('POST', '/auth/login', undefined, { email: `${user}@example.com`, password: user });
	if (res.status !== 200) throw new Error(`login ${user} failed: ${JSON.stringify(res.body)}. Did you run pnpm dev:seed?`);
	tokens.set(user, res.body.data.access_token);
	return res.body.data.access_token;
}

export interface Change {
	collection: string;
	key: string;
	op: 'upsert' | 'delete';
	version: number;
	data?: Record<string, any>;
}

/** Settled journal cursor (lags by the settle window), via snapshot. */
export async function currentCursor(token: string): Promise<number> {
	const res = await request('GET', '/dirlocal/snapshot?collection=projects', token);
	if (res.status !== 200) throw new Error(`snapshot → ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body.cursor;
}

/** Waits out the settle window, then pulls until has_more is false. Returns all changes and the final cursor. */
export async function pullAll(token: string, cursor: number, collections?: string[], limit?: number) {
	await settle();
	const changes: Change[] = [];
	let pages = 0;
	for (;;) {
		const params = new URLSearchParams({ cursor: String(cursor) });
		if (collections) params.set('collections', collections.join(','));
		if (limit) params.set('limit', String(limit));
		const res = await request('GET', `/dirlocal/pull?${params}`, token);
		if (res.status !== 200) throw new Error(`pull → ${res.status}: ${JSON.stringify(res.body)}`);
		changes.push(...res.body.changes);
		cursor = res.body.next_cursor;
		pages++;
		if (!res.body.has_more) return { changes, cursor, pages, inactive: res.body.inactive as string[] };
	}
}

/** Last change per key, as a client would apply them. */
export function latestByKey(changes: Change[]): Map<string, Change> {
	return new Map(changes.map((change) => [`${change.collection}/${change.key}`, change]));
}

/** Runs SQL in the dev Postgres container: for states the API can't produce (e.g. a claim left by a crashed server). */
export function sql(statement: string): string {
	const compose = new globalThis.URL('../../../examples/directus/docker-compose.yml', import.meta.url).pathname;
	return execFileSync('docker', ['compose', '-f', compose, 'exec', '-T', 'postgres', 'psql', '-U', 'directus', '-tAc', statement], {
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	}).trim();
}
