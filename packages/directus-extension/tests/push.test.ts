import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, currentCursor, latestByKey, login, pullAll, request, settle, sql } from './helpers';

let admin: string;
let manager: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	manager = await login('manager');
	worker = await login('worker');
});

type Mutation = Record<string, unknown>;

async function push(token: string, ...mutations: Mutation[]) {
	const res = await request('POST', '/dirlocal/push', token, { mutations });
	if (res.status !== 200) throw new Error(`push → ${res.status}: ${JSON.stringify(res.body)}`);
	return res.body.results as Record<string, any>[];
}

const create = (collection: string, data: Record<string, unknown>, key = randomUUID()): Mutation => ({
	mutation_id: randomUUID(),
	collection,
	op: 'create',
	key,
	data,
});
const update = (collection: string, key: string, patch: Record<string, unknown>, base_version?: number): Mutation => ({
	mutation_id: randomUUID(),
	collection,
	op: 'update',
	key,
	patch,
	base_version,
});
const remove = (collection: string, key: string, base_version?: number): Mutation => ({
	mutation_id: randomUUID(),
	collection,
	op: 'delete',
	key,
	base_version,
});

/** A task the client has seen: the returned cursor is past its creation. */
async function seenTask(title: string) {
	const task = await api('POST', '/items/tasks', admin, { title });
	await settle();
	return { task, base: await currentCursor(admin) };
}

