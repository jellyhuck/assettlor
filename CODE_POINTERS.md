# Code Pointers & Architecture Guide

A navigation and reference guide for understanding subsystem implementations and data flow across Assettlor.

---

## 1. System Architecture & High-Level Flow

```
[Local Asset Directory]
       │
       ▼ (Scan / adm-zip)
[server/services/scanner.ts] ──► [server/services/stacker.ts] (Animation & audio variation grouping)
       │                                │
       ▼ (Extract metadata & thumbs)    │
[image.ts / audio.ts]                   ▼
       │                        [better-sqlite3 WAL]
       └──────────────────────► `<data_dir>/index.db`
                                       ▲
                                       │ REST / SSE
[client/src/App.tsx] ◄─────────────────┘
  ├─ Card Grid (AssetGrid.tsx)
  ├─ Inspector & Players (FlipbookPlayer.tsx, AudioWaveformPlayer.tsx)
  └─ Copier (CopyModal.tsx ──► /api/assets/copy ──► copier.ts)
```

---

## 2. Directory & Module Map

| Path | Purpose | Key Files / Responsibilities |
|---|---|---|
| `shared/` | Shared TypeScript contracts | `types.ts` defines `Asset`, `AssetStack`, `AppSettings`, `AssetQueryParams`, etc. Single source of truth. |
| `server/src/` | Backend application root | `index.ts` sets up Fastify server, CORS, static client hosting, routes registration. `config.ts` manages paths and ports. |
| `server/src/db/` | SQLite database layer | `database.ts` initializes schema (`assets`, `stacks`, `tags`, `settings`), indexes, WAL mode, and query helpers. |
| `server/src/routes/` | Fastify route endpoints | `assets.ts` (queries, thumbnails, range file streaming), `stacks.ts` (stack details & frames), `scan.ts` (SSE progress & scan trigger), `settings.ts` (read/save config), `fs.ts` (local directory navigation). |
| `server/src/services/` | Core business logic | `scanner.ts` (recursive directory scanning & SSE progress), `stacker.ts` (frame & audio sequence detection), `archive.ts` (virtual zip inspection & extraction), `image.ts` (sharp / TGA / BMP decoders, WebP thumbnails), `audio.ts` (metadata & audio artwork thumbnails), `copier.ts` (copy assets/stacks to target project). |
| `client/src/` | Frontend React application | `App.tsx` (state root, SSE listener, search/filter sync), `main.tsx` (entry point), `index.css` (dark slate theme). |
| `client/src/components/` | UI Components | `Sidebar.tsx` (categories, tags, formats, scan button), `TopBar.tsx` (search, stacked/flat toggle, card size), `AssetGrid.tsx` (responsive card grid), `AssetCard.tsx` (card preview & hover flipbook), `Inspector.tsx` (preview selection and metadata), `ImagePreview.tsx` (image fallback, zoom, and pan), `ImageThumbnail.tsx` (stack member thumbnail fallback), `FlipbookPlayer.tsx` (interactive sprite animation), `AudioWaveformPlayer.tsx` (wavesurfer player). |
| `scripts/` | Tooling & verification | `generate-sample-assets.ts` (builds test sprite sequences & zip archive), `test-pipeline.ts` (end-to-end integration test). |
| `tests/` | Vitest test suites | Unit & integration tests for all services and routes (`db.test.ts`, `routes.test.ts`, `scanner.test.ts`, etc.). |

---

## 3. Core Subsystems

### A. Scanning & Indexing (`server/src/services/scanner.ts`)
- Scans configured source libraries recursively and records which roots and subtrees were successfully enumerated.
- Verifies disk content with SHA-256 and compares ZIP entry compressed-byte fingerprints with cache records in `index.db`; unchanged assets skip media decoding. Processing fingerprints include thumbnail options and renderer versions.
- Emits real-time Server-Sent Events (`SSE`) for UI progress feedback via `routes/scan.ts`.
- Generates image WebP thumbnails within 400×400 pixels without enlargement; audio artwork is 400×240 pixels. Canonical source and ZIP-entry identities use bounded SHA-256 IDs independent of display prefixes. Versioned cache files under `<data_dir>/thumbnails/` include the asset ID, content fingerprint, and processing fingerprint. A scan stages replacements before updating SQLite, and removes unreferenced thumbnails after commit.
- Records completed and failed traversal scopes, preserving rows and thumbnails for offline roots, unreadable subtrees, and failed archives. Configured root removal is reconciled only after an explicit configuration change and successful scan admission. Scanner-owned tags refresh on reindex; user tags remain attached to the asset ID.
- Cancelling before index publication removes staged thumbnails and leaves prior rows intact. Automatic classifiers run after index publication; cancelling that phase stops classifier work while the newly indexed catalog remains available. Retry markers preserve unfinished classifier targets for a later scan.

### B. Virtual Archive Inspection (`server/src/services/archive.ts`)
- Inspects `.zip` headers and compressed bytes in memory with `adm-zip`; only changed entries are decompressed, one archive at a time. Resource limits protect entry count, declared sizes, and compression ratio. No temporary source extraction is used.
- Virtual path syntax: `Archive.zip#/inner/folder/sprite.png`.
- Sets `is_archive_entry = 1`, storing the archive's disk path in `archive_path` and entry path in `archive_entry_path`.
- Thumbnail buffers are staged during scans; serving an original archive entry reads its buffer into memory on request.

