# Assettlor 🎮📦

**Assettlor** is a high-performance, local-first game asset manager and web viewer inspired by [AssetHoard](https://assethoard.com/). It indexes your local game development assets (sprites, sounds, tiles, archives) into an embedded SQLite database, automatically detects animation sequences and audio variations, extracts rich metadata and WebP thumbnails, and provides an AssetHoard-like dark UI for searching, previewing, and copying assets directly into your active game engine projects.

---

## 🌟 Key Features

### 1. High-Performance Local-First Architecture
- **Embedded SQLite with WAL Mode**: Stores index data locally at `<data_dir>/index.db` (configured via `config.yaml`, defaulting to `~/.config/assetlor/data/index.db`) with query caching.
- **Incremental Scanning**: Computes file stats and fast content hashes to skip unchanged assets on subsequent scans.
- **Real-Time Progress via SSE**: Live updates streamed to the UI as files are scanned and indexed.

### 2. Virtual Archive Inspection (`.zip`)
- **Zero Disk Extraction**: Inspects `.zip` archives directly in memory using `adm-zip` without decompressing to disk.
- **Virtual Paths**: Items indexed as `Archive.zip#/path/to/sprite.png`.
- **On-the-Fly Thumbnail Generation & Streaming**: Extracts buffers on demand for instant previewing and streaming.
- **Auto-Archive Tagging**: Tags every asset with the archive name and interior folder structure.

### 3. Automatic Tagging & Stacking Engine
- **Sequential Sprite Stacking**: Automatically detects frame sequences (e.g. `Knight_Walk_01.png` ... `04.png`, `Coin_Spin_01.png` ... `06.png`) and consolidates them into single animation cards with frame counts.
- **Flipbook Animation Player**: Interactive playback in the inspector with Play/Pause, FPS slider (1-60 fps), frame timeline scrubber, and hover cycle.
- **Audio Variation Stacking**: Groups audio variations (e.g. `laser_01.wav`, `laser_02.wav` or `Explosion_A.wav`, `Explosion_B.wav`) with instant variant switcher.
- **Stacked View vs Flat View**: Toggle between stacked grouping and individual file cards anytime.

### 4. AssetHoard Dark Palette & Modern Web UI
- **Aesthetic**: Deep dark slate palette (`#141420`, `#1a1a2e`, `#252538`) with high-contrast accent badges.
- **Inspector Panel**:
  - **Images**: Pan & Zoom, Checkerboard transparency toggle, Nearest-Neighbor (pixel art) vs Bilinear smooth scaling.
  - **Audio**: Interactive waveform visualization powered by `wavesurfer.js`, seeking, looping, volume, and variation tabs.
  - **Metadata**: Dimensions, channels, sample rate, bitrate, format, file size, filesystem path, tags.
- **Gallery Grid**: Virtualized responsive card grid with quick copy, audio preview, and animation flipbook on hover.

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
│   │       ├── audio.ts         # Music-metadata extractor & waveform thumbnail generator
│   │       ├── archive.ts       # In-memory AdmZip inspector & virtual streaming
│   │       └── copier.ts        # Copy to active game project service
├── client/
│   ├── src/
│   │   ├── components/
│   │   │   ├── Sidebar.tsx      # Categories, Tag/Format filters, Scan button
│   │   │   ├── TopBar.tsx       # Search, Stacked/Flat toggle, Zoom, Sort
│   │   │   ├── AssetGrid.tsx    # Responsive virtualized card gallery
│   │   │   ├── AssetCard.tsx    # Asset card with hover flipbook & audio preview
│   │   │   ├── Inspector.tsx    # Right inspector with pan/zoom, flipbook, wavesurfer
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
| `GET` | `/api/assets` | Query assets with filters, search, sorting, and pagination |
| `GET` | `/api/assets/:id` | Get asset metadata details |
| `GET` | `/api/assets/:id/thumbnail` | Serve WebP thumbnail buffer |
| `GET` | `/api/assets/:id/file` | Stream raw asset (with HTTP 206 Partial Content range support) |
| `POST` | `/api/assets/copy` | Copy asset or entire stack to active game project |
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
