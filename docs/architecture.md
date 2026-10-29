# How it works

```
 device                                              Directus
┌─────────────────────────────┐                     ┌──────────────────────────────────────────┐
│ UI ── useCollection ──┐     │                     │ items.* / files.* action hooks           │
│                       ▼     │  GET  /dirlocal/pull │        │                                 │
│        local SQLite (rows,  │◄────────────────────┤        ▼                                 │
│        cursor, outbox)      │  GET  /dirlocal/snapshot  dirlocal_changes (journal)           │
│                       ▲     │                     │        │ keys that may have changed      │
│ mutate ───────────────┘     │  POST /dirlocal/push │        ▼                                 │
│        outbox ─────────────►├────────────────────►│ ItemsService as the requesting user      │
│        uploads ────────────►│  POST /files        │ (permissions, validation, hooks, flows)  │
└─────────────────────────────┘                     └──────────────────────────────────────────┘
```

The device never sees a database row Directus wouldn't return to that user over REST, and never writes anything Directus wouldn't accept from that user over REST. Every read and write goes through `ItemsService` with the request's `accountability`; the extension uses raw SQL only for its own `dirlocal_*` tables.

## The journal

Action hooks on `items.create`, `items.update` and `items.delete` (and `files.*` / `files.upload` for `directus_files`) append one row per changed item to `dirlocal_changes` for collections in `DIRLOCAL_COLLECTIONS`:

| column | |
| --- | --- |
| `id` | bigint autoincrement: the global cursor and the item's version |
| `collection`, `item_key` | which item |
| `op` | `c` / `u` / `d`, a hint only |
| `fields` | changed fields, from the update payload; used for conflicts |
| `actor` | the user who made the change |

The journal stores no data, only "this item may have changed". Deleting an item whose children in tracked collections are removed or nulled by a database `ON DELETE CASCADE` / `SET NULL` journals those children too: Directus doesn't emit events for them, so the extension collects their keys before the delete.

Changes to roles, policies, permissions or a user's role/status write a `$permissions` marker instead (see [Permission changes](#permission-changes)).

A daily job (03:00) drops entries older than `DIRLOCAL_RETENTION_DAYS`, except the newest entry for each item. A device that was offline for months still learns about every item that changed since; it just can't tell how many times.

## Cursor

The device keeps one number: the highest journal `id` it has processed. Pull asks for entries after it.

Directus runs action hooks after the commit, concurrently and without waiting for them, and a sequence value is assigned at insert but becomes visible at commit. So entry 11 can be visible before entry 10. A device that got cursor 11 at that moment would skip 10 forever. Pull therefore only hands out entries older than `DIRLOCAL_SETTLE_MS` (2 s by default); each journal insert is a single autocommit statement, so gaps close in milliseconds. The cost is about two seconds of extra delivery latency.

