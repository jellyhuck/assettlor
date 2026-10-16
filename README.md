# Assettlor 📦

[Documentation](docs/site/index.md) · [Development](docs/site/development.md)

**Assettlor** is a local-first asset manager for images, audio, and asset libraries. It indexes your local images and audio, including files inside ZIP archives, into an embedded SQLite database, automatically detects animation sequences and audio variations, and extracts rich metadata and WebP thumbnails. Its dark web interface lets you search, preview, organize, and copy assets directly into your projects.

---

## 🌟 Key Features

### 1. High-Performance Local-First Architecture
- **Embedded SQLite with WAL Mode**: Stores index data locally at `<data_dir>/index.db` (configured via `config.yaml`, defaulting to `~/.config/assetlor/data/index.db`).
- **Incremental Scanning**: Verifies disk content with SHA-256, inventories ZIP entries before decoding them, and refreshes thumbnails when processing settings change. Unavailable roots keep their indexed assets until a successful scan can reconcile them.
- **Real-Time Progress via SSE**: Live updates streamed to the UI as files are scanned and indexed.

### 2. Virtual Archive Inspection (`.zip`)
- **Zero Disk Extraction**: Inspects `.zip` archives directly in memory using `adm-zip` without decompressing to disk.
- **Virtual Paths**: Items indexed as `Archive.zip#/path/to/sprite.png`.
- **Cached Thumbnails & On-Demand Files**: Builds thumbnails during scanning, then extracts archive entry buffers when serving the original file.
- **Auto-Archive Tagging**: Tags every asset with the archive name and interior folder structure.

### 3. Automatic Tagging & Stacking Engine
- **Image Sequence Stacking**: Automatically detects frame sequences (e.g. `Logo_Spin_01.png` ... `04.png`, `Transition_01.png` ... `06.png`) and consolidates them into single animation cards with frame counts.
- **Flipbook Animation Player**: Interactive playback in the inspector with Play/Pause, FPS slider (1-60 fps), frame timeline scrubber, and hover cycle.
- **Audio Variation Stacking**: Groups audio variations (e.g. `click_01.wav`, `click_02.wav` or `Chime_A.wav`, `Chime_B.wav`) with instant variant switcher.
- **Stacked View vs Flat View**: Toggle between stacked grouping and individual file cards anytime.

### 4. "Copy to Project" Workflow
- Configure an **Active Project** destination path in Settings.
- Click **"Copy to Project"** on any card or inspector panel:
  - For a single file or a stack's representative file: Copies that asset into the selected project directory.
  - For a ZIP entry: Reads that entry from the archive and copies its bytes into the project.
  - For a full animation or audio stack: Copies every member into a dedicated folder, using the stack name when no subfolder is specified.
- Existing destination files cause a conflict instead of being overwritten. A successful copy reports the directory containing the copied files.

---

## 📁 Supported File Formats

| Category | Formats |
|---|---|
| **Images** | `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.gif`, `.tga`, `.svg` |
| **Audio** | `.wav`, `.mp3`, `.ogg`, `.flac` |
| **Archives** | `.zip` (Virtual in-memory inspection) |

TGA preview supports uncompressed or RLE true-color (24/32-bit) and grayscale
(8/16-bit) images, including all four origin orientations. Color-mapped and
interleaved TGA variants are rejected. Image decoding limits sources to
16 million pixels; TGA and BMP headers are checked before raster allocation.
Thumbnails apply EXIF orientation, preserve transparency, and use the first
frame of animated images as their still preview. SVG viewBox dimensions are
used as the intrinsic size when no width or height is specified.

---

## 🚀 Quick Start

Requires Node.js 22.12 or newer and npm.

### Run without cloning

```bash
npx github:jellyhuck/assettlor
```

npm clones the repository, installs its dependencies, and builds the client
before the first launch, so that run takes a few minutes; later runs reuse
npm's cache. Pass options after the package name, for example
`npx github:jellyhuck/assettlor --config ./config.yaml`.

### First run from a checkout

```bash
npm ci
npm start
```

`npm ci` also installs the client's dependencies and builds it, through the
`prepare` script. After changing client code, rebuild with `npm run build`.

Open `http://127.0.0.1:3001`. On first launch, Assettlor creates
`~/.config/assetlor/config.yaml` and stores its index under
`~/.config/assetlor/data/`.

1. Click the settings gear in the sidebar. Under **Asset Library Source
   Directories**, use **Browse** to select a folder of assets, or enter its
   path and click **Add**. Click **Save Settings** to start the first scan.
