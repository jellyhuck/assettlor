---
title: Configuration
---

[Documentation home](index.md)

# Configuration

## Choose a configuration file

`npm start` defaults to `~/.config/assetlor/config.yaml`. `npm run dev` and
`npm run dev:server` explicitly use `sample/config.yaml`.

Select another file with:

```bash
npm start -- --config /absolute/path/config.yaml
```

The selection order is `--config`, `ASSETTLOR_CONFIG`, `CONFIG_PATH`, then
the default file. Relative `data_dir`, `libraries`, and `projects` paths
resolve from the configuration file's directory. Paths beginning with `~/`
resolve from the home directory.

## Example

```yaml
server:
  port: 3001
  host: 127.0.0.1
  allowed_origins: []
  allowed_hosts: []
data_dir: ./data
libraries:
  - ./assets
projects:
  - ./game-project
pipeline:
  thumbnail_quality: 80
  auto_stack_animations: true
  auto_stack_audio: true
  default_fps: 12
```

| Setting | Behavior |
|---|---|
| `server.port` | HTTP port; defaults to 3001. `PORT` overrides it. |
| `server.host` | Bind address; defaults to `127.0.0.1`. `HOST` overrides it. |
| `server.allowed_origins` | Additional browser origins permitted to call the API across origins |
| `server.allowed_hosts` | Additional accepted HTTP Host names |
| `data_dir` | Location for the embedded database and thumbnail cache |
| `libraries` | Directories to index; empty on a fresh installation |
| `projects` | Copy destinations; empty on a fresh installation |
| `pipeline.thumbnail_quality` | WebP quality, an integer from 1 to 100; default 80 |
| `pipeline.auto_stack_animations` | Group detected image sequences; default `true` |
| `pipeline.auto_stack_audio` | Group detected audio variations; default `true` |
| `pipeline.default_fps` | Animation playback rate, an integer from 1 to 60; default 12 |

The effective data directory contains `index.db` and `thumbnails/`. If the
configured directory's final component is `data`, `cache`, or `.assettlor`,
Assettlor uses that directory directly; otherwise it appends `.assettlor`.
For example, `data_dir: ./library` stores the catalog in
`./library/.assettlor/index.db`.

## Classifier defaults

Classifier settings live under `classifiers.bpm`, `classifiers.sprite`, and
`classifiers.pack`. They can also be updated through the classifier interface
or API.

| Classifier | Defaults |
|---|---|
| BPM | Enabled; 60–200 BPM; minimum duration 1 second; analyzes up to 45 seconds; BPM and tempo tags disabled |
| Sprite | Enabled; minimum confidence 0.5; visual, path, and stack analysis enabled; sprite tags disabled |
| Pack | Enabled; archive and directory inference enabled; top-directory strategy at depth 1; separator cleanup and version suffix removal enabled; preserves case; pack tags disabled |

The repository's [sample configuration](https://github.com/jellyhuck/assettlor/blob/main/sample/config.yaml)
lists the available default classifier fields.

## Local access

Assettlor has no login. Keep it bound to a trusted local machine unless you
provide access control. For intentional LAN access, configure `server.host`
and add any separate browser origin and custom Host name you use. The sample
configuration allows the Vite origins at `http://localhost:5173` and
`http://127.0.0.1:5173`.

Host and Origin checks are not authentication. Local command-line clients
without an Origin header remain supported.
