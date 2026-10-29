# Quickstart

From a running Directus 12.5 project to an Expo app that reads and writes offline. You need Docker for the server and an Expo development build (`npx expo run:ios`; Expo Go is not tested).

## 1. Directus with the extension

The extension is not sandboxed: it reads Directus services and its own tables. Since Directus 12.1 extensions can't be `npm install`ed in the container, and the Marketplace only offers non-sandboxed API extensions with `MARKETPLACE_TRUST=all`. The supported install is an image with the extension baked in.

From this repository:

```sh
docker build -f docker/Dockerfile -t directus-dirlocal .
# another Directus version: --build-arg DIRECTUS_VERSION=12.5.1
```

Or in your own Dockerfile, with the built extension (`package.json` + `dist/`) next to it:

```dockerfile
FROM directus/directus:12.5.1
COPY --chown=node:node directus-extension-dirlocal /directus/extensions/directus-extension-dirlocal
```

Then run that image instead of `directus/directus` and add to its environment:

```yaml
DIRLOCAL_COLLECTIONS: projects,tasks,directus_files   # what devices keep offline
WEBSOCKETS_ENABLED: 'true'                            # optional: devices pull as soon as something changes
```

On start the extension creates `dirlocal_changes` and `dirlocal_applied` (they are not Directus collections and don't count towards the Core tier's 25). Only changes made after that are journaled; devices get existing data through a snapshot.

