import { type Offline, type Row, uuid } from '@dirlocal/core';
import { Directory, File, Paths } from 'expo-file-system';

export interface FileCacheOptions {
	offline: Offline;
	/** Directus URL, as given to createDirectus(). */
	url: string;
	/** Access token for `/assets`, e.g. `() => directus.getToken()`. */
	getToken: () => Promise<string | null>;
	/** Downloaded files kept, in bytes; the least recently used go first. Default 100 MB. Unsent uploads are never removed. */
	maxBytes?: number;
}

export interface FileSource {
	/** A file the app can read now (image picker, camera); it is copied, so it may be temporary. */
	uri: string;
	type: string;
	name?: string;
	/** Extra directus_files fields (title, folder…). */
	data?: Row;
}

export interface FileCache {
	/** Copies the file into app storage, queues its upload and resolves with its id for use in items right away. */
	add(source: FileSource): Promise<string>;
	/** Local URI: the not yet uploaded copy, a cached download, or a fresh download. Null if it can't be fetched now. */
	uri(id: string): Promise<string | null>;
	/** Moves uploaded files into the cache and trims it to `maxBytes`. Runs on its own whenever the outbox changes. */
	prune(): Promise<void>;
	/** Deletes every local file, unsent uploads included: for logout. */
	clear(): void;
	dispose(): void;
}

/**
 * Files for offline use (plan §7): uploads wait in the document directory (not purged by the OS) until sent,
 * downloads from `/assets/:id` live in the cache directory. Files are named by id.
 */
export function createFileCache({ offline, url, getToken, maxBytes = 100 * 1024 * 1024 }: FileCacheOptions): FileCache {
	const uploads = new Directory(Paths.document, 'dirlocal-uploads');
	const cache = new Directory(Paths.cache, 'dirlocal-files');
	const downloads = new Map<string, Promise<string | null>>();
	// Session access times on top of file modification time: LRU within a session, oldest download first across sessions.
	const accessed = new Map<string, number>();
	let lastStamp = 0;
	// Strictly increasing, so accesses within one millisecond still order.
	const stamp = () => (lastStamp = Math.max(Date.now(), lastStamp + 1));

	const ensure = (dir: Directory) => {
		if (!dir.exists) dir.create({ intermediates: true });
	};
	const touch = (file: File, id: string) => {
		accessed.set(id, stamp());
		return file.uri;
	};

	async function download(id: string): Promise<string | null> {
		ensure(cache);
		const target = new File(cache, id);
		try {
			const token = await getToken();
			await File.downloadFileAsync(`${url.replace(/\/$/, '')}/assets/${id}`, target, {
				headers: token ? { Authorization: `Bearer ${token}` } : {},
				idempotent: true,
			});
		} catch {
			// Offline, no access, or gone: the caller shows a placeholder and asks again later.
			if (target.exists) target.delete();
			return null;
		}
		const uri = touch(target, id);
		void trim();
		return uri;
	}

	async function trim() {
		if (!cache.exists) return;
		const files = cache.list().filter((entry): entry is File => entry instanceof File);
		const lastUse = (file: File) => accessed.get(file.name) ?? file.modificationTime ?? 0;
		let total = files.reduce((sum, file) => sum + (file.size ?? 0), 0);
		for (const file of files.sort((a, b) => lastUse(a) - lastUse(b))) {
			if (total <= maxBytes) break;
			total -= file.size ?? 0;
			file.delete();
		}
	}

	async function prune() {
		if (uploads.exists) {
			const pending = new Set((await offline.pending()).filter((m) => m.op === 'upload').map((m) => m.key));
			for (const entry of uploads.list()) {
				if (!(entry instanceof File) || pending.has(entry.name)) continue;
				// Uploaded (or rejected): keep it as the cached copy so it isn't downloaded again.
				ensure(cache);
				const cached = new File(cache, entry.name);
				if (cached.exists) entry.delete();
				else await entry.move(cached);
			}
		}
		await trim();
	}

	const unsubscribe = offline.on('outbox', () => void prune().catch(() => undefined));

	return {
		async add({ uri, type, name, data }) {
			ensure(uploads);
			const id = uuid();
			const source = new File(uri);
			const copy = new File(uploads, id);
			await source.copy(copy);
			return offline.uploadFile({ key: id, uri: copy.uri, type, name: name ?? source.name, data });
		},

		async uri(id) {
			const pending = new File(uploads, id);
			if (pending.exists) return pending.uri;
			const cached = new File(cache, id);
			if (cached.exists) return touch(cached, id);
			let inFlight = downloads.get(id);
			if (!inFlight) {
				inFlight = download(id).finally(() => downloads.delete(id));
				downloads.set(id, inFlight);
			}
			return inFlight;
		},

		prune,

		clear() {
			for (const dir of [uploads, cache]) if (dir.exists) dir.delete();
			accessed.clear();
		},

		dispose: unsubscribe,
	};
}
