---
title: Development
---

[Documentation home](index.md)

# Development

## Run locally

```bash
npm ci
npm --prefix client ci
npm run dev
```

The development command runs Fastify on port 3001 and Vite on port 5173
using `sample/config.yaml`. Run either process separately with
`npm run dev:server` or `npm run dev:client`.

## Architecture

| Directory | Responsibility |
|---|---|
| `shared/` | TypeScript request, response, asset, and stack contracts |
| `server/src/routes/` | HTTP validation, REST endpoints, and SSE |
| `server/src/services/` | Scanning, stacking, media processing, archives, copying, and classifiers |
| `server/src/db/database.ts` | SQLite connection, WAL configuration, schema, and queries |
| `client/src/` | React interface, gallery, inspector, players, and dialogs |
| `tests/` | Vitest service, route, and React interaction tests |
| `scripts/` | Sample generation and pipeline verification |
| `docs/site/` | Markdown documentation and Jekyll configuration |

Scanning inventories disk files and ZIP entries, extracts metadata and
thumbnails for changed assets, and publishes catalog updates to SQLite.
The stacker groups related files. The client queries the catalog through
REST and receives scan progress through SSE. Copy operations read disk
files or archive buffers and publish them into project destinations.

## Verification

```bash
npm run verify
```

This runs all Vitest tests, client lint, the production client build, and
the server TypeScript check. Useful individual commands are:

| Command | Purpose |
|---|---|
| `npm test` | All Vitest suites |
| `npx vitest run tests/scanner.test.ts` | One targeted suite |
| `npm run test:client` | React interaction tests |
| `npm --prefix client run lint` | Client Oxlint checks |
| `npm run build` | Type-check and build the production client |
| `npm run typecheck:server` | Type-check backend and shared code |
| `npm run test:pipeline` | Scanner, stacker, query, and copy integration check |

Run the pipeline check when changing scanner, stacker, or copier behavior.
The `ci` GitHub workflow installs dependencies and runs `npm test` on pushes.
The separate `documentation` workflow builds and publishes this documentation.

## Contribution conventions

Relative imports in server, shared, and script code must use `.js` extensions
for NodeNext ESM. Keep route handlers thin, put business logic in services,
and access SQLite through `getDatabase()`. Tests must call `closeDatabase()`
and clean up temporary files. Virtual ZIP paths must go through archive
helpers rather than raw filesystem calls.

Read the repository's
[code style guide](https://github.com/jellyhuck/assettlor/blob/main/CODE_STYLE.md)
before authoring code and the
[architecture guide](https://github.com/jellyhuck/assettlor/blob/main/CODE_POINTERS.md)
when navigating subsystems.
