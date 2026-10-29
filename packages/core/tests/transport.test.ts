import { describe, expect, it } from 'vitest';
import { CollectionInactiveError, ForbiddenError, GoneError, HttpError, NetworkError } from '../src/errors.js';
import { normalizeError, uploadOutcome } from '../src/transport/directus.js';
import type { Mutation } from '../src/types.js';

/** Shape of @directus/sdk's RequestError. */
const requestError = (status: number, errors: unknown) =>
	Object.assign(new Error('request failed'), { response: new Response(null, { status }), errors });

describe('normalizeError', () => {
	it('treats fetch failures as network errors on every platform', () => {
		expect(normalizeError(new TypeError('fetch failed'))).toBeInstanceOf(NetworkError); // browsers, Node
		expect(normalizeError(new Error('fetch failed: Could not connect to the server.'))).toBeInstanceOf(NetworkError); // Expo
	});

	it('maps dirlocal and Directus HTTP errors', () => {
		const gone = normalizeError(requestError(410, { error: 'gone', reason: 'permissions_changed' }));
		expect(gone).toBeInstanceOf(GoneError);
		expect((gone as GoneError).reason).toBe('permissions_changed');
		expect(normalizeError(requestError(403, [{ message: 'no', extensions: { code: 'FORBIDDEN' } }]))).toBeInstanceOf(ForbiddenError);
		expect(
			normalizeError(requestError(403, [{ message: 'inactive', extensions: { code: 'COLLECTION_INACTIVE' } }])),
		).toBeInstanceOf(CollectionInactiveError);
		const server = normalizeError(requestError(500, [{ message: 'boom' }]));
		expect(server).toBeInstanceOf(HttpError);
		expect((server as HttpError).status).toBe(500);
	});

	it('passes non-Error values through', () => {
		expect(normalizeError('weird')).toBe('weird');
	});
});

describe('uploadOutcome', () => {
	const upload: Mutation = { mutation_id: 'm1', collection: 'directus_files', op: 'upload', key: 'f1' };

	it('counts a duplicate id as applied: an earlier attempt went through', () => {
		expect(uploadOutcome(upload, new HttpError(400, 'taken', 'RECORD_NOT_UNIQUE'))).toEqual({ mutation_id: 'm1', status: 'applied' });
	});

	it('rejects what retrying will not fix', () => {
		expect(uploadOutcome(upload, new ForbiddenError('no'))).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
		expect(uploadOutcome(upload, new HttpError(413, 'too large'))).toMatchObject({ status: 'rejected', error: { code: 'HTTP_413' } });
	});

	it('rethrows what a retry may fix', () => {
		for (const error of [new NetworkError('down'), new HttpError(401, 'expired'), new HttpError(429, 'slow down'), new HttpError(503, 'busy')]) {
			expect(() => uploadOutcome(upload, error)).toThrow(error);
		}
	});
});
