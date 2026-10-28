import { beforeAll, describe, expect, it } from 'vitest';
import { api, currentCursor, login, pullAll, request, settle } from './helpers';

let admin: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	worker = await login('worker');
});

describe('permission changes', () => {
	it('answer 410 permissions_changed for cursors from before the change, and recover after re-snapshot', async () => {
		const before = await currentCursor(worker);

		// Re-saving an existing permission unchanged is enough: rows may have become visible without being journaled.
		const [permission] = await api<{ id: number; fields: string[] }[]>(
			'GET',
			'/permissions?filter[collection][_eq]=notes&filter[action][_eq]=read&limit=1',
			admin,
		);
		await api('PATCH', `/permissions/${permission!.id}`, admin, { fields: permission!.fields });

		const res = await request('GET', `/dirlocal/pull?cursor=${before}`, worker);
		expect(res.status).toBe(410);
		expect(res.body.reason).toBe('permissions_changed');

		await settle();
		const after = await currentCursor(worker);
		await expect(pullAll(worker, after)).resolves.toBeDefined();
	});

	it('ignores user updates that do not touch access', async () => {
		const cursor = await currentCursor(admin);
		const me = await api<{ id: string }>('GET', '/users/me?fields=id', worker);
		await api('PATCH', `/users/${me.id}`, admin, { first_name: 'Worker', last_page: '/content' });

		await expect(pullAll(admin, cursor)).resolves.toBeDefined();
	});
});
