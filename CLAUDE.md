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
```

Inspect the journal: `docker compose -f examples/directus/docker-compose.yml exec -T postgres psql -U directus -c 'select * from dirlocal_changes order by id' </dev/null`. Without `</dev/null`, `exec -T` swallows the stdin of a surrounding heredoc/script.

No test runner yet (planned: vitest integration tests against Docker Directus, phase 1).

## Directus 12 facts verified in phase 0 (see docs/adr/0001, 0004)

- `items.*` actions fire after commit, are not awaited, and run concurrently: journal order ≠ commit order. `server.start` is also an un-awaited action, so table setup uses init `app.before` + memoized `ensureTables()`.
- System collections emit `<name>.*` events (`files.create`), not `items.*`. DB-level cascades emit nothing.
- Without a license key (Core tier) Directus rejects permissions with item filters, field lists, validation or presets (`RESOURCE_RESTRICTED`); 3 seats (app/admin-access users only), 25 active collections. The dev seed is Core-compatible.
- `/server/health` returns 403 anonymously; use `/server/ping`.
- Don't import `defineHook`/`defineEndpoint` from the SDK — they pull zod (~90 KB) into the bundle. Type the export with `HookConfig`/`EndpointConfig` from `@directus/types`.

## What is being built

Offline mode for Directus 12.5 apps (Expo first, web later) that keeps Directus permissions intact. Working package name `dirlocal` (not final):

- `packages/directus-extension` — bundle extension (hook + endpoint + schedule) exposing `/dirlocal/pull`, `/dirlocal/snapshot`, `/dirlocal/push`
- `packages/core` — platform-agnostic engine: cursors, outbox, conflicts, scheduler
- `packages/expo` — expo-sqlite adapter + React hooks (`useCollection`)
- `examples/directus` (docker-compose + seed with roles), `examples/expo-demo`

## Core architecture (spans server + client)

- **Change journal, not DB features.** `items.create/update/delete` action hooks append to `dirlocal_changes` (bigint autoincrement `id` = global cursor and record version; `fields` = changed field list). No triggers or logical replication — Directus supports multiple DBMSs. `directus_activity` is deliberately not used.
- **Visibility via re-read.** `pull` collapses journal entries to the latest op per `(collection, item_key)`, re-reads non-deletes through `ItemsService` with the request's `accountability`; anything not returned is sent as `delete` (deleted OR no longer visible). Cursor older than the compacted journal → `410 Gone` → client re-snapshots.
- **Writes through ItemsService.** `push` is idempotent via `dirlocal_applied.mutation_id`; conflict = later journal entry from another actor touching overlapping fields since `base_version`. v1 policy: server wins, conflicts returned to client. The hook journals the applied write — push does not write the journal itself.
- **Client:** local SQLite is the UI's source of truth; mutations go optimistic-local + outbox; schema built from `/collections` + `/fields` (already permission-filtered); offline creates use client UUIDs, with a `client_key → server_key` map for integer-PK collections.

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
