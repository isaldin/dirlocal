import { describe, expect, it } from 'vitest';
import { FakeServer } from './fake-server.js';
import { setup } from './setup.js';

const photo = { uri: 'file:///docs/dirlocal-uploads/p.jpg', name: 'p.jpg', type: 'image/jpeg' };

async function offlineAfterSnapshot(collections = ['tasks', 'projects']) {
	const server = new FakeServer(['tasks', 'projects', 'directus_files']);
	const ctx = setup({ server, collections });
	server.put('tasks', { id: 't1', title: 'existing' });
	await ctx.offline.sync();
	server.offline = true;
	return ctx;
}

describe('uploadFile', () => {
	it('uploads the file before the item that references it, in outbox order', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		const fileId = await offline.uploadFile(photo);
		const task = await offline.mutate('tasks', { op: 'create', data: { title: 'With photo', photo: fileId } });
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { title: 'edited' } });

		server.offline = false;
		await offline.sync();

		expect(server.files.get(fileId)).toBe(photo.uri);
		const order = server.journal.filter((e) => e.actor === 'me').map((e) => `${e.collection}/${e.key}`);
		expect(order).toEqual([`directus_files/${fileId}`, `tasks/${task}`, 'tasks/t1']);
		expect(server.calls.upload).toBe(1);
		expect(server.calls.push).toBe(1); // both item mutations in one batch after the upload
		expect(await offline.pending()).toEqual([]);
	});

	it('does not upload twice when the response is lost', async () => {
		const { server, offline } = await offlineAfterSnapshot();
		const fileId = await offline.uploadFile(photo);
		server.offline = false;
		server.loseNextPushResponse = true;

		await expect(offline.sync()).rejects.toThrow('response lost');
		await offline.sync();

		expect(server.journal.filter((e) => e.key === fileId)).toHaveLength(1);
		expect(await offline.pending()).toEqual([]);
	});

	it('reports a refused upload and goes on with the rest', async () => {
		const { server, offline, seen } = await offlineAfterSnapshot();
		server.denied.add('directus_files/upload');
		await offline.uploadFile(photo);
		await offline.mutate('tasks', { op: 'update', key: 't1', patch: { title: 'still sent' } });

		server.offline = false;
		await offline.sync();

		expect(seen.rejected.map((r) => [r.mutation.op, r.error.code])).toEqual([['upload', 'FORBIDDEN']]);
		expect(server.tables.get('tasks')!.get('t1')).toMatchObject({ title: 'still sent' });
	});

	it('shows the file row locally when directus_files is synced', async () => {
		const { offline } = await offlineAfterSnapshot(['tasks', 'directus_files']);
		const fileId = await offline.uploadFile({ ...photo, data: { title: 'Site' } });

		expect(await offline.get('directus_files', fileId)).toEqual({ id: fileId, title: 'Site', filename_download: 'p.jpg', type: 'image/jpeg' });
	});
});
