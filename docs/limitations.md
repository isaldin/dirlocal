# Limitations

Read this before relying on dirlocal. Items marked *planned* are on the roadmap; the rest are consequences of the design.

## Changes the journal can't see

- **Writes that bypass Directus events**: direct SQL, database triggers, other extensions calling `ItemsService` with `emitEvents: false`. Devices learn about such an item only when it changes again through Directus, or on the next snapshot. *Planned:* a nightly reconciliation by `date_updated` for collections that have it.
- **Database cascades across the tracked set.** `ON DELETE CASCADE` / `SET NULL` from one tracked collection into another is journaled. Cascades into or out of collections not in `DIRLOCAL_COLLECTIONS` are not.
- **A crash between commit and journal insert.** Directus runs action hooks after the commit without waiting for them; if the process dies in between, that change is never journaled. Same remedy as above.
- **Relational permission rules** (license tier): if `notes` are visible through `task.assignee` and a task is reassigned, the visibility of its notes changes without any journal entry for `notes`. Devices catch up on the next change of each note or the next snapshot. *Planned.*
- **Journal inserts slower than `DIRLOCAL_SETTLE_MS`** (a heavily overloaded database) can let a device skip an entry. Raise the setting if your database is slow under load.

## Writes

- **Conflicts are per field, server wins** (v1). There is no merging of values, and edits by the same user from two devices are last-write-wins. *Planned:* value merging, optionally CRDTs for text.
- **Integer primary keys** work but cost more: the device rewrites references in every local row after the server assigns a key. And if the server crashes between creating such an item and storing the push result, the retry creates it a second time: with a server-assigned key there is nothing to tell "applied" from "not applied". Use UUID keys for collections created offline.
- **Relations are plain foreign keys.** Rows are stored as Directus returns them with `fields: ['*']`; M2O fields hold the related key, O2M/M2M aliases are not expanded. Put junction collections in `DIRLOCAL_COLLECTIONS` to have many-to-many offline, and join locally.
- **Validation runs on the server.** A change that fails a permission rule, validation or a unique constraint is accepted on the device and refused on push (`rejected`, the row reverts). Directus doesn't enforce `meta.required` through `ItemsService`, only database constraints.
- **Logout discards unsent changes** (`offline.clear()`). Check `offline.pending()` first.

## Sizes

- The snapshot sends all keys of a collection in one response: about 4 MB of JSON for 100,000 UUID keys. Rows then come in batches of `DIRLOCAL_MAX_BATCH`. Collections far beyond that need key paging, which is not built yet.
- Each device keeps everything the user can see in the listed collections. There is no per-device subset ("only this project") other than permissions.
- `useCollection`'s `where` is equality only, evaluated in SQLite over JSON without indexes. Fine for thousands of rows per collection; untested beyond.

## Platforms and versions

- **Directus 12.5.** Built and tested against 12.5.1 with Postgres 17. Other databases supported by Directus should work (no database-specific SQL) but are not tested.
- **Expo on iOS** is verified in the simulator, as a development build. **Android, real devices with real network loss, and Expo Go are not tested yet.**
- **Web** (`@dirlocal/web`) is not built yet. `@dirlocal/core` has no React Native dependency, but there is no browser storage adapter.
- **Item-level permissions** (filters, field lists) need a Directus license or the Open Innovation Grant; on the Core tier Directus rejects them. dirlocal relies on whatever Directus enforces, so it works on both, but its own tests for item-level rules run only with a license key.

## Installation

The extension is not sandboxed (it uses Directus services and its own tables). The Directus Marketplace offers non-sandboxed API extensions only when the instance sets `MARKETPLACE_TRUST=all`; otherwise bake it into your image ([quickstart](quickstart.md#1-directus-with-the-extension)). On Directus Cloud, check whether your plan allows non-sandboxed extensions; this has not been tried.
