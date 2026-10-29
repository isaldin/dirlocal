# directus-extension-dirlocal

Server side of [dirlocal](../../README.md): offline mode for Directus apps that keeps Directus permissions intact.

A bundle extension (hook + endpoint) for Directus 12.5+:

- journals create/update/delete of the collections in `DIRLOCAL_COLLECTIONS` into `dirlocal_changes`;
- `GET /dirlocal/pull`: what changed since a cursor, re-read as the requesting user (deletes and items that left the user's view come back as `delete`);
- `GET /dirlocal/snapshot`, `POST /dirlocal/snapshot/items`: the initial copy;
- `POST /dirlocal/push`: queued offline writes, applied once each through `ItemsService` as the user, with per-field conflict detection;
- a daily compaction of the journal.

Clients: [`@dirlocal/expo`](../expo) (or [`@dirlocal/core`](../core) for other platforms).

## Install

The extension is not sandboxed, so the Marketplace offers it only with `MARKETPLACE_TRUST=all`. The usual install is an image with the extension baked in:

```dockerfile
FROM directus/directus:12.5.1
COPY --chown=node:node directus-extension-dirlocal /directus/extensions/directus-extension-dirlocal
```

## Configure

| variable | default | |
| --- | --- | --- |
| `DIRLOCAL_COLLECTIONS` | — | collections devices keep offline, comma-separated; `directus_files` for file metadata |
| `DIRLOCAL_RETENTION_DAYS` | 30 | how long older journal entries and push results are kept |
| `DIRLOCAL_MAX_BATCH` | 500 | max items per pull, snapshot and push request |
| `DIRLOCAL_SETTLE_MS` | 2000 | delay before pull hands out a journal entry |
| `WEBSOCKETS_ENABLED` | Directus default `false` | set `true` so devices pull as soon as something changes |

App users need the same permissions as over REST: read on offline collections, create/update/delete where the app writes, read + create on `directus_files` for uploads.

See the [quickstart](../../docs/quickstart.md), [how it works](../../docs/architecture.md) and [limitations](../../docs/limitations.md).
