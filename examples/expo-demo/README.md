# dirlocal Expo demo

Task list that works offline: data comes from local SQLite, sync runs in the background.

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