2. To use **Copy to Project**, add a **Project Destination** in
   Settings. Browsing and indexing assets do not require one.

For a demo, select this checkout's `sample/assets` as the library. Sample files
are included; `npm run generate:samples` regenerates them.

### Development server

```bash
npm run dev
```

This uses `sample/config.yaml`, serves the API at `http://localhost:3001`, and
runs the Vite UI at `http://localhost:5173`.

### Run verification

```bash
npm test
npm run test:client
npm --prefix client run lint
npm run build
npm run typecheck:server
```

`npm run test:client` runs the React interaction tests. Run the full test, lint,
build, and server type-check set with `npm run verify`.

Run the isolated scanner-to-copy integration check with `npm run test:pipeline`.

### Configuration

`npm run dev` loads `sample/config.yaml`. `npm start` uses `~/.config/assetlor/config.yaml` by default; select another file with `--config`, `ASSETTLOR_CONFIG`, or `CONFIG_PATH`. Relative `data_dir`, `libraries`, and `projects` paths resolve from the directory containing that YAML file. The sample paths therefore point inside `sample/`.

The server binds to `127.0.0.1` by default. It has no login, so keep it on a
trusted local machine unless you add access control. `server.allowed_origins`
lists browser origins allowed to use the API from another origin; the sample
config includes the Vite development origin. `server.allowed_hosts` lists
additional accepted HTTP Host names. For intentional LAN use, configure
`server.host`; add any separate browser origin and custom Host name you use.
Requests from other browser origins are rejected; local command-line requests
without an Origin header remain supported. Host and Origin checks are not
authentication.

---

## 📐 Project Structure

```
assettlor/
├── shared/
│   └── types.ts                 # Shared TypeScript interfaces (Asset, Stack, Settings, etc.)
├── server/
│   ├── src/
│   │   ├── config.ts            # Default paths & server config
│   │   ├── index.ts             # Fastify server entry point & static hosting
│   │   ├── db/
│   │   │   └── database.ts      # SQLite connection, WAL mode, schema, queries
│   │   ├── routes/
│   │   │   ├── assets.ts        # Assets API, thumbnail & range file streaming
│   │   │   ├── stacks.ts        # Stacks API (frames & variations)
│   │   │   ├── scan.ts          # SSE progress stream & scan controls
│   │   │   ├── settings.ts      # App settings GET/POST
│   │   │   └── fs.ts            # Directory browser for folder pickers
│   │   └── services/
│   │       ├── scanner.ts       # Recursive incremental scanner with SSE
│   │       ├── stacker.ts       # Sequential animation & audio variation stacker
│   │       ├── image.ts         # Sharp image processor, TGA/BMP decoder, WebP thumbnails
│   │       ├── audio.ts         # Music-metadata extractor & audio artwork generator
│   │       ├── archive.ts       # In-memory AdmZip inspector & virtual streaming
│   │       └── copier.ts        # Copy to active project service
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Sidebar.tsx      # Categories, Tag/Format filters, Scan button
│   │   │   ├── TopBar.tsx       # Search, Stacked/Flat toggle, card size, Sort
│   │   │   ├── AssetGrid.tsx    # Responsive card gallery
│   │   │   ├── AssetCard.tsx    # Asset card with hover flipbook & audio preview
│   │   │   ├── Inspector.tsx    # Right inspector with zoom, flipbook, wavesurfer
│   │   │   ├── FlipbookPlayer.tsx  # Interactive animation player (Play/Pause/FPS/scrub)
│   │   │   ├── AudioWaveformPlayer.tsx # Wavesurfer waveform audio player
│   │   │   ├── SettingsModal.tsx   # Config modal for active project
│   │   │   ├── FolderBrowserModal.tsx # File system folder picker
│   │   │   ├── CopyModal.tsx    # Stack copy confirmation modal
│   │   │   └── Toast.tsx        # Toast notification system
│   │   ├── App.tsx              # Root application component
│   │   ├── main.tsx             # React entry point
│   │   └── index.css            # Dark palette & CSS utilities
│   ├── vite.config.ts           # Vite configuration with Tailwind CSS & API proxy
│   └── package.json
├── scripts/
│   ├── generate-sample-assets.ts # Sample asset generator script
│   └── test-pipeline.ts         # End-to-end backend test verification script
└── package.json
```

---

