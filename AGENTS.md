# AGENTS.md

> Minimalist guide for AI agents to navigate, run, and debug Assettlor.

## Overview

**Assettlor** is a local-first game asset manager and web viewer built with Fastify, SQLite (WAL mode), AdmZip, and Sharp on the backend, and React 19, Vite, and Tailwind CSS on the frontend.

---

## Essential Commands

| Task | Command | Description |
|---|---|---|
| **Dev (All)** | `npm run dev` | Runs Fastify backend (`:3001`) and Vite frontend (`:5173`) concurrently |
| **Dev (Server)** | `npm run dev:server` | Watches backend with `tsx` |
| **Dev (Client)** | `npm run dev:client` | Starts Vite client dev server |
| **Build** | `npm run build` | Builds production client (`tsc -b && vite build`) |
| **Start** | `npm start` | Fastify serves API and client static bundle |
| **Test** | `npm test` | Runs all Vitest suites |
| **Test Single** | `npx vitest run tests/<file>.test.ts` | Runs a targeted test suite |
| **Pipeline Test** | `npm run test:pipeline` | End-to-end scanner, stacker, and copier verification |
| **Lint** | `npm --prefix client run lint` | Runs Oxlint on client code |
| **Generate Samples** | `npm run generate:samples` | Creates sample assets and `RetroPack.zip` in `sample/assets/` |

---

## When to Read Supplemental Docs

Do not read all documentation upfront. Load detailed docs only when relevant to your task:

- **Read [`README.md`](README.md)**: When you need high-level user features, supported media formats, UI screenshots/flow, or complete REST/SSE endpoint specs.
- **Read [`CODE_POINTERS.md`](CODE_POINTERS.md)**: When modifying or investigating backend services (`scanner`, `stacker`, `archive`, `copier`), SQLite schema & queries (`database.ts`), virtual zip entry paths, or frontend component architecture.
- **Read [`CODE_STYLE.md`](CODE_STYLE.md)**: Before authoring code. Covers NodeNext ESM `.js` import conventions, Fastify service boundaries, React 19 hook patterns, error handling, and the pre-commit checklist.

---

## Debugging Recipes

- **Targeted Test Execution**: Run `npx vitest run tests/<name>.test.ts` to isolate and debug failures without running the entire suite.
- **Inspect Embedded Database**: SQLite database lives at `<data_dir>/index.db` (default `~/.config/assetlor/data/index.db` or `sample/.assettlor/index.db` in sample mode). Inspect with:
  ```bash
  sqlite3 sample/.assettlor/index.db "SELECT id, path, category, stack_id FROM assets LIMIT 10;"
  ```
- **Verify Scanning & Copying Pipeline**: Run `npm run test:pipeline` to test incremental scanning, AdmZip virtual inspection, sequential stacking, and file copying end-to-end against sample data.
- **Client Lint Verification**: Run `npm --prefix client run lint` to catch React hook dependency errors and cascading render warnings.

---

## Critical Guardrails

1. **NodeNext ESM Imports**: Relative imports in server, shared, and scripts **must** include the `.js` extension (e.g. `import { getDatabase } from '../db/database.js';`).
2. **Virtual Zip Paths**: Zip entries are indexed as `ArchivePath.zip#/inner/path.ext`. Never query them via raw `fs` functions; use `archive.ts` helpers.
3. **SQLite WAL Access**: All database operations must go through `getDatabase()` in `server/src/db/database.ts`. Ensure test teardowns invoke `closeDatabase()`.
4. **Verification**: Always run `npm test` and `npm --prefix client run lint` after editing code.
