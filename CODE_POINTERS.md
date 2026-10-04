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
       └──────────────────────► `library/.assettlor/index.db`
                                       ▲
                                       │ REST / SSE
[client/src/App.tsx] ◄─────────────────┘
  ├─ Virtualized Grid (AssetGrid.tsx)
  ├─ Inspector & Players (FlipbookPlayer.tsx, AudioWaveformPlayer.tsx)
  └─ Copier (CopyModal.tsx ──► /api/assets/copy ──► copier.ts)
```

---

## 2. Directory & Module Map

| Path | Purpose | Key Files / Responsibilities |
|---|---|---|
| `shared/` | Shared TypeScript contracts | `types.ts` defines `Asset`, `AssetStack`, `AppSettings`, `AssetQueryParams`, etc. Single source of truth. |
| `server/src/` | Backend application root | `index.ts` sets up Fastify server, CORS, static client hosting, routes registration. `config.ts` manages paths and ports. |
| `server/src/db/` | SQLite database layer | `database.ts` initializes schema (`assets`, `stacks`, `tags`, `settings`), triggers, indices, WAL mode, and query helpers. |
| `server/src/routes/` | Fastify route endpoints | `assets.ts` (queries, thumbnails, range file streaming), `stacks.ts` (stack details & frames), `scan.ts` (SSE progress & scan trigger), `settings.ts` (read/save config), `fs.ts` (local directory navigation). |
| `server/src/services/` | Core business logic | `scanner.ts` (recursive directory scanning & SSE progress), `stacker.ts` (frame & audio sequence detection), `archive.ts` (virtual zip inspection & extraction), `image.ts` (sharp / TGA / BMP decoders, WebP thumbnails), `audio.ts` (metadata & waveform extraction), `copier.ts` (copy assets/stacks to target project). |
| `client/src/` | Frontend React application | `App.tsx` (state root, SSE listener, search/filter sync), `main.tsx` (entry point), `index.css` (dark slate theme). |
| `client/src/components/` | UI Components | `Sidebar.tsx` (categories, tags, formats, scan button), `TopBar.tsx` (search, stacked/flat toggle, zoom), `AssetGrid.tsx` (virtualized card grid), `AssetCard.tsx` (card preview & hover flipbook), `Inspector.tsx` (preview canvas, waveform, metadata), `FlipbookPlayer.tsx` (interactive sprite animation), `AudioWaveformPlayer.tsx` (wavesurfer player). |
| `scripts/` | Tooling & verification | `generate-sample-assets.ts` (builds test sprite sequences & zip archive), `test-pipeline.ts` (end-to-end integration test). |
| `tests/` | Vitest test suites | Unit & integration tests for all services and routes (`db.test.ts`, `routes.test.ts`, `scanner.test.ts`, etc.). |

---

## 3. Core Subsystems

### A. Scanning & Indexing (`server/src/services/scanner.ts`)
- Scans `libraryPath` recursively, computing file stats (`size`, `mtime`) and quick SHA hashes.
- Skips unchanged files based on cache records in `index.db`.
- Emits real-time Server-Sent Events (`SSE`) for UI progress feedback via `routes/scan.ts`.
- Generates 256x256 WebP thumbnails saved to `<libraryPath>/.assettlor/thumbnails/<hash>.webp`.

### B. Virtual Archive Inspection (`server/src/services/archive.ts`)
- Inspects `.zip` archives directly in memory using `adm-zip` without decompressing files to disk.
- Virtual path syntax: `Archive.zip#/inner/folder/sprite.png`.
- Sets `is_archive_entry = 1`, storing the archive's disk path in `archive_path` and entry path in `archive_entry_path`.
- On-demand streaming: Extracts buffer directly into memory for thumbnails and HTTP file requests.

### C. Sequential Stacking Engine (`server/src/services/stacker.ts`)
- **Animation Sequences**: Uses regex heuristics to identify frame suffixes (`_01`, `_frame1`, `_001`) with matching base names in the same folder.
- **Audio Variations**: Identifies numbered or lettered sound variants (`laser_01`, `laser_02` or `hit_a`, `hit_b`).
- Records stacks in `stacks` table and links member assets via `stack_id` and `stack_index`.

### D. "Copy to Game Project" Service (`server/src/services/copier.ts`)
- Copies assets to the destination folder specified in `settings.activeProjectPath`.
- For single disk files: Uses `fs.copyFileSync`.
- For virtual zip assets: Extracts entry buffer from AdmZip on the fly and writes directly to target.
- For animation stacks: Creates subfolder named after the stack and copies all constituent frames.

### E. SQLite Storage & Schema (`server/src/db/database.ts`)
- Database file: `<library_path>/.assettlor/index.db`.
- `assets`: Main table containing path, category, format, dimensions, audio metadata, hash, virtual zip flags.
- `stacks`: Stored animation and audio variation stacks.
- `tags`: Indexed tags with fast lookup index.
- `settings`: Application configuration (active project path, scan settings).

---

## 4. API Endpoints Reference

- `GET /api/assets` - Paginated & filtered assets (`category`, `tags`, `format`, `search`, `stacked`, `sort`).
- `GET /api/assets/:id/thumbnail` - WebP thumbnail image.
- `GET /api/assets/:id/file` - Raw file stream (supports HTTP 206 Partial Content range requests).
- `POST /api/assets/copy` - Copy asset or stack to target project (`assetId`, `stackId`, `copyAllFrames`).
- `GET /api/stacks/:id/assets` - Ordered frames or variations for a stack.
- `GET /api/scan/progress` - SSE live scan progress stream.
- `POST /api/scan/start` - Initiate directory scan.
- `GET /api/settings` & `POST /api/settings` - Read / write app settings.
