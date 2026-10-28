// End-to-end: engine + directusTransport + memoryStorage against the dev Directus
// (`pnpm dev:up && pnpm dev:seed`, DIRLOCAL_SETTLE_MS=300).
import { authentication, createDirectus, createItem, deleteItem, readItems, rest, updateItem } from '@directus/sdk';
import { beforeAll, describe, expect, it } from 'vitest';
import { createOffline, type Offline } from '../src/engine.js';
import { memoryStorage } from '../src/storage/memory.js';
import type { OfflineEvents } from '../src/types.js';

const URL = process.env['DIRECTUS_URL'] ?? 'http://localhost:8055';
const settle = () => new Promise((resolve) => setTimeout(resolve, 500));

async function client(user: string) {
	const directus = createDirectus(URL).with(authentication('json')).with(rest());
	await directus.login({ email: `${user}@example.com`, password: user });
	return directus;
}

let admin: Awaited<ReturnType<typeof client>>;
let worker: Offline;
const unavailable: OfflineEvents['unavailable'][] = [];

beforeAll(async () => {
	admin = await client('admin');
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
});
