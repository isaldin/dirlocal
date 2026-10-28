import { beforeAll, describe, expect, it } from 'vitest';
import { api, currentCursor, latestByKey, login, pullAll, request, settle } from './helpers';

let admin: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	worker = await login('worker');
});

describe('pull', () => {
	it('requires authentication', async () => {
		expect((await request('GET', '/dirlocal/pull?cursor=0')).status).toBe(401);
	});

	it('rejects untracked collections and bad parameters', async () => {
		expect((await request('GET', '/dirlocal/pull?cursor=0&collections=directus_users', admin)).status).toBe(400);
		expect((await request('GET', '/dirlocal/pull?cursor=-1', admin)).status).toBe(400);
		expect((await request('GET', '/dirlocal/pull?cursor=0&limit=0', admin)).status).toBe(400);
	});

	it('delivers create, update and delete as upsert/delete with current data', async () => {
		const cursor = await currentCursor(admin);
		const project = await api('POST', '/items/projects', admin, { name: 'pull-crud' });
		const doomed = await api('POST', '/items/projects', admin, { name: 'pull-crud-doomed' });
		await api('PATCH', `/items/projects/${project.id}`, admin, { name: 'pull-crud renamed' });
		await api('DELETE', `/items/projects/${doomed.id}`, admin);

		const { changes } = await pullAll(admin, cursor, ['projects']);
		const latest = latestByKey(changes);

		expect(latest.get(`projects/${project.id}`)).toMatchObject({ op: 'upsert', data: { id: project.id, name: 'pull-crud renamed' } });
		expect(latest.get(`projects/${doomed.id}`)).toMatchObject({ op: 'delete' });
		expect(latest.get(`projects/${doomed.id}`)!.data).toBeUndefined();
		// Collapsed: one change per key.
		expect(changes.filter((c) => c.key === project.id)).toHaveLength(1);
	});

	it('journals every key of a bulk update', async () => {
		const cursor = await currentCursor(admin);
		const created = await api<{ id: string }[]>('POST', '/items/projects', admin, [{ name: 'bulk-a' }, { name: 'bulk-b' }]);
		const keys = created.map((p) => p.id);
		await api('PATCH', '/items/projects', admin, { keys, data: { name: 'bulk-renamed' } });

		const latest = latestByKey((await pullAll(admin, cursor, ['projects'])).changes);
		for (const key of keys) expect(latest.get(`projects/${key}`)).toMatchObject({ op: 'upsert', data: { name: 'bulk-renamed' } });
	});

	it('holds back entries younger than the settle window', async () => {
		const cursor = await currentCursor(admin);
		const project = await api('POST', '/items/projects', admin, { name: 'pull-settle' });

		const immediate = await request('GET', `/dirlocal/pull?cursor=${cursor}&collections=projects`, admin);
		expect(immediate.body.changes.map((c: { key: string }) => c.key)).not.toContain(project.id);

		const { changes } = await pullAll(admin, cursor, ['projects']);
		expect(changes.map((c) => c.key)).toContain(project.id);
	});

	it('pages with limit and has_more, ending at the same state', async () => {
		const cursor = await currentCursor(admin);
		const created = await api<{ id: string }[]>('POST', '/items/projects', admin, [{ name: 'page-1' }, { name: 'page-2' }, { name: 'page-3' }]);

		const paged = await pullAll(admin, cursor, ['projects'], 1);
		expect(paged.pages).toBeGreaterThanOrEqual(3);
		const keys = paged.changes.map((c) => c.key);
		for (const { id } of created) expect(keys).toContain(id);
		expect(paged.changes.map((c) => c.version)).toEqual([...paged.changes.map((c) => c.version)].sort((a, b) => a - b));
	});

	it('sends rows the caller may not read as delete (Core tier: whole collection)', async () => {
		const cursor = await currentCursor(admin);
		const invoice = await api('POST', '/items/invoices', admin, { amount: 100 });

		const asAdmin = latestByKey((await pullAll(admin, cursor, ['invoices'])).changes);
		const asWorker = latestByKey((await pullAll(worker, cursor, ['invoices'])).changes);

		expect(asAdmin.get(`invoices/${invoice.id}`)).toMatchObject({ op: 'upsert' });
		expect(asWorker.get(`invoices/${invoice.id}`)).toMatchObject({ op: 'delete' });
		expect(asWorker.get(`invoices/${invoice.id}`)!.data).toBeUndefined();
	});

	it('handles integer primary keys', async () => {
		const cursor = await currentCursor(admin);
		const task = await api('POST', '/items/tasks', admin, { title: 'int-key task' });
		const note = await api('POST', '/items/notes', admin, { task: task.id, body: 'int key' });

		const latest = latestByKey((await pullAll(worker, cursor, ['notes'])).changes);
		expect(latest.get(`notes/${note.id}`)).toMatchObject({ op: 'upsert', key: String(note.id), data: { id: note.id, body: 'int key' } });
	});

	it('journals rows removed by ON DELETE CASCADE and rewritten by SET NULL', async () => {
		const cursor = await currentCursor(admin);
		const project = await api('POST', '/items/projects', admin, { name: 'cascade-parent' });
		const task = await api('POST', '/items/tasks', admin, { title: 'cascade task', project: project.id });
		const note = await api('POST', '/items/notes', admin, { task: task.id, body: 'cascade note' });
		const invoice = await api('POST', '/items/invoices', admin, { amount: 5, project: project.id });

		await api('DELETE', `/items/tasks/${task.id}`, admin); // notes.task → CASCADE
		await api('DELETE', `/items/projects/${project.id}`, admin); // invoices.project → SET NULL

		const latest = latestByKey((await pullAll(admin, cursor, ['tasks', 'notes', 'invoices'])).changes);
		expect(latest.get(`notes/${note.id}`)).toMatchObject({ op: 'delete' });
		expect(latest.get(`invoices/${invoice.id}`)).toMatchObject({ op: 'upsert', data: { project: null } });
	});

	it('does not journal mutations Directus rejected', async () => {
		const task = await api('POST', '/items/tasks', admin, { title: 'worker cannot delete' });
		await settle(); // the settled cursor lags; let it pass the create
		const cursor = await currentCursor(admin);
		expect((await request('DELETE', `/items/tasks/${task.id}`, worker)).status).toBe(403);

		const { changes } = await pullAll(admin, cursor, ['tasks']);
		expect(changes.map((c) => c.key)).not.toContain(task.id);
	});

	it('answers 410 cursor_ahead for a cursor beyond the journal', async () => {
		const res = await request('GET', '/dirlocal/pull?cursor=999999999999', admin);
		expect(res.status).toBe(410);
		expect(res.body.reason).toBe('cursor_ahead');
	});
});
