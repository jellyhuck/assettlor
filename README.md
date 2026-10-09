# Assettlor 🎮📦

**Assettlor** is a high-performance, local-first game asset manager and web viewer inspired by [AssetHoard](https://assethoard.com/). It indexes your local game development assets (sprites, sounds, tiles, archives) into an embedded SQLite database, automatically detects animation sequences and audio variations, extracts rich metadata and WebP thumbnails, and provides an AssetHoard-like dark UI for searching, previewing, and copying assets directly into your active game engine projects.

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
- **Sequential Sprite Stacking**: Automatically detects frame sequences (e.g. `Knight_Walk_01.png` ... `04.png`, `Coin_Spin_01.png` ... `06.png`) and consolidates them into single animation cards with frame counts.
- **Flipbook Animation Player**: Interactive playback in the inspector with Play/Pause, FPS slider (1-60 fps), frame timeline scrubber, and hover cycle.
- **Audio Variation Stacking**: Groups audio variations (e.g. `laser_01.wav`, `laser_02.wav` or `Explosion_A.wav`, `Explosion_B.wav`) with instant variant switcher.
- **Stacked View vs Flat View**: Toggle between stacked grouping and individual file cards anytime.

### 4. AssetHoard Dark Palette & Modern Web UI
- **Aesthetic**: Deep dark slate palette (`#141420`, `#1a1a2e`, `#252538`) with high-contrast accent badges.
- **Inspector Panel**:
  - **Images**: Zoom controls, checkerboard transparency toggle, Nearest-Neighbor (pixel art) vs Bilinear smooth scaling. Drag-to-pan is not implemented.
  - **Audio**: Interactive waveform visualization powered by `wavesurfer.js`, seeking, looping, volume, and variation tabs.
  - **Metadata**: Dimensions, channels, sample rate, bitrate, format, file size, filesystem path, tags.
- **Gallery Grid**: Responsive card grid with quick copy, audio preview, and animation flipbook on hover. The client currently loads the first 100 matching items and renders them directly; it has no pagination controls or grid virtualization.

### 5. "Copy to Game Project" Workflow
- Configure an **Active Game Project** destination path in Settings.
- Click **"Copy to Game Project"** on any card or inspector panel:
  - For single files: Copies directly into active project destination.
  - For archive files: Extracts the specific buffer from `.zip` on the fly.
  - For animation stacks: Option to copy either single frame or the entire sequence into a dedicated folder.
- Instant toast notification confirming the target directory.

---

## 📁 Supported File Formats

| Category | Formats |
|---|---|
| **Images** | `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.gif`, `.tga`, `.svg` |
| **Audio** | `.wav`, `.mp3`, `.ogg`, `.flac` |
| **Archives** | `.zip` (Virtual in-memory inspection) |

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
npm --prefix client install
```

### 2. Generate Sample Game Assets
A built-in script generates realistic game assets (animation sequences, sound variations, TGA textures, WebP items, and a nested `RetroPack.zip` archive):
```bash
npm run generate:samples
```

### 3. Run Development Server
```bash
npm run dev
```
- **Backend API**: `http://localhost:3001`
- **Frontend Web UI**: `http://localhost:5173` (proxies `/api` to backend)

### 4. Production Build & Start
```bash
npm run build
npm start
```
The Fastify server serves both the REST/SSE API and the compiled React production client at `http://localhost:3001`.

### 5. Run Verification Pipeline Tests
```bash
npm test
npm --prefix client run lint
npm run build
npm run typecheck:server
```

Run all four checks with `npm run verify`.

Run the isolated scanner-to-copy integration check with `npm run test:pipeline`.

### Configuration

`npm run dev` loads `sample/config.yaml`. `npm start` uses `~/.config/assetlor/config.yaml` by default; select another file with `--config`, `ASSETTLOR_CONFIG`, or `CONFIG_PATH`. Relative `data_dir`, `libraries`, and `projects` paths resolve from the directory containing that YAML file. The sample paths therefore point inside `sample/`.

The server binds to `127.0.0.1` by default. `server.allowed_origins` lists browser origins allowed to use the API from another origin; the sample config includes the Vite development origin. `server.allowed_hosts` lists additional accepted HTTP Host names. For intentional LAN use, configure `server.host`; add any separate browser origin and custom Host name you use. Requests from other browser origins are rejected; local command-line requests without an Origin header remain supported.

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
│   │       └── copier.ts        # Copy to active game project service
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
│   │   │   ├── SettingsModal.tsx   # Config modal for active game project
│   │   │   ├── FolderBrowserModal.tsx # File system folder picker
│   │   │   ├── CopyModal.tsx    # Stack copy confirmation modal
│   │   │   └── Toast.tsx        # Toast notification system
│   │   ├── App.tsx              # Root application component
│   │   ├── main.tsx             # React entry point
│   │   └── index.css            # AssetHoard dark palette & CSS utilities
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
