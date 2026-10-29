# dirlocal Expo demo

Task list that works offline: data comes from local SQLite, sync runs in the background. Tap a task to change its status, "New" creates a task with an optional photo — both work without a network and go out from the outbox later. "Work offline" tells the engine it has no network (as NetInfo would) while Directus keeps running, so you can edit on the server meanwhile.

## Run

```sh
pnpm install && pnpm build
pnpm dev:up && pnpm dev:seed                   # Directus on :8055
pnpm --filter @dirlocal/expo-demo ios          # development build in the iOS simulator (needs Xcode)
```

Expo Go is not required. Sign in with `worker@example.com` / `worker` (server `http://localhost:8055`; the Android emulator uses `http://10.0.2.2:8055`).

Metro started with `CI=1` does not watch files: code changes won't reach the app.

## End-to-end check (Maestro)

Phase 1 acceptance: data shows offline, and changes made in Directus arrive when the server is back, deletions included.

```sh
cd examples/expo-demo/e2e
maestro test login.yaml                                   # snapshot, "Up to date"
docker compose -f ../../directus/docker-compose.yml stop directus
maestro test offline.yaml                                 # relaunch without server: local data, "Offline"
docker compose -f ../../directus/docker-compose.yml start directus
# as admin: create "Added while offline" (assignee worker), rename "Order materials" → "Order tiles", delete "Fit the shower"
maestro test picked-up.yaml                               # all three arrive without user action
```

Phase 2 acceptance: a task with a photo created offline reaches Directus; edits of different fields from two users both survive.

```sh
pnpm dev:reset && pnpm dev:up && pnpm dev:seed               # fresh data
xcrun simctl addmedia booted ../assets/icon.png             # optional: the simulator ships sample photos already
maestro test login.yaml
maestro test offline-edits.yaml                              # Work offline; "Install countertop" → in progress; "Photo task" with a photo; "3 not sent"
# as manager (another device): PATCH /items/tasks/<Install countertop> {"title": "Install quartz countertop"}
maestro test back-online.yaml                                # Go online: nothing unsent, renamed title + in progress, photo shown
# in Directus: "Photo task" has the photo; "Install quartz countertop" is in_progress
```

`clearState` does not clear the iOS Keychain, so `login.yaml` logs out a session left from an earlier run first. Rows are `Pressable`s: iOS merges their texts into one accessibility label, so flows match rows with `.*text.*` patterns.
