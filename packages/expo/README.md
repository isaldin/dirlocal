# @dirlocal/expo

Expo adapter of [dirlocal](https://github.com/isaldin/dirlocal#readme): offline Directus data in expo-sqlite, React hooks, and a file cache for uploads and `/assets`.

```sh
npx expo install @dirlocal/expo @directus/sdk expo-sqlite expo-file-system expo-crypto
```

```tsx
import { createFileCache, createOffline, expoSqlite, OfflineProvider, useCollection, useOffline } from '@dirlocal/expo';

const offline = createOffline({ directus, storage: expoSqlite(), collections: ['tasks'] });
void offline.start();

function Tasks() {
	const { data } = useCollection('tasks', { orderBy: [{ field: 'title' }] });
	const offline = useOffline();
	const done = (id: string) => offline.mutate('tasks', { op: 'update', key: id, patch: { status: 'done' } });
	…
}
```

Exports everything from [`@dirlocal/core`](https://github.com/isaldin/dirlocal/tree/main/packages/core) plus:

| | |
| --- | --- |
| `createOffline()` | core's, with native UUIDs (expo-crypto) and uploads that Expo's `fetch` accepts |
| `expoSqlite()` | `Storage` on expo-sqlite (WAL) |
| `createFileCache()` | `add()` a picked file (queued upload, id usable at once), `uri()` for display; LRU cache of downloads |
| `OfflineProvider`, `useOffline()` | context |
| `useCollection()` | local rows, re-rendered on change |
| `useSyncStatus()`, `usePendingCount()` | status line |
| `useFileUri()` | local URI of a file for `<Image>` |

Full walkthrough: [quickstart](https://github.com/isaldin/dirlocal/blob/main/docs/quickstart.md). Working app: [examples/expo-demo](https://github.com/isaldin/dirlocal/tree/main/examples/expo-demo).
