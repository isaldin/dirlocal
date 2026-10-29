# FAQ

### Why not PowerSync or ElectricSQL?

They replicate from Postgres directly, so Directus permissions don't apply: you describe who sees what a second time in their sync rules and keep the two in step. dirlocal asks Directus for everything as the signed-in user. If a role can't read a field over REST, the device never gets it.

### Does it need a Directus license?

No. It works on the free Core tier. Item-level permission rules ("only my tasks") are a Directus license feature (free for small teams through the Open Innovation Grant); with them, dirlocal sends each device only the items its user can see, because it reads through Directus.

### Does it change my data model?

No. It adds two tables, `dirlocal_changes` and `dirlocal_applied`, created on start. They are not registered as Directus collections and don't count towards the Core tier's 25 collections. UUID primary keys are recommended for collections edited offline but not required.

### Do my hooks and flows still run for offline writes?

Yes. A pushed mutation is a normal `ItemsService` call as the user, so `items.create` / `items.update` filters and actions, flows and validation run as they would for a REST request, once per mutation, when the device comes online.

### What happens when someone loses access to an item?

It disappears from their device on the next pull: the item no longer comes back when re-read as that user, so the device deletes it. When roles or policies change, devices re-snapshot.

### What if two people edit the same item offline?

Different fields: both changes are kept. The same field: the first to reach the server wins, and the other device gets a `conflict` event with the server's value. See [Conflicts](architecture.md#conflicts).

### How fresh is the data?

With WebSockets enabled on the server, a change reaches online devices about `DIRLOCAL_SETTLE_MS` (2 s) after the commit. Without them, within `pollInterval` (60 s by default). On reconnect the device syncs at once.

### Can I query related items, like tasks with their project?

Rows hold foreign keys, as Directus returns them with `fields: ['*']`. Load both collections and join in the app (see the demo's project names). Nested `fields` queries are not supported offline.

### How much does a device store?

Every row the user can see in the configured collections, as JSON in SQLite, plus downloaded files up to the file cache limit (100 MB by default). See [Sizes](limitations.md#sizes).

### Can I use it on the web?

Not yet. `@dirlocal/core` is platform-agnostic, but the browser storage adapter (`@dirlocal/web`) is planned, not built.

### Where are the API details?

The HTTP contract (pull, snapshot, push, compact) is in section 6 of the [project plan](../Directus%20Offline%20—%20план%20работ.md) (in Russian); [How it works](architecture.md) covers it in English.
