import { beforeAll, describe, expect, it } from 'vitest';
import { api, login, pullAll, request } from './helpers';

let admin: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	worker = await login('worker');
});

/** Client-side snapshot: keys first, then data in batches. */
async function snapshot(token: string, collection: string, batch = 2) {
	const head = await request<{ cursor: number; keys: string[] }>('GET', `/dirlocal/snapshot?collection=${collection}`, token);
	expect(head.status).toBe(200);
	const rows: Record<string, any>[] = [];
	for (let i = 0; i < head.body.keys.length; i += batch) {
		const res = await request('POST', '/dirlocal/snapshot/items', token, { collection, keys: head.body.keys.slice(i, i + batch) });
		expect(res.status).toBe(200);
		rows.push(...res.body.data);
	}
	return { ...head.body, rows };
}

describe('snapshot', () => {
	it('returns every visible key with the cursor, and their data by key', async () => {
		const all = await api<{ id: string }[]>('GET', '/items/tasks?fields=id,title&limit=-1', admin);
		const { cursor, keys, rows } = await snapshot(worker, 'tasks');

		expect(typeof cursor).toBe('number');
		expect([...keys].sort()).toEqual(all.map((r) => r.id).sort());
		expect(rows.map((r) => r['id']).sort()).toEqual([...keys].sort());
		expect(rows[0]).toHaveProperty('title');
	});

	it('handles integer keys', async () => {
		const { keys, rows } = await snapshot(admin, 'notes');
		expect(rows.map((r) => String(r['id'])).sort()).toEqual([...keys].sort());
	});

	it('omits rows deleted between the key list and the data request; pull delivers the delete', async () => {
		const created = await api<{ id: string }[]>('POST', '/items/projects', admin, [{ name: 'snap-a' }, { name: 'snap-b' }]);
		const head = await request('GET', '/dirlocal/snapshot?collection=projects', admin);
		await api('DELETE', `/items/projects/${created[0]!.id}`, admin);

		const res = await request('POST', '/dirlocal/snapshot/items', admin, { collection: 'projects', keys: created.map((p) => p.id) });
		expect(res.body.data.map((r: { id: string }) => r.id)).toEqual([created[1]!.id]);

		const { changes } = await pullAll(admin, head.body.cursor, ['projects']);
		expect(changes.find((c) => c.key === created[0]!.id)).toMatchObject({ op: 'delete' });
	});

	it('continues with pull from its cursor without missing later changes', async () => {
		const { cursor } = await snapshot(admin, 'projects', 50);
		const project = await api('POST', '/items/projects', admin, { name: 'after-snapshot' });

		const { changes } = await pullAll(admin, cursor, ['projects']);
		expect(changes.map((c) => c.key)).toContain(project.id);
	});

	it('rejects unreadable, untracked and oversized requests', async () => {
		expect((await request('GET', '/dirlocal/snapshot?collection=invoices', worker)).status).toBe(403);
		expect((await request('GET', '/dirlocal/snapshot?collection=directus_users', admin)).status).toBe(400);
		expect((await request('GET', '/dirlocal/snapshot?collection=tasks')).status).toBe(401);
		expect((await request('POST', '/dirlocal/snapshot/items', admin, { collection: 'tasks', keys: [] })).status).toBe(400);
		const tooMany = Array.from({ length: 501 }, () => crypto.randomUUID());
		expect((await request('POST', '/dirlocal/snapshot/items', admin, { collection: 'tasks', keys: tooMany })).status).toBe(400);
	});
});