| variable | default | |
| --- | --- | --- |
| `DIRLOCAL_COLLECTIONS` | — | collections devices keep offline; add `directus_files` to have file metadata offline |
| `DIRLOCAL_RETENTION_DAYS` | 30 | how long older journal entries and push results are kept (the latest entry per item is kept forever) |
| `DIRLOCAL_MAX_BATCH` | 500 | max items per pull, snapshot and push request |
| `DIRLOCAL_SETTLE_MS` | 2000 | how long a journal entry waits before pull hands it out (see [How it works](architecture.md#cursor)) |

## 2. Permissions

Nothing special: the app user gets exactly what they get over REST.

- **Read** on every offline collection. A field a role can't read never reaches the device. With a license, item filters ("own tasks only") work too: rows the user can't see are never sent, and rows that drop out of view are removed from the device.
- **Create / update / delete** where the app writes. A refused write comes back as a `rejected` event and the device shows the server's version again.
- **`directus_files`: read + create** to upload photos; read is enough to show them.

The app user needs no access to `dirlocal_*` tables.

## 3. The Expo app

```sh
npx expo install @dirlocal/expo @directus/sdk expo-sqlite expo-file-system expo-crypto expo-secure-store @react-native-community/netinfo
```

Create the Directus client and the offline engine once per signed-in user. Tokens go to SecureStore, so the app reopens signed in, with its local data, without a network:

```ts
// session.ts
import { authentication, createDirectus, realtime, rest } from '@directus/sdk';
import { createFileCache, createOffline, directusRealtime, expoSqlite } from '@dirlocal/expo';
import * as SecureStore from 'expo-secure-store';

export function connect(url: string) {
	const directus = createDirectus(url)
		.with(
			authentication('json', {
				autoRefresh: true,
				storage: {
					get: async () => JSON.parse((await SecureStore.getItemAsync('auth')) ?? 'null'),
					set: (value) => (value ? SecureStore.setItemAsync('auth', JSON.stringify(value)) : SecureStore.deleteItemAsync('auth')),
				},
			}),
		)
		.with(rest())
		.with(realtime({ authMode: 'handshake' })); // only with WEBSOCKETS_ENABLED

	const offline = createOffline({
		directus,
		storage: expoSqlite(),
		collections: ['projects', 'tasks', 'directus_files'],
		pollInterval: 30_000, // fallback when realtime is off or disconnected
		realtime: directusRealtime(directus),
	});
	const files = createFileCache({ offline, url, getToken: () => directus.getToken() });
	return { directus, offline, files };
}
```

Start it, feed it connectivity, and provide it to the tree:

```tsx
// App.tsx
import { OfflineProvider } from '@dirlocal/expo';
import NetInfo from '@react-native-community/netinfo';

useEffect(() => {
	void offline.start(); // never rejects: the app must boot offline
	const unsubscribe = NetInfo.addEventListener((state) => offline.setOnline(state.isConnected !== false && state.isInternetReachable !== false));
	return () => {
		unsubscribe();
		offline.stop();
	};
}, [offline]);

return (
	<OfflineProvider offline={offline}>
		<Tasks />
	</OfflineProvider>
);
```

The first `start()` takes a snapshot of each collection. Later starts show local data at once and pull what changed. `mutate` on a collection throws until its first snapshot is done; `useSyncStatus()` turns `idle` after it.

## 4. Read and write

```tsx
import { useCollection, useOffline, usePendingCount, useSyncStatus } from '@dirlocal/expo';

function Tasks({ project }: { project: string }) {
	const offline = useOffline();
	const { data, loading } = useCollection<Task>('tasks', { where: { project }, orderBy: [{ field: 'title' }] });
	const { status } = useSyncStatus(); // 'idle' | 'syncing' | 'offline' | 'error' | 'stopped'
	const pending = usePendingCount(); // local changes the server hasn't accepted yet

	const add = (title: string) => offline.mutate('tasks', { op: 'create', data: { title, project } }); // resolves with the new key
	const done = (id: string) => offline.mutate('tasks', { op: 'update', key: id, patch: { status: 'done' } });
	const remove = (id: string) => offline.mutate('tasks', { op: 'delete', key: id });
	…
}
```

- `useCollection` reads the local database and re-renders when sync changes the collection. `where` is equality only; filter further in JavaScript.
- `mutate` changes the local row at once and queues the change; it goes out with the next sync, in order. New items get a UUID on the device. For integer primary keys the server assigns the key and the device rewrites it (and references to it) when the create is accepted.
- `offline.sync()` syncs now and rejects on failure; use it for pull-to-refresh.

Conflicts and refusals are reported, and the local row already shows the server's version:

```ts
offline.on('conflict', ({ conflicts }) => toast(`Changed by someone else meanwhile: ${conflicts.map((c) => c.field).join(', ')}`));
offline.on('rejected', ({ error }) => toast(`Not saved: ${error.message}`));
```

Two people editing different fields of the same item both keep their change. If they edit the same field, the change that reached the server first wins and the other device gets `conflict` ([details](architecture.md#conflicts)).

## 5. Files

```ts
import * as ImagePicker from 'expo-image-picker';
import { useFileUri } from '@dirlocal/expo';

const picked = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] });
const asset = picked.assets?.[0];
if (asset) {
	// Copies the file into app storage and queues the upload; the id can be used right away.
	const photo = await files.add({ uri: asset.uri, type: asset.mimeType ?? 'image/jpeg' });
	await offline.mutate('tasks', { op: 'create', data: { title, photo } });
}

function Photo({ id }: { id: string }) {
	const uri = useFileUri(files, id); // null while downloading, or offline and not cached
	return uri ? <Image source={{ uri }} style={{ width: 64, height: 64 }} /> : null;
}
```

The upload is sent before the task that references it. Downloads from `/assets` are cached (100 MB by default, `maxBytes`), least recently used first out; files not uploaded yet are never evicted.

## 6. Log out

The next user of the device must not see this user's rows, photos or unsent changes:

```ts
await offline.clear(); // stops syncing; wipes rows, cursor and unsent changes
files.clear();
files.dispose();
await directus.logout();
```

Unsent changes are lost on logout. Check `await offline.pending()` first and warn the user if it isn't empty.

## Next

- [How it works](architecture.md)
- [Limitations](limitations.md): read before relying on it
- [examples/expo-demo](../examples/expo-demo): the above as a working app with end-to-end tests
