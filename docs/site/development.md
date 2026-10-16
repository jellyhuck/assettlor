---
title: Development
---

[Documentation home](index.md)

# Development

## Run locally

```bash
npm ci
npm run dev
```

`npm ci` runs the `prepare` script, which installs the client's dependencies
and builds the client. The same step builds the client when npm installs
Assettlor from GitHub, for example through `npx github:jellyhuck/assettlor`.

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
| `docs/site/` | Markdown documentation sources, built with MkDocs (`mkdocs.yml`) |

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
| `npm run docs` | Preview this documentation locally with live reload |
| `npm run docs:build` | Strict documentation build, as run in CI |

Run the pipeline check when changing scanner, stacker, or copier behavior.
The `ci` GitHub workflow installs dependencies and runs `npm test` on pushes.
The separate `documentation` workflow builds and publishes this documentation.

## Publishing documentation

Documentation sources live in `docs/site/` and are built with
[MkDocs](https://www.mkdocs.org/) and the
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) theme.
The site is configured by `mkdocs.yml` at the repository root, and the pinned
Python dependencies are listed in `docs/requirements.txt`. The
[`documentation` workflow](https://github.com/jellyhuck/assettlor/blob/main/.github/workflows/documentation.yml)
builds the site with `mkdocs build --strict`, uploads the generated `site/`
directory, and deploys it with GitHub's official Pages actions.

### Preview locally

Install Python 3 and run:

```bash
npm run docs
```

The first run creates a `.venv-docs/` virtual environment and installs the
pinned dependencies; later runs reuse it and reinstall only when
`docs/requirements.txt` changes. The command starts `mkdocs serve` at
[http://127.0.0.1:8000/assettlor/](http://127.0.0.1:8000/assettlor/) and
reloads pages as you edit them. Set `PYTHON` to choose a specific interpreter.

To reproduce the CI build, including broken-link and anchor checks, run:

```bash
npm run docs:build
```

The output is written to `site/`. Extra arguments are passed to MkDocs, for
example `npm run docs -- serve --dev-addr 127.0.0.1:8080`.

### Edit or add a page

Write Markdown in `docs/site/` with YAML front matter:

```markdown
---
title: My guide
---

[Documentation home](index.md)

# My guide

Explain the task, then show a working example.
```

Link pages with relative Markdown links such as `[Configuration](configuration.md)`.
MkDocs converts these to generated page URLs, so they work in both the
repository and the published site. Strict builds fail on links to missing
pages or anchors. Add each new page to the `nav` list in `mkdocs.yml` and to
the table in `index.md`.

The `mkdocs.yml` file selects the Material theme, its light and dark palettes,
the navigation order, and the enabled Markdown extensions. Keep generated HTML
out of the repository; `site/` and `.venv-docs/` are ignored by Git. No
application build or Node dependency installation is required for the
documentation build in CI.

See GitHub's documentation for
[custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

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
