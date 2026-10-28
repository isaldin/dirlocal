/** 410 from pull: the cursor is no longer valid (`permissions_changed`, `cursor_ahead`). */
export class GoneError extends Error {
	override name = 'GoneError';
	constructor(readonly reason: string) {
		super(`cursor invalidated: ${reason}`);
	}
}

export class CollectionInactiveError extends Error {
	override name = 'CollectionInactiveError';
}

export class ForbiddenError extends Error {
	override name = 'ForbiddenError';
}

/** The request never reached the server. */
export class NetworkError extends Error {
	override name = 'NetworkError';
}

export class HttpError extends Error {
	override name = 'HttpError';
	constructor(
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}
