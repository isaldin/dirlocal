import type { Accountability } from '@directus/types';

// Directus sets req.accountability in its auth middleware; its own augmentation is not published.
declare module 'express-serve-static-core' {
	interface Request {
		accountability?: Accountability;
	}
}
