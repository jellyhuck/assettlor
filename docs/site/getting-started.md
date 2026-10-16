---
title: Getting started
---

[Documentation home](index.md)

# Getting started

## Install and launch

Install Node.js 22.12 or newer and npm. To run Assettlor without cloning the
repository:

```bash
npx github:jellyhuck/assettlor
```

The first run clones the repository, installs dependencies, and builds the
client, so it takes a few minutes. Options such as `--config ./config.yaml` go
after the package name.

From a checkout of the repository, run:

```bash
npm ci
npm start
```

`npm ci` also installs the client's dependencies and builds the client.

Open [http://127.0.0.1:3001](http://127.0.0.1:3001). The server serves both
the API and the built client. The default server is bound to your local machine.

On first launch, Assettlor creates `~/.config/assetlor/config.yaml` and stores
the catalog under `~/.config/assetlor/data/`. The directory name `assetlor`
contains one `t` even though the application name is Assettlor.

## Add your first library

1. Open Settings using the sidebar gear.
2. Under **Asset Library Source Directories**, browse to an asset folder or
   enter its path and click **Add**.
3. Click **Save Settings** to start scanning.
4. Watch scan progress, then browse the indexed assets and open an inspector
   to preview a file or stack.

A project destination is optional for browsing. To copy assets, add a
**Project Destination** in Settings, then use **Copy to Project** on a card or
in the inspector. Existing destination files produce a conflict.

## Try the sample library

Select this checkout's `sample/assets` directory as a library. Sample files
are included; regenerate them when needed with:

```bash
npm run generate:samples
```

For development with the sample configuration:

```bash
npm run dev
```

Open [http://localhost:5173](http://localhost:5173). Vite serves the client on
port 5173 and proxies API requests to the server on port 3001. This command
uses `sample/config.yaml`, with catalog data in `sample/.assettlor/`.

## Troubleshooting

| Symptom | What to check |
|---|---|
| No assets appear | Confirm the library folder exists, contains supported files, and has finished scanning. Clear active search and sidebar filters. |
| UI is unavailable after `npm start` | Run `npm run build` first and open the configured server port. |
| Copy fails | Add a project destination, check write access, and choose a folder without conflicting files. |
| A disconnected library still appears | Unavailable roots retain their catalog entries. Reconnect and scan to reconcile the files. |
| A custom browser origin is rejected | Check `server.allowed_origins` and `server.allowed_hosts` in the configuration. |

Continue with [Using Assettlor](usage.md) or [Configuration](configuration.md).