describe('push', () => {
	it('requires authentication and validates the batch', async () => {
		expect((await request('POST', '/dirlocal/push', undefined, { mutations: [create('tasks', {})] })).status).toBe(401);
		expect((await request('POST', '/dirlocal/push', worker, { mutations: [] })).status).toBe(400);
		expect((await request('POST', '/dirlocal/push', worker, { mutations: [create('directus_users', {})] })).status).toBe(400);
		expect((await request('POST', '/dirlocal/push', worker, { mutations: [{ ...create('tasks', {}), op: 'upsert' }] })).status).toBe(400);
		expect((await request('POST', '/dirlocal/push', worker, { mutations: [update('tasks', 'k', {}, -1)] })).status).toBe(400);
	});

	it('creates with the client UUID as the key and journals it for other users', async () => {
		const cursor = await currentCursor(admin);
		const mutation = create('tasks', { title: 'pushed task', status: 'in_progress' });

		const [result] = await push(manager, mutation);
		expect(result).toEqual({ mutation_id: mutation['mutation_id'], status: 'applied' });

		const task = await api('GET', `/items/tasks/${mutation['key']}`, admin);
		expect(task).toMatchObject({ title: 'pushed task', status: 'in_progress' });
		const latest = latestByKey((await pullAll(worker, cursor, ['tasks'])).changes);
		expect(latest.get(`tasks/${mutation['key']}`)).toMatchObject({ op: 'upsert', data: { title: 'pushed task' } });
	});

	it('is idempotent: a resent mutation returns the stored result without applying again', async () => {
		const body = `once ${randomUUID()}`;
		const note = create('notes', { body });
		const [first] = await push(worker, note);
		const [again] = await push(worker, note);

		expect(again).toEqual(first);
		const notes = await api<unknown[]>('GET', `/items/notes?filter[body][_eq]=${encodeURIComponent(body)}&fields=id`, admin);
		expect(notes).toHaveLength(1);
	});

	it('assigns integer keys on the server and resolves references to them later in the batch', async () => {
		const note = create('notes', { body: 'int key draft' });
		const edit = update('notes', note['key'] as string, { body: 'int key final' });

		const [created, edited] = await push(manager, note, edit);
		expect(created).toMatchObject({ status: 'applied', server_key: expect.any(Number) });
		expect(edited).toMatchObject({ status: 'applied' });
		expect(await api('GET', `/items/notes/${created!['server_key']}`, admin)).toMatchObject({ body: 'int key final' });
	});

	it('server wins on overlapping fields and applies the rest (ADR 0002)', async () => {
		const { task, base } = await seenTask('conflict original');
		await api('PATCH', `/items/tasks/${task.id}`, manager, { title: 'manager title' });
		await settle();

		const [result] = await push(worker, update('tasks', task.id, { title: 'worker title', status: 'done' }, base));

		expect(result).toMatchObject({ status: 'conflict', conflicts: [{ field: 'title', server_value: 'manager title' }] });
		expect(await api('GET', `/items/tasks/${task.id}`, admin)).toMatchObject({ title: 'manager title', status: 'done' });
	});

	it('applies edits of different fields from two users without loss', async () => {
		const { task, base } = await seenTask('two devices');
		await api('PATCH', `/items/tasks/${task.id}`, manager, { title: 'renamed by manager' });
		await settle();

		const [result] = await push(worker, update('tasks', task.id, { status: 'in_progress' }, base));

		expect(result).toMatchObject({ status: 'applied' });
		expect(await api('GET', `/items/tasks/${task.id}`, admin)).toMatchObject({ title: 'renamed by manager', status: 'in_progress' });
	});

	it("does not treat the user's own earlier edits as a conflict", async () => {
		const { task, base } = await seenTask('same user');
		await api('PATCH', `/items/tasks/${task.id}`, worker, { status: 'in_progress' });
		await settle();

		const [result] = await push(worker, update('tasks', task.id, { status: 'done' }, base));
		expect(result).toMatchObject({ status: 'applied' });
	});

	it('does not delete an item someone else changed since base_version', async () => {
		const { task, base } = await seenTask('delete conflict');
		await api('PATCH', `/items/tasks/${task.id}`, admin, { status: 'done' });
		await settle();

		const [result] = await push(manager, remove('tasks', task.id, base));

		expect(result).toMatchObject({ status: 'conflict', conflicts: [{ field: 'status', server_value: 'done' }] });
		expect(await api('GET', `/items/tasks/${task.id}`, admin)).toMatchObject({ id: task.id });
	});

	it('rejects an update of an item deleted on the server', async () => {
		const { task, base } = await seenTask('deleted meanwhile');
		await api('DELETE', `/items/tasks/${task.id}`, admin);
		await settle();

		const [result] = await push(worker, update('tasks', task.id, { status: 'done' }, base));
		expect(result).toMatchObject({ status: 'rejected', error: { code: 'DELETED' } });
	});

	it('rejects what Directus rejects, per mutation, and keeps going', async () => {
		const { task } = await seenTask('worker cannot delete');
		const results = await push(
			worker,
			remove('tasks', task.id), // Worker has no delete permission on tasks
			create('notes', { body: 'still applied' }),
			create('tasks', { title: 'worker cannot create' }),
		);

		expect(results.map((r) => r['status'])).toEqual(['rejected', 'applied', 'rejected']);
		expect(results[0]).toMatchObject({ error: { code: 'FORBIDDEN' } });
		expect(await api('GET', `/items/tasks/${task.id}`, admin)).toMatchObject({ id: task.id });
	});

	it('rejects a create whose key is taken', async () => {
		const { task } = await seenTask('taken key');
		const [result] = await push(manager, create('tasks', { title: 'duplicate' }, task.id));
		expect(result).toMatchObject({ status: 'rejected', error: { code: 'RECORD_NOT_UNIQUE' } });
	});

	it("does not reveal or replay another user's mutation", async () => {
		const mutation = create('notes', { body: 'manager note' });
		await push(manager, mutation);

		const [result] = await push(worker, mutation);
		expect(result).toMatchObject({ status: 'rejected', error: { code: 'MUTATION_ID_TAKEN' } });
	});

	it('answers 409 while the same mutation is being applied by another request', async () => {
		const mutation = create('notes', { body: 'in flight' });
		const workerId = (await api('GET', '/users/me?fields=id', worker)).id;
		sql(`insert into dirlocal_applied values ('${mutation['mutation_id']}', '${workerId}', null, now())`);

		const res = await request('POST', '/dirlocal/push', worker, { mutations: [mutation] });
		expect(res.status).toBe(409);
		expect(res.body.reason).toBe('mutation_in_progress');
	});

	it('recovers a mutation left claimed by a crashed server without applying it twice', async () => {
		const mutation = create('tasks', { title: 'applied before the crash' });
		await push(manager, mutation);
		// The state after a crash between commit and storing the result: claimed long ago, no result.
		sql(`update dirlocal_applied set result = null, created_at = now() - interval '2 minutes' where mutation_id = '${mutation['mutation_id']}'`);

		const [result] = await push(manager, mutation);
		expect(result).toMatchObject({ status: 'applied' });
	});

	it('compaction removes old push results', async () => {
		await push(worker, create('notes', { body: 'compacted result' }));
		const res = await request('POST', '/dirlocal/compact?retention_days=0', admin);
		expect(res.status).toBe(200);
		expect(res.body.applied).toBeGreaterThanOrEqual(1);
	});
});
