import { customEndpoint, type RequestOptions, type RestClient, uploadFiles } from '@directus/sdk';
import { CollectionInactiveError, ForbiddenError, GoneError, HttpError, NetworkError } from '../errors.js';
import type { FileUpload, Mutation, MutationResult, PullResponse, Row, SnapshotHead, Transport } from '../types.js';

export interface DirectusTransportOptions {
	/**
	 * The FormData value for a file. Default: React Native's `{ uri, name, type }` object, which React Native's own
	 * fetch understands. Expo's fetch needs a Blob-like part (`@dirlocal/expo` passes an expo-file-system File);
	 * on the web, return a Blob.
	 */
	filePart?: (file: FileUpload) => Blob | Promise<Blob> | object;
}

/** Transport over an @directus/sdk client with rest() and authentication already configured. */
export function directusTransport(client: RestClient<any>, options: DirectusTransportOptions = {}): Transport {
	const filePart = options.filePart ?? ((file: FileUpload) => ({ uri: file.uri, name: file.name, type: file.type }));

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

		push: async (mutations) =>
			(
				await call<{ results: MutationResult[] }>({
					path: '/dirlocal/push',
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ mutations }),
				})
			).results,

		async upload(mutation) {
			const form = new FormData();
			// Fields before the file become the item payload; a client id makes a retried upload detectable.
			form.append('id', mutation.key);
			for (const [field, value] of Object.entries(mutation.data ?? {})) {
				if (field !== 'id' && value != null) form.append(field, typeof value === 'string' ? value : JSON.stringify(value));
			}
			form.append('file', (await filePart(mutation.file!)) as Blob, mutation.file!.name);
			try {
				await client.request(uploadFiles(form));
				return { mutation_id: mutation.mutation_id, status: 'applied' };
			} catch (error) {
				return uploadOutcome(mutation, normalizeError(error));
			}
		},
	};
}

/** Maps a failed upload to a result, or rethrows when a retry may succeed (network, auth, server errors). */
export function uploadOutcome(mutation: Mutation, error: unknown): MutationResult {
	const { mutation_id } = mutation;
	// The id is the client's UUID: a duplicate means an earlier attempt went through and its response was lost.
	if (error instanceof HttpError && error.code === 'RECORD_NOT_UNIQUE') return { mutation_id, status: 'applied' };
	if (error instanceof ForbiddenError) return { mutation_id, status: 'rejected', error: { code: 'FORBIDDEN', message: error.message } };
	if (error instanceof HttpError && error.status >= 400 && error.status < 500 && ![401, 408, 409, 429].includes(error.status)) {
		return { mutation_id, status: 'rejected', error: { code: error.code ?? `HTTP_${error.status}`, message: error.message } };
	}
	throw error;
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
	return new HttpError(response.status, first?.message ?? (error as Error).message ?? `HTTP ${response.status}`, code);
}
