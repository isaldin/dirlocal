import { describe, expect, it } from 'vitest';
import { CollectionInactiveError, ForbiddenError, GoneError, HttpError, NetworkError } from '../src/errors.js';
import { normalizeError } from '../src/transport/directus.js';

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
