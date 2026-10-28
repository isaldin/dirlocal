import type { Accountability } from '@directus/types';
import type { Request, Response } from 'express';

/** Returns the caller's accountability, or answers 401 and returns null. */
export function requireUser(req: Request, res: Response): Accountability | null {
	const accountability = req.accountability;
	if (accountability?.user) return accountability;
	res.status(401).json({ error: 'unauthorized' });
	return null;
}

export function badRequest(res: Response, message: string): void {
	res.status(400).json({ error: 'bad_request', message });
}

export function intParam(value: unknown, fallback: number): number | null {
	if (value === undefined || value === '') return fallback;
	const n = Number(value);
	return Number.isSafeInteger(n) && n >= 0 ? n : null;
}
