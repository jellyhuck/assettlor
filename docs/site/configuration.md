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
resolve from the home directory. Saving settings keeps each path as the file
wrote it, and writes a newly added path inside the configuration directory as
a relative `./` path.

## Generate a configuration file

Write a fresh configuration without starting the server:

```bash
npm start -- --generate-config /absolute/path/config.yaml
```

Assettlor writes the defaults to that path and exits. It refuses to replace an
existing file and does not create or read the default configuration.

Two environment variables seed the generated file:

| Variable | Sets |
|---|---|
| `ASSETTLOR_CONF_DATA_DIR` | `data_dir`; a relative path resolves from the current working directory |
| `ASSETTLOR_CONF_PORT` | `server.port`, an integer from 1 to 65535 |

```bash
ASSETTLOR_CONF_DATA_DIR=~/assettlor-data ASSETTLOR_CONF_PORT=4000 \
  npm start -- --generate-config ~/.config/assetlor/config.yaml
```

The same variables apply when Assettlor creates a missing configuration on
first launch. They never override an existing configuration file; use `PORT`
to override the port of an existing configuration at runtime.

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
ui:
  catalog_paging: load-more
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
| `ui.catalog_paging` | How the main view reaches results beyond the first 100: `load-more` appends them with a Load more button, `pages` shows numbered pages; default `load-more` |

The effective data directory contains `index.db` and `thumbnails/`. If the
configured directory's final component is `data`, `cache`, or `.assettlor`,
Assettlor uses that directory directly; otherwise it appends `.assettlor`.
For example, `data_dir: ./library` stores the catalog in
`./library/.assettlor/index.db`.

## Classifier defaults

Classifier settings live under `classifiers.bpm`, `classifiers.sprite`,
`classifiers.pack`, and `classifiers.folder`. They can also be updated through the classifier interface
or API.

| Classifier | Defaults |
|---|---|
| BPM | Enabled; 60–200 BPM; minimum duration 1 second; analyzes up to 45 seconds |
| Sprite | Enabled; minimum confidence 0.5; visual, path, and stack analysis enabled |
| Pack | Enabled; archive and directory inference enabled; top-directory strategy at depth 1; separator cleanup and version suffix removal enabled; preserves case |
| Folder | Enabled; includes folders inside ZIP archives (`includeArchiveFolders`) |

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