Delivering an entry twice is harmless (the device gets the item's current state), skipping one is not, so every cursor decision errs towards re-delivery.

## Snapshot

The first time a device sees a collection (and after a reset), it asks for:

1. `GET /dirlocal/snapshot?collection=tasks` → the settled cursor, the primary key field name and **all keys the user can see**;
2. `POST /dirlocal/snapshot/items` → rows for those keys, in batches.

Then it pulls from that cursor. Anything that changed during the snapshot is delivered again by pull.

Why not pages: offset paging loses rows when earlier rows are deleted between pages, and Directus has no `_gt` filter on `uuid` keys for keyset paging. The key list also lets the device delete local rows that are no longer on the server after a reset, without wiping and refetching everything.

## Pull

`GET /dirlocal/pull?cursor=…&collections=…`:

1. Take settled journal entries after the cursor, collapse them to the latest per item.
2. Read **every** key again through `ItemsService.readMany` as the user, deletes included.
3. Returned → `upsert` with the row. Not returned → `delete`: the item was deleted, or the user can no longer see it.

Because visibility is decided by re-reading, the journal's `op` is only a hint. Entries for rolled-back writes, or for items the user never could see, cost a read and change nothing on the device. Fields the role can't read are absent from the row, exactly as over REST.

A collection Directus reports as inactive (`COLLECTION_INACTIVE`, 12.4+) or that the user can't read at all is emptied on the device and reported through the `unavailable` event.

### Permission changes

When access rules change, items can become visible without changing themselves, so no journal entry would ever bring them to the device. Instead the extension writes a `$permissions` marker; pull with a cursor before it answers `410 permissions_changed`, and the device re-snapshots every collection. Local rows stay on screen and are reconciled against the new key lists.

A cursor ahead of the journal (database restored from a backup) gets `410 cursor_ahead` and the same treatment.

## Writes

`mutate` writes the changed row and an outbox entry in one local transaction. The outbox entry carries the item key, the patch and `base_version`, the device's cursor at the time of the edit: every change up to it was already on the device.

A sync runs **push, then snapshots of new collections, then pull**. Pushing first means the pull that follows already reflects the device's own changes.

Rows that arrive from the server while some of their changes are still unsent are shown with those changes replayed on top, so a background pull never makes a local edit flicker back.

### Push

`POST /dirlocal/push` applies mutations strictly in order, each as an ordinary `ItemsService` call as the user: its own transaction, hooks and flows run after the commit, and the journal hook records the change like any other write.

Retries are safe. Before applying, the server claims the `mutation_id` in `dirlocal_applied`; a retried mutation gets the stored result instead of being applied again. If a claim is less than 60 s old and still has no result, another request is applying it (`409`, the device retries later). An older claim without a result means the server crashed mid-mutation; the retry checks whether the create or delete already happened before applying.

Each result is `applied`, `conflict` or `rejected`:

- **rejected**: Directus refused the write (permissions, validation, unique constraint, item deleted on the server). The device drops the change and re-reads the item.
- **conflict**: see below. The device re-reads the item, so it shows the server's values.
- An error other than a 4xx aborts the batch with a 500; the device retries the whole batch, and mutations already applied return their stored results.

### Conflicts

v1 rule ([ADR 0002](adr/0002-conflict-policy-v1.md)): **the server wins per field.**

For an update, the server looks at journal entries for the item after `base_version`. Fields changed meanwhile **by another user** are not applied; the other fields of the patch are. The device gets `conflict` with the server's value for each skipped field.

| device A (offline) | device B (online, another user) | result |
| --- | --- | --- |
| status → done | title → "New title" | both applied |
| title → "A" | title → "B" (first) | "B" stays, A gets `conflict` for `title` |
| status → done | deletes the item | A gets `rejected` (`DELETED`) |
| deletes the item | title → "B" | delete not applied, A gets `conflict` |

Edits by the same user from two devices are not conflicts: the last write wins. Merging values (v2) is planned.

### Keys

Devices create items with a UUID v4 key. If the collection's primary key is an integer, the server creates the item without the device's key and returns the assigned `server_key`; the device then rewrites the row, references to it in other local rows and in unsent mutations. Later mutations in the same push batch that reference the new item are rewritten by the server. UUID primary keys avoid all of that and are recommended for collections edited offline ([ADR 0003](adr/0003-key-policy.md)).

## Files

`files.add()` copies the picked file into the app's document directory (temporary picker files may disappear) and queues an `upload` entry in the same outbox. Push sends it alone to Directus' own `POST /files` with the device's UUID as the file id, in outbox order, so the file exists on the server before the item that references it. A retried upload that already went through is recognised by `RECORD_NOT_UNIQUE`.

Files are downloaded lazily from `/assets/:id` with the user's token into the cache directory and evicted least recently used first. With `directus_files` in `DIRLOCAL_COLLECTIONS`, file metadata is offline like any other collection.

## Realtime

With `WEBSOCKETS_ENABLED=true` on the server and `realtime: directusRealtime(directus)` on the device, the engine subscribes to the offline collections, asking for primary keys only. A message is just a signal to pull: what the user may see is still decided by pull. Since the WebSocket event arrives before the journal entry has settled, pull answers with `retry_after_ms` when entries are pending, and the device pulls again then. Polling (`pollInterval`) keeps running as the fallback.

## Local storage

Rows are stored whole as JSON, one table per collection (`key`, `data`), with queries via `json_extract`. The device never fetches the field schema: `/fields` needs read access to `directus_fields`, which API-only users usually don't have, and with JSON rows there is no local schema to migrate when fields change on the server.
