// End-to-end: engine + directusTransport + memoryStorage against the dev Directus
// (`pnpm dev:up && pnpm dev:seed`, DIRLOCAL_SETTLE_MS=300).
import { authentication, createDirectus, createItem, deleteItem, readFile, readItem, readItems, rest, updateItem } from '@directus/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOffline, type Offline } from '../src/engine.js';
import { memoryStorage } from '../src/storage/memory.js';
import { directusTransport } from '../src/transport/directus.js';
import type { OfflineEvents } from '../src/types.js';

const URL = process.env['DIRECTUS_URL'] ?? 'http://localhost:8055';
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

async function client(user: string) {
	const directus = createDirectus(URL).with(authentication('json')).with(rest());
	await directus.login({ email: `${user}@example.com`, password: user });
	return directus;
}

let admin: Awaited<ReturnType<typeof client>>;
let manager: Awaited<ReturnType<typeof client>>;
let worker: Offline;
const unavailable: OfflineEvents['unavailable'][] = [];

beforeAll(async () => {
	admin = await client('admin');
	manager = await client('manager');
	worker = createOffline({
		directus: await client('worker'),
		storage: memoryStorage(),
		collections: ['projects', 'tasks', 'notes', 'invoices'],
	});
	worker.on('unavailable', (event) => unavailable.push(event));
	await worker.sync();
});

describe('engine against Directus', () => {
	it('snapshots what the worker can read', async () => {
		const serverTasks = await admin.request(readItems('tasks', { fields: ['id'], limit: -1 }));
		expect((await worker.query('tasks')).map((t) => t['id']).sort()).toEqual(serverTasks.map((t) => t['id']).sort());
		expect((await worker.query('notes')).length).toBeGreaterThan(0);
		expect(worker.getStatus()).toBe('idle');
	});

	it('reports the Manager-only collection as unavailable instead of failing', () => {
		expect(unavailable).toContainEqual({ collection: 'invoices', reason: 'forbidden' });
	});

	it('picks up creates, updates and deletes made in Directus', async () => {
		const created = await admin.request(createItem('tasks', { title: 'from admin' }));
		const project = await admin.request(createItem('projects', { name: 'to delete' }));
		await settle();
		await worker.sync();
		expect(await worker.query('tasks', { where: { id: created['id'] } })).toHaveLength(1);

		await admin.request(updateItem('tasks', created['id'], { title: 'renamed by admin' }));
		await admin.request(deleteItem('projects', project['id']));
		await settle();
		await worker.sync();

		expect(await worker.query('tasks', { where: { id: created['id'] } })).toMatchObject([{ title: 'renamed by admin' }]);
		expect(await worker.query('projects', { where: { id: project['id'] } })).toEqual([]);
	});

	it('removes cascaded notes locally', async () => {
		const task = await admin.request(createItem('tasks', { title: 'with note' }));
		const note = await admin.request(createItem('notes', { task: task['id'], body: 'goes with the task' }));
		await settle();
		await worker.sync();
		expect(await worker.query('notes', { where: { id: note['id'] } })).toHaveLength(1);

		await admin.request(deleteItem('tasks', task['id']));
		await settle();
		await worker.sync();
		expect(await worker.query('notes', { where: { id: note['id'] } })).toEqual([]);
	});

	it('pushes an edit of one field without losing another user\'s edit of another field', async () => {
		const task = await admin.request(createItem('tasks', { title: 'two devices', status: 'todo' }));
		await settle();
		await worker.sync();

		// Worker edits offline (not synced yet); manager renames the task meanwhile.
		await worker.mutate('tasks', { op: 'update', key: task['id'], patch: { status: 'done' } });
		await manager.request(updateItem('tasks', task['id'], { title: 'renamed by manager' }));
		await settle();
		await worker.sync();

		expect(await admin.request(readItem('tasks', task['id']))).toMatchObject({ title: 'renamed by manager', status: 'done' });
		expect(await worker.get('tasks', task['id'])).toMatchObject({ title: 'renamed by manager', status: 'done' });
		expect(await worker.pending()).toEqual([]);
	});

	it('creates a note offline and re-keys it to the integer key Directus assigns', async () => {
		const [task] = await worker.query('tasks', { limit: 1 });
		const body = `written offline ${Date.now()}`;
		const key = await worker.mutate('notes', { op: 'create', data: { task: task!['id'], body } });
		await worker.sync();

		const [local] = await worker.query('notes', { where: { body } });
		expect(local!['id']).toEqual(expect.any(Number));
		expect(await worker.get('notes', key)).toBeNull();
		expect(await admin.request(readItem('notes', local!['id'] as number))).toMatchObject({ body, task: task!['id'] });
	});

	it('reports a write Directus refuses and restores the row', async () => {
		const rejected: OfflineEvents['rejected'][] = [];
		const off = worker.on('rejected', (event) => rejected.push(event));
		const [task] = await worker.query('tasks', { limit: 1 });

		await worker.mutate('tasks', { op: 'delete', key: task!['id'] as string }); // Worker can't delete tasks
		expect(await worker.get('tasks', task!['id'] as string)).toBeNull();
		await worker.sync();
		off();

		expect(rejected.map((r) => r.error.code)).toEqual(['FORBIDDEN']);
		expect(await worker.get('tasks', task!['id'] as string)).toMatchObject({ id: task!['id'] });
	});

	it('uploads a photo and creates the task that references it, in that order', async () => {
		// Node's FormData needs a Blob; React Native's default part is { uri, name, type }.
		const transport = directusTransport(await client('worker'), { filePart: (file) => new Blob(['not really a jpeg'], { type: file.type }) });
		const device = createOffline({ transport, storage: memoryStorage(), collections: ['tasks'] });
		await device.sync();

		const photo = await device.uploadFile({ uri: 'file:///photo.jpg', name: 'photo.jpg', type: 'image/jpeg' });
		const task = await device.mutate('tasks', { op: 'create', data: { title: 'task with photo', photo } });
		await device.sync();

		expect(await device.pending()).toEqual([]);
		expect(await admin.request(readItem('tasks', task))).toMatchObject({ title: 'task with photo', photo });
		expect(await admin.request(readFile(photo))).toMatchObject({ filename_download: 'photo.jpg', type: 'image/jpeg' });
	});
});