### C. Sequential Stacking Engine (`server/src/services/stacker.ts`)
- **Animation Sequences**: Uses regex heuristics to identify frame suffixes (`_01`, `_frame1`, `_001`) with matching base names in the same folder.
- **Audio Variations**: Identifies numbered or lettered sound variants (`laser_01`, `laser_02` or `hit_a`, `hit_b`).
- Records stacks in `stacks` table and links member assets via `stack_id` and `stack_index`.

### D. "Copy to Project" Service (`server/src/services/copier.ts`)
- Uses an explicit `targetPath` when supplied, otherwise the first configured project path or the active project path. `targetSubfolder` must stay within that selected destination.
- An `assetId` copies one disk file or ZIP entry, including a stack's representative asset. A `stackId` with `copyStackAll: true` copies all members into a dedicated folder; the default folder name derives from the stack name.
- Plans and checks every source and destination before writing. Existing files, duplicate member names, and destination symlinks produce conflicts. Disk and ZIP bytes are staged before exclusive publication so an existing project file is never silently replaced.
- On execution failure, rolls back only files published by that copy operation and reports any remaining paths. Success returns `copyMode`, `copiedCount`, `copiedFiles`, and the directory that contains them.

### E. SQLite Storage & Schema (`server/src/db/database.ts`)
- Database file: `<data_dir>/index.db` (configured via `config.yaml`, defaulting to `~/.config/assetlor/data/index.db` or `sample/.assettlor/index.db`).
- `assets`: Main table containing path, category, format, dimensions, audio metadata, hash, virtual zip flags.
- `stacks`: Stored animation and audio variation stacks.
- `tags`: Indexed tags with fast lookup index.
- Configuration: Stored separately in `config.yaml` (`libraries`, `projects`, `classifiers`, `server`, `pipeline`).
- `npm run dev` loads `sample/config.yaml`; `npm start` defaults to `~/.config/assetlor/config.yaml`. `--config`, `ASSETTLOR_CONFIG`, and `CONFIG_PATH` select another file. `--generate-config <path>` (handled by `runCli()` in `index.ts`) writes a fresh config and exits; `ASSETTLOR_CONF_DATA_DIR` and `ASSETTLOR_CONF_PORT` seed only newly created configs (`createInitialYamlConfig()`). Relative `data_dir`, `libraries`, and `projects` paths resolve from that file's directory.
- The default bind host is `127.0.0.1`. `server.allowed_origins` permits specified cross-origin browser clients (including Vite in the sample config), while `server.allowed_hosts` admits additional HTTP Host names. The server rejects untrusted browser origins and Host names.

---

## 4. API Endpoints Reference

- `GET /api/assets` - Paginated and filtered assets. Common query parameters: `category`, `tag`, `format`, `search`, `stackType`, `isStackedView`, `sortBy`, `sortOrder`, `page`, and `limit`; metadata filters also include `resolution`, `bpm`, `sprite`, `pack`, `width`, `height`, and `duration`.
- In stacked `queryAssets` results, each direct parameter and each `AND` search predicate matches the representative or any member independently, so different predicates may match different members of one stack. Each member subquery stays correlated to its own stack; flat results require every predicate on the same asset.
- `GET /api/assets/:id` - Detailed asset metadata and assigned tags.
- `GET /api/assets/:id/thumbnail` - WebP thumbnail image.
- `GET /api/assets/:id/file` - Raw file stream (supports HTTP 206 Partial Content range requests); returns 404 for missing assets, sources, or archive entries, 422 for corrupt ZIP content, or 500 for filesystem read failures.
- `POST /api/assets/:id/tags` - Assign tag(s) to asset (`tag`, `tags`, `source`).
- `DELETE /api/assets/:id/tags/:tag` & `DELETE /api/assets/:id/tags` - Remove tag(s) from asset.
- `PUT /api/assets/:id/tags` - Replace all tags on asset.
- `POST /api/assets/tags` - Batch add or remove tags across multiple assets.
- `POST /api/stacks/:id/tags` & `DELETE /api/stacks/:id/tags/:tag` - Assign or remove tags across all stack members.
- `GET /api/tags` - Aggregate list of all tags with counts and sources.
- `POST /api/assets/copy` - Copy one asset with `assetId`, or all stack members with `stackId` and `copyStackAll: true`; optional destination fields are `targetPath` and `targetSubfolder`. Success returns `{ success, copiedFiles, targetDirectory, copyMode, copiedCount, message }`, with `copyMode: 'asset' | 'stack'`. Errors return `{ error, code, details? }`: 400 `INVALID_COPY_REQUEST`, 404 `COPY_SOURCE_MISSING`, 409 `COPY_CONFLICT`, or 500 `COPY_IO_ERROR`. Execution failure details contain `copiedFiles`, `rolledBackFiles`, `remainingFiles`, and optionally `failedFile` and `targetDirectory`.
- `GET /api/stacks/:id/assets` - Ordered frames or variations for a stack; 404 if the stack does not exist.
- `GET /api/scan/progress` - SSE live scan progress stream.
- `POST /api/scan/start` - Initiate directory scan.
- `GET /api/settings` & `POST /api/settings` - Read / write app settings.

---

## 5. Verification and UI behavior

- Run `npm run verify` for `npm test`, client lint, client build, and `npm run typecheck:server`. The build command alone does not type-check the server.
- Run `npm run test:client` for the React DOM interaction tests with deferred fetch and EventSource fixtures.
- Run `npm run test:pipeline` for the isolated scanner → stacker → query → copy check.
- The React client pages through all matching assets with **Load more** and virtualizes grid and list rows. The inspector supports image zoom controls, pointer drag and arrow-key panning, and pan reset.
