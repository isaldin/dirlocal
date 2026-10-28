import { beforeAll, describe, expect, it } from 'vitest';
import { api, currentCursor, latestByKey, login, pullAll, request, settle } from './helpers';

let admin: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	worker = await login('worker');
});

describe('compact', () => {
	it('is admin only', async () => {
		expect((await request('POST', '/dirlocal/compact', worker)).status).toBe(403);
		expect((await request('POST', '/dirlocal/compact')).status).toBe(401);
	});

	it('keeps the latest entry per key, so an old cursor still converges', async () => {
		const cursor = await currentCursor(admin);
		const project = await api('POST', '/items/projects', admin, { name: 'compact-v1' });
		await api('PATCH', `/items/projects/${project.id}`, admin, { name: 'compact-v2' });
		await api('PATCH', `/items/projects/${project.id}`, admin, { name: 'compact-v3' });
		const doomed = await api('POST', '/items/projects', admin, { name: 'compact-tombstone' });
		await api('DELETE', `/items/projects/${doomed.id}`, admin);
		await settle();

		const res = await request('POST', '/dirlocal/compact?retention_days=0', admin);
		expect(res.status).toBe(200);
		expect(res.body.deleted).toBeGreaterThanOrEqual(3);

		const { changes } = await pullAll(admin, cursor, ['projects']);
		const latest = latestByKey(changes);
		expect(changes.filter((c) => c.key === project.id)).toHaveLength(1);
		expect(latest.get(`projects/${project.id}`)).toMatchObject({ op: 'upsert', data: { name: 'compact-v3' } });
		expect(latest.get(`projects/${doomed.id}`)).toMatchObject({ op: 'delete' });
	});
});