## 🛠️ REST & SSE API Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/assets` | Query assets with `category`, `tag`, `format`, `search`, `stackType`, `isStackedView`, `sortBy`, `sortOrder`, `page`, and `limit` (plus metadata filters such as `resolution`, `bpm`, `width`, `height`, and `duration`) |
| `GET` | `/api/assets/:id` | Get asset metadata details |
| `GET` | `/api/assets/:id/thumbnail` | Serve WebP thumbnail buffer |
| `GET` | `/api/assets/:id/file` | Stream raw asset (with HTTP 206 Partial Content range support) |
| `POST` | `/api/assets/copy` | Copy an `assetId`, or send `stackId` with `copyStackAll: true` for the whole stack; `targetPath` and `targetSubfolder` are optional |
| `GET` | `/api/stacks/:id` | Get stack details |
| `GET` | `/api/stacks/:id/assets` | Get ordered frames or variations for a stack |
| `GET` | `/api/tags` | List all indexed tags with usage counts |
| `POST` | `/api/assets/:id/tags` | Assign tag(s) to asset (`tag`, `tags`, `source`) |
| `DELETE` | `/api/assets/:id/tags/:tag` | Remove a specific tag from an asset |
| `DELETE` | `/api/assets/:id/tags` | Remove multiple tags from an asset via request body |
| `PUT` | `/api/assets/:id/tags` | Set/replace all tags on an asset |
| `POST` | `/api/assets/tags` | Batch add or remove tags across multiple assets |
| `POST` | `/api/stacks/:id/tags` | Assign tag(s) across all member assets in a stack |
| `DELETE` | `/api/stacks/:id/tags/:tag` | Remove a tag from all member assets in a stack |
| `GET` | `/api/formats` | List all file formats with counts |
| `GET` | `/api/scan/progress` | Server-Sent Events (SSE) live indexing progress |
| `POST` | `/api/scan/start` | Trigger incremental directory scan |
| `POST` | `/api/scan/cancel` | Cancel active directory scan |
| `GET` | `/api/settings` | Get current application settings |
| `POST` | `/api/settings` | Update settings (library path, active project, etc.) |
| `GET` | `/api/fs/browse` | Browse local directories for folder selection modals |

In `search`, `tag:"name"` and `pack:"name"` match exact labels. Quote names
containing spaces, punctuation, or search operators; escape `"` and `\` inside
quotes with a backslash. An unquoted `*` is a wildcard only in `pack:` filters
(for example, `pack:retro*`). `%` and `_` are literal characters, including in
wildcard searches. Named BPM filters use `slow` (<80), `moderate` (80–<120),
`fast` (120–<150), and `high`/`very-fast` (≥150); numeric comparisons and
ranges retain their typed bounds.

In stacked view, each filter checks the stack's representative and members.
Separate filters joined with `AND` may match different members of the same
stack: `tag:target AND bpm:fast` can match a tag on one member and the BPM on
another. Direct query parameters use the same rule. In flat view, the same
filters must match one asset.

While typing, an empty known filter such as `tag:` adds no restriction until
it has a value. An unsupported clause is searched as literal text; an
unfinished group keeps its complete filters when it can be repaired safely.

For `POST /api/assets/copy`, provide exactly one of `assetId` or `stackId`. A stack request requires `copyStackAll: true`; sending the representative asset's `assetId` copies only that file. `targetPath` explicitly selects the project destination. When omitted, the server uses the first configured project path, then the active project path. `targetSubfolder` selects a relative folder inside that destination. A full stack uses a folder derived from its name when `targetSubfolder` is omitted.

A successful copy returns `{ success, copiedFiles, targetDirectory, copyMode, copiedCount, message }`. `copyMode` is `asset` for a single or representative file and `stack` for a full stack; `targetDirectory` always contains the copied files. Copy errors return `{ error, code, details? }`: `400 INVALID_COPY_REQUEST` for invalid inputs or paths, `404 COPY_SOURCE_MISSING` for missing assets, stacks, or source files, `409 COPY_CONFLICT` for occupied or unsafe destinations, and `500 COPY_IO_ERROR` for other I/O failures. Execution failure details provide `copiedFiles`, `rolledBackFiles`, `remainingFiles`, and, when known, `failedFile` and `targetDirectory` so callers can identify any output left behind.

`GET /api/stacks/:id/assets` returns 404 when the stack does not exist. `GET /api/assets/:id/file` returns 404 for a missing catalog asset, source, or archive entry, 422 for corrupt archive content, and 500 for filesystem read failures.
