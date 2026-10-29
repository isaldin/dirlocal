import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, currentCursor, latestByKey, login, pullAll, request, URL } from './helpers';

let admin: string;
let worker: string;

beforeAll(async () => {
	admin = await login('admin');
	worker = await login('worker');
});

/** POST /files with a client-chosen id: form fields before the file become the item payload. */
async function upload(token: string, id: string, name: string) {
	const form = new FormData();
	form.append('id', id);
	form.append('file', new Blob(['fake image bytes'], { type: 'image/png' }), name);
	return fetch(`${URL}/files`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
}

describe('directus_files (system collection)', () => {
	it('journals uploads, updates and deletes, which emit files.* instead of items.*', async () => {
		const cursor = await currentCursor(admin);
		const id = randomUUID();
		expect((await upload(worker, id, 'site.png')).status).toBe(200);
		await api('PATCH', `/files/${id}`, admin, { title: 'Site photo' });

		let latest = latestByKey((await pullAll(worker, cursor, ['directus_files'])).changes);
		expect(latest.get(`directus_files/${id}`)).toMatchObject({ op: 'upsert', data: { id, filename_download: 'site.png', title: 'Site photo' } });

		await api('DELETE', `/files/${id}`, admin);
		latest = latestByKey((await pullAll(worker, cursor, ['directus_files'])).changes);
		expect(latest.get(`directus_files/${id}`)).toMatchObject({ op: 'delete' });
	});

	it('keeps the client id on upload and refuses a second upload with it', async () => {
		const id = randomUUID();
		expect((await upload(worker, id, 'once.png')).status).toBe(200);
		const again = await upload(worker, id, 'once.png');
		expect(again.status).toBe(400);
		expect((await again.json()).errors[0].extensions.code).toBe('RECORD_NOT_UNIQUE');
		expect((await request('GET', `/files/${id}`, worker)).status).toBe(200);
	});

	it('snapshots file metadata the caller can read', async () => {
		const res = await request('GET', '/dirlocal/snapshot?collection=directus_files', worker);
		expect(res.status).toBe(200);
		expect(res.body.primary_key).toBe('id');
		expect(res.body.keys.length).toBeGreaterThan(0);
	});
});
