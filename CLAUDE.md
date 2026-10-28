# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

`Directus Offline — план работ.md` (Russian) is the source of truth: product goal, API contract, phase checklists, open questions, decision log. Read it before starting any task. Architecture decisions live in `docs/adr/`. The plan expects small commits, one per checklist item.

## Commands

```sh
pnpm install
pnpm build           # builds packages (directus-extension → packages/directus-extension/dist)
pnpm typecheck
pnpm dev:up          # build + Directus 12.5.1 + Postgres on :8055, extension baked into the image
pnpm dev:seed        # collections projects/tasks/notes, roles Manager/Worker; passwords = email local part
pnpm dev:reset       # drop containers and DB volume (seed is only for a fresh DB)
pnpm test            # integration tests; need dev:up + dev:seed first
pnpm --filter directus-extension-dirlocal exec vitest run tests/pull.test.ts -t "bulk update"   # single test
pnpm --filter @dirlocal/core exec vitest run tests/engine.test.ts   # core unit tests, no Directus needed
```

`pnpm dev:up` rebuilds the image, so run it after every extension change before `pnpm test`.

Inspect the journal: `docker compose -f examples/directus/docker-compose.yml exec -T postgres psql -U directus -c 'select * from dirlocal_changes order by id' </dev/null`. Without `</dev/null`, `exec -T` swallows the stdin of a surrounding heredoc/script.

Tests hit the running Directus over HTTP and share one journal: files and packages run sequentially (a `$permissions` marker from one test would 410 cursors held by another). The settled cursor lags by `DIRLOCAL_SETTLE_MS` (300 ms in dev compose, `SETTLE_MS` in `tests/helpers.ts`); `pullAll()` waits it out, and a test that needs a cursor *after* a write must `settle()` first.

## Directus 12 facts verified in phase 0 (see docs/adr/0001, 0004)

- `items.*` actions fire after commit, are not awaited, and run concurrently: journal order ≠ commit order. `server.start` is also an un-awaited action, so table setup uses init `app.before` + memoized `ensureTables()`.
- System collections emit `<name>.*` events (`files.create`), not `items.*`. DB-level cascades emit nothing.
- Without a license key (Core tier) Directus rejects permissions with item filters, field lists, validation or presets (`RESOURCE_RESTRICTED`); 3 seats (app/admin-access users only), 25 active collections. The dev seed is Core-compatible.
- `/server/health` returns 403 anonymously; use `/server/ping`.
- Filters on `uuid` fields don't support `_gt`/`_lt` (`INVALID_QUERY`), so no keyset paging by uuid PK.
- Journal keys are strings; convert back to numbers for integer PKs before `readMany` (`toPrimaryKeys`).
- Don't import `defineHook`/`defineEndpoint` from the SDK — they pull zod (~90 KB) into the bundle. Type the export with `HookConfig`/`EndpointConfig` from `@directus/types`.

## What is being built

Offline mode for Directus 12.5 apps (Expo first, web later) that keeps Directus permissions intact. Working package name `dirlocal` (not final):

- `packages/directus-extension` — bundle extension (hook + endpoint + schedule) exposing `/dirlocal/pull`, `/dirlocal/snapshot`, `/dirlocal/push`
- `packages/core` — platform-agnostic engine: snapshot/pull, cursor, scheduler with backoff, events (outbox and conflicts in phase 2)
- `packages/expo` — expo-sqlite adapter + React hooks (`useCollection`)
- `examples/directus` (docker-compose + seed with roles), `examples/expo-demo`

## Core architecture (spans server + client)

- **Change journal, not DB features.** `items.create/update/delete` action hooks append to `dirlocal_changes` (bigint autoincrement `id` = global cursor and record version; `fields` = changed field list). No triggers or logical replication — Directus supports multiple DBMSs. `directus_activity` is deliberately not used.
- **Visibility via re-read.** `pull` collapses journal entries to the latest per `(collection, item_key)` and re-reads *every* key (including deletes) through `ItemsService` with the request's `accountability`; returned → `upsert`, missing → `delete` (deleted OR no longer visible). The journal op is only a hint, so phantom entries are harmless. Entries younger than `DIRLOCAL_SETTLE_MS` are held back (sequence gaps, ADR 0001). A `$permissions` marker newer than the cursor → `410 permissions_changed` → client re-snapshots. Compaction keeps the latest entry per key, so it never forces a 410.
- **Snapshot = key list + data by key** (`GET /dirlocal/snapshot` → cursor, primary_key, keys; `POST /dirlocal/snapshot/items`). Not paged: offset loses rows on concurrent deletes and Directus forbids `_gt` on uuid.
- **Writes through ItemsService.** `push` is idempotent via `dirlocal_applied.mutation_id`; conflict = later journal entry from another actor touching overlapping fields since `base_version`. v1 policy: server wins, conflicts returned to client. The hook journals the applied write — push does not write the journal itself.
- **Client (`@dirlocal/core`):** `createOffline()` depends only on the `Storage` and `Transport` interfaces (`src/types.ts`); `memoryStorage()` is the reference Storage, `directusTransport()` wraps an `@directus/sdk` client and maps errors to `GoneError`/`ForbiddenError`/`CollectionInactiveError`/`NetworkError`. Rows are stored whole as JSON — no field schema, because `/fields` needs `directus_fields` read, which API-only users don't have. One global cursor = min of per-collection snapshot cursors (re-delivery is harmless, a gap is not). A 410 re-snapshots and reconciles local rows by the key list instead of wiping them. A collection that is inactive or unreadable is emptied locally and reported via the `unavailable` event. `start()` never rejects (the app must boot offline). Planned for phase 2: optimistic writes + outbox, client UUIDs, `client_key → server_key` map for integer PKs.

## Rules (from plan §9 and §2)

- TypeScript strict, ESM, pnpm workspaces, changesets.
- Never bypass `ItemsService` for user collections. Raw knex only for `dirlocal_*` tables.
- Permissions only via the request's `accountability` — no service tokens in endpoints.
- API contract changes: edit §6 of the plan document first, then code.
- Every server behavior gets an integration test against real Directus in Docker; unit tests for `core`.
- Do not use the word `sync` in package/endpoint/table names (taken by official `@directus/cli`); use `offline` / `local`.
- Extensions can only be installed via Marketplace or baked into the Docker image (no `npm` in the container since 12.1).
- Treat `COLLECTION_INACTIVE` (12.4+) as "collection dropped out of offline set", not an error.
- Tick checklist items in the plan document as they are completed; record decisions in its §11 decision log and open questions in §10.
