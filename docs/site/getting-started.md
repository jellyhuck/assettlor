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

## Install on Proxmox VE

On a Proxmox VE host shell, create an LXC container running Assettlor:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/jellyhuck/assettlor/main/deploy/proxmox/ct/assettlor.sh)"
```

The script asks for the container OS: Debian 13, or the smaller Alpine 3.24.
Set `var_os=alpine` or `var_os=debian` before the command to skip the prompt.

The script uses the [community-scripts](https://github.com/community-scripts/core)
engine, pinned to a fixed commit, so the prompts and options match other
community-scripts containers. Assettlor itself is not part of that catalog.

Inside the container, Assettlor listens on port 3001 on all interfaces and
reads `/etc/assettlor/config.yaml`. Assettlor has no login, so only use
this on a trusted network. To add asset folders, bind-mount them into the
container and add them as libraries in Settings:

```bash
pct set <CTID> -mp0 /path/on/host,mp=/mnt/assets
```

To update, run `update` in the container console. The update builds the
latest commit of `main` alongside the running copy, then replaces it. The
configuration in `/etc/assettlor` and the catalog in
`/var/lib/assettlor/data` are kept.

### Alpine Linux

To create an Alpine 3.24 container without the OS prompt, run this on the
Proxmox VE host shell:

```bash
var_os=alpine bash -c "$(curl -fsSL https://raw.githubusercontent.com/jellyhuck/assettlor/main/deploy/proxmox/ct/assettlor.sh)"
```

The container installs Node.js from Alpine's `nodejs` package instead of
NodeSource, and runs Assettlor as an OpenRC service. The configuration, data
directory, port and `update` command are the same as on Debian. On Alpine,
`update` also upgrades the system packages, Node.js included.

### Manage the service

Run these in the container console:

| Task | Debian | Alpine |
|---|---|---|
| Status | `systemctl status assettlor` | `rc-service assettlor status` |
| Restart after editing the configuration | `systemctl restart assettlor` | `rc-service assettlor restart` |
| Follow the log | `journalctl -u assettlor -f` | `tail -f /var/log/assettlor.log` |

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
