// @vitest-environment node
import { createOffline, memoryStorage, type Transport } from '@dirlocal/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFileCache } from '../src/files.js';

/** In-memory stand-in for the expo-file-system classes the cache uses; paths instead of file:// URIs. */
const fs = vi.hoisted(() => {
	const files = new Map<string, { size: number; mtime: number }>();
	const dirs = new Set<string>();
	const remote = new Map<string, number>(); // asset id → size
	const download = { calls: [] as { url: string; headers: Record<string, string> }[] };
	let clock = 0;
	const now = () => ++clock;
	const join = (parts: unknown[]) => parts.map((p) => (typeof p === 'string' ? p : (p as { uri: string }).uri)).join('/').replace(/\/+/g, '/');
	const reset = () => {
		files.clear();
		dirs.clear();
		remote.clear();
		download.calls = [];
	};
	return { files, dirs, remote, download, now, join, reset };
});

vi.mock('expo-file-system', () => {
	class File {
		readonly uri: string;
		constructor(...parts: unknown[]) {
			this.uri = fs.join(parts);
		}
		get exists() {
			return fs.files.has(this.uri);
		}
		get name() {
			return this.uri.split('/').pop()!;
		}
		get size() {
			return fs.files.get(this.uri)?.size ?? 0;
		}
		get modificationTime() {
			return fs.files.get(this.uri)?.mtime ?? null;
		}
		delete() {
			fs.files.delete(this.uri);
		}
		async copy(to: File) {
			fs.files.set(to.uri, { size: this.size, mtime: fs.now() });
		}
		async move(to: File) {
			fs.files.set(to.uri, fs.files.get(this.uri)!);
			fs.files.delete(this.uri);
		}
		static async downloadFileAsync(url: string, to: File, options: { headers: Record<string, string> }) {
			fs.download.calls.push({ url, headers: options.headers });
			const size = fs.remote.get(url.split('/').pop()!);
			if (size === undefined) throw new Error('UnableToDownload: 404');
			fs.files.set(to.uri, { size, mtime: fs.now() });
			return to;
		}
	}
	class Directory {
		readonly uri: string;
		constructor(...parts: unknown[]) {
			this.uri = fs.join(parts);
		}
		get exists() {
			return fs.dirs.has(this.uri);
		}
		create() {
			fs.dirs.add(this.uri);
		}
		delete() {
			fs.dirs.delete(this.uri);
			for (const path of [...fs.files.keys()]) if (path.startsWith(`${this.uri}/`)) fs.files.delete(path);
		}
		list() {
			return [...fs.files.keys()].filter((path) => path.slice(0, path.lastIndexOf('/')) === this.uri).map((path) => new File(path));
		}
	}
	return { File, Directory, Paths: { document: new Directory('/doc'), cache: new Directory('/cache') } };
});

function setup(options: { maxBytes?: number } = {}) {
	let online = false;
	const transport: Transport = {
		snapshotKeys: async () => ({ cursor: 0, primary_key: 'id', keys: [] }),
		snapshotItems: async () => [],
		pull: async ({ cursor }) => ({ changes: [], next_cursor: cursor, has_more: false, inactive: [] }),
		push: async (mutations) => mutations.map((m) => ({ mutation_id: m.mutation_id, status: 'applied' as const })),
		upload: async (m) => {
			if (!online) throw new Error('fetch failed');
			fs.remote.set(m.key, 10);
			return { mutation_id: m.mutation_id, status: 'applied' as const };
		},
	};
	const offline = createOffline({ transport, storage: memoryStorage(), collections: ['tasks'] });
	const files = createFileCache({ offline, url: 'https://cms.test/', getToken: async () => 'token', ...options });
	return { offline, files, goOnline: () => (online = true) };
}

/** Lets the prune started by an outbox event finish. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => fs.reset());

describe('createFileCache', () => {
	it('keeps a copy of an added file and serves it until uploaded', async () => {
		fs.files.set('/tmp/picker/IMG_1.jpg', { size: 10, mtime: fs.now() });
		const { offline, files } = setup();

		const id = await files.add({ uri: '/tmp/picker/IMG_1.jpg', type: 'image/jpeg' });
		fs.files.delete('/tmp/picker/IMG_1.jpg'); // the picker's temp file is gone

		const [upload] = await offline.pending();
		expect(upload).toMatchObject({ op: 'upload', key: id, file: { uri: `/doc/dirlocal-uploads/${id}`, name: 'IMG_1.jpg', type: 'image/jpeg' } });
		expect(await files.uri(id)).toBe(`/doc/dirlocal-uploads/${id}`);
		expect(fs.download.calls).toEqual([]);
	});

	it('moves the copy into the cache once uploaded, so it is not downloaded again', async () => {
		fs.files.set('/tmp/IMG_2.jpg', { size: 10, mtime: fs.now() });
		const { offline, files, goOnline } = setup();
		const id = await files.add({ uri: '/tmp/IMG_2.jpg', type: 'image/jpeg' });

		goOnline();
		await offline.sync();
		await flush();

		expect(fs.files.has(`/doc/dirlocal-uploads/${id}`)).toBe(false);
		expect(await files.uri(id)).toBe(`/cache/dirlocal-files/${id}`);
		expect(fs.download.calls).toEqual([]);
	});

	it('downloads once with the access token, then serves from the cache', async () => {
		fs.remote.set('f1', 10);
		const { files } = setup();

		const [a, b] = await Promise.all([files.uri('f1'), files.uri('f1')]);
		const c = await files.uri('f1');

		expect([a, b, c]).toEqual(Array(3).fill('/cache/dirlocal-files/f1'));
		expect(fs.download.calls).toEqual([{ url: 'https://cms.test/assets/f1', headers: { Authorization: 'Bearer token' } }]);
	});

	it('returns null when the file cannot be fetched, leaving nothing behind', async () => {
		const { files } = setup();
		expect(await files.uri('missing')).toBeNull();
		expect(fs.files.has('/cache/dirlocal-files/missing')).toBe(false);
	});

	it('evicts the least recently used downloads beyond maxBytes, never unsent uploads', async () => {
		for (const id of ['old', 'used', 'new']) fs.remote.set(id, 10);
		fs.files.set('/tmp/IMG_3.jpg', { size: 50, mtime: fs.now() });
		const { files } = setup({ maxBytes: 25 });
		const pending = await files.add({ uri: '/tmp/IMG_3.jpg', type: 'image/jpeg' });

		await files.uri('old');
		await files.uri('used');
		await files.uri('old'); // now more recent than 'used'
		await files.uri('new');
		await flush();

		expect(fs.files.has('/cache/dirlocal-files/used')).toBe(false);
		expect(fs.files.has('/cache/dirlocal-files/old')).toBe(true);
		expect(fs.files.has('/cache/dirlocal-files/new')).toBe(true);
		expect(fs.files.has(`/doc/dirlocal-uploads/${pending}`)).toBe(true);
	});

	it('clear() removes uploads and downloads', async () => {
		fs.remote.set('f1', 10);
		fs.files.set('/tmp/IMG_4.jpg', { size: 10, mtime: fs.now() });
		const { files } = setup();
		await files.add({ uri: '/tmp/IMG_4.jpg', type: 'image/jpeg' });
		await files.uri('f1');

		files.clear();
		expect([...fs.files.keys()].filter((path) => !path.startsWith('/tmp'))).toEqual([]);
	});
});
