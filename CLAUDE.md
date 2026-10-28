# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

Pre-code. The only source of truth is `Directus Offline — план работ.md` (Russian): it holds the product goal, API contract, phase checklists, open questions, and the decision log. Read it before starting any task. There are no build, lint, or test commands yet; once `package.json` exists, add the real commands here (planned: pnpm workspaces, vitest integration tests against Directus in Docker).

The plan expects small commits, one per checklist item.

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
