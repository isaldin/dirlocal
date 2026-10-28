import { customEndpoint, type RequestOptions, type RestClient } from '@directus/sdk';
import { CollectionInactiveError, ForbiddenError, GoneError, HttpError, NetworkError } from '../errors.js';
import type { PullResponse, Row, SnapshotHead, Transport } from '../types.js';

/** Transport over an @directus/sdk client with rest() and authentication already configured. */
export function directusTransport(client: RestClient<any>): Transport {
	async function call<T>(options: RequestOptions): Promise<T> {
		try {
			return await client.request(customEndpoint<T>(options));
		} catch (error) {
			throw normalizeError(error);
		}
	}

	return {
		snapshotKeys: (collection) => call<SnapshotHead>({ path: '/dirlocal/snapshot', params: { collection } }),

		// The SDK unwraps `{ data }`, so this resolves to the row array.
		snapshotItems: (collection, keys) =>
			call<Row[]>({
				path: '/dirlocal/snapshot/items',
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ collection, keys }),
			}),

		pull: ({ cursor, collections, limit }) =>
			call<PullResponse>({ path: '/dirlocal/pull', params: { cursor, collections: collections.join(','), limit } }),
	};
}

/** Maps SDK RequestError / fetch failures to the engine's error classes. */
export function normalizeError(error: unknown): unknown {
	const response = (error as { response?: Response } | null)?.response;
	// SDK request errors always carry the HTTP response; without one the request never got an answer.
	// Platforms differ in what fetch throws: TypeError in browsers/Node, Error("fetch failed: …") in Expo.
	if (!response || typeof response.status !== 'number') {
		return error instanceof Error ? new NetworkError(error.message, { cause: error }) : error;
	}

	const errors = (error as { errors?: unknown }).errors;
	const first = Array.isArray(errors) ? (errors[0] as { message?: string; extensions?: { code?: string } } | undefined) : undefined;
	const code = first?.extensions?.code;

	if (response.status === 410) return new GoneError(String((errors as { reason?: unknown } | undefined)?.reason ?? 'unknown'));
	if (code === 'COLLECTION_INACTIVE') return new CollectionInactiveError(first?.message ?? 'collection inactive');
	if (response.status === 403 || code === 'FORBIDDEN') return new ForbiddenError(first?.message ?? 'forbidden');
	return new HttpError(response.status, first?.message ?? (error as Error).message ?? `HTTP ${response.status}`);
}
