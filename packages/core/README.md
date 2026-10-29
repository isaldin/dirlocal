# @dirlocal/core

Platform-agnostic client engine of [dirlocal](https://github.com/isaldin/dirlocal#readme): snapshot, pull, outbox and push against [`directus-extension-dirlocal`](https://github.com/isaldin/dirlocal/tree/main/packages/directus-extension), with a cursor, backoff and events.

For Expo apps use [`@dirlocal/expo`](https://github.com/isaldin/dirlocal/tree/main/packages/expo), which re-exports this package with SQLite storage, a file cache and React hooks. Use `core` directly to write an adapter for another platform: implement `Storage` (or pass a `SqlDriver` to `sqliteStorage`) and pass a `@directus/sdk` client.

```ts
import { createOffline, memoryStorage } from '@dirlocal/core';

const offline = createOffline({ directus, storage: memoryStorage(), collections: ['tasks'] });
await offline.start(); // never rejects; failures go to the `status` and `error` events

const rows = await offline.query('tasks', { where: { status: 'todo' } });
await offline.mutate('tasks', { op: 'update', key: rows[0].id as string, patch: { status: 'done' } });
offline.on('conflict', ({ conflicts }) => console.log(conflicts));
```

| | |
| --- | --- |
| `start()` / `stop()` / `sync()` | background sync; `sync()` runs one now and rejects on failure |
| `setOnline(online)` | connectivity from the platform; going online syncs |
| `query()` / `get()` | local reads |
| `mutate()` / `uploadFile()` | local writes, queued for the server |
| `pending()` | unsent mutations |
| `clear()` | wipe everything (logout) |
| `on(event)` | `change`, `status`, `outbox`, `conflict`, `rejected`, `reset`, `unavailable`, `error` |

See [how it works](https://github.com/isaldin/dirlocal/blob/main/docs/architecture.md).
