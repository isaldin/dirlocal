# dirlocal

Offline mode for Directus apps that keeps Directus permissions intact. The app reads and writes a local SQLite database; a Directus extension tells it what changed and applies its queued writes through Directus itself, so roles, policies, validation, hooks and flows behave exactly as with a normal REST call.

> Status: early. Works against Directus 12.5 with Expo on iOS (verified in the simulator); Android and web are not verified yet.

## Why

Directus 12 has no "what changed since cursor X" API, no tombstones for deleted items, no React Native SDK and no queue for offline writes. Sync engines that read Postgres directly (PowerSync, ElectricSQL) bypass the Directus permission model, so you end up writing the rules twice.

dirlocal does everything through Directus:

- **Change journal.** Action hooks record which items changed (`dirlocal_changes`). That is the cursor and the tombstone list.
- **Visibility by re-reading.** On pull, every changed key is read again through `ItemsService` as the requesting user. Returned → update; not returned → delete on the device, whether the item was deleted or the user just lost access to it.
- **Writes through `ItemsService`.** Queued mutations are applied one by one as the user. Retries are safe (each mutation is applied once), conflicts are detected per field.

## Packages

| package | what it is |
| --- | --- |
| [`directus-extension-dirlocal`](packages/directus-extension) | Directus bundle extension: journal hooks, `/dirlocal/pull`, `/dirlocal/snapshot`, `/dirlocal/push` |
| [`@dirlocal/core`](packages/core) | Platform-agnostic client engine: snapshot, pull, outbox, conflicts, events |
| [`@dirlocal/expo`](packages/expo) | Expo adapter: expo-sqlite storage, file cache, React hooks |

## Ten-minute start

```tsx
const offline = createOffline({
	directus, // @directus/sdk client with rest() and authentication()
	storage: expoSqlite(),
	collections: ['projects', 'tasks'],
});

function Tasks() {
	const { data } = useCollection('tasks', { where: { status: 'todo' } });
	const offline = useOffline();
	// Shows at once, reaches Directus when there is a network.
	const done = (id: string) => offline.mutate('tasks', { op: 'update', key: id, patch: { status: 'done' } });
	…
}
```

Full walkthrough, server included: [docs/quickstart.md](docs/quickstart.md).

## Documentation

- [Quickstart](docs/quickstart.md): Directus image, permissions, Expo app
- [How it works](docs/architecture.md): journal, cursor, snapshot, push, conflicts
- [Limitations](docs/limitations.md): what the journal can't see, sizes, untested platforms
- [FAQ](docs/faq.md)
- [Example app](examples/expo-demo): task list with photos, works offline, Maestro end-to-end flows
- Architecture decisions: [docs/adr](docs/adr) (in Russian)

## Using dirlocal?

If you run it in an app, even a small one, please [tell us with the "We use dirlocal" form](../../issues/new?template=we-use-dirlocal.yml). It shows which setups to test first and helps others decide.

## Development

```sh
pnpm install
pnpm dev:up && pnpm dev:seed   # Directus 12.5.1 + Postgres on :8055 with the extension baked in
pnpm test                      # integration tests against that Directus, plus client unit tests
```

See [CLAUDE.md](CLAUDE.md) for commands and verified Directus behaviour.
