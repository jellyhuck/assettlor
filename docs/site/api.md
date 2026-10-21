---
title: API reference
---

[Documentation home](index.md)

# API reference

The default API base URL is `http://127.0.0.1:3001`. Send JSON request bodies
with `Content-Type: application/json`. Shared TypeScript request and response
contracts are defined in
[`shared/types.ts`](https://github.com/jellyhuck/assettlor/blob/main/shared/types.ts).

## Assets and metadata

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/assets` | Paginated asset or stack query |
| GET | `/api/assets/:id` | Asset metadata and tags |
| GET | `/api/assets/:id/thumbnail` | WebP thumbnail |
| GET | `/api/assets/:id/file` | Original file, including byte-range responses |
| GET | `/api/stacks/:id` | Stack details |
| GET | `/api/stacks/:id/assets` | Ordered stack members |
| GET | `/api/tags` | Tags and usage counts |
| GET | `/api/formats` | Format counts |
| GET | `/api/resolutions` | Resolution counts |
| GET | `/api/bpms` | BPM counts |
| GET | `/api/folders` | Subfolder counts from the Folder Classifier |
| GET | `/api/libraries` | Library names with their paths and asset counts |

`GET /api/assets` accepts `category`, `tag`, `format`, `resolution`, `bpm`,
`sprite`, `pack`, `folder`, `library`, `width`, `height`, `duration`, `search`, `stackType`, and
`isStackedView`. See [search behavior](usage.md#search) for stacked filtering.

Use `sortBy` with `name`, `size`, `mtime`, `resolution`, `duration`, `bpm`,
`width`, or `height`, and `sortOrder` with `asc` or `desc`. `page` and `limit`
must be positive integers; defaults are 1 and 60, and limits are capped at 200.
`isStackedView` accepts `true` or `false`.

```bash
curl --get http://127.0.0.1:3001/api/assets \
  --data-urlencode 'search=tag:"pixel art"' \
  --data-urlencode 'isStackedView=true' \
  --data-urlencode 'page=1' \
  --data-urlencode 'limit=60'
```

The list response contains `items`, `total`, `page`, `limit`, `totalPages`,
and a `summary` of asset counts, stack counts, and total size.

Original-file requests return 404 for a missing catalog asset, source file,
or archive entry; 422 for corrupt archive content; and 500 for filesystem
read failures. Stack-member requests return 404 for a missing stack.

## Tags

| Method | Endpoint | Request body |
|---|---|---|
| POST | `/api/assets/:id/tags` | `tag` or `tags`, optional `source` |
| DELETE | `/api/assets/:id/tags/:tag` | None |
| DELETE | `/api/assets/:id/tags` | `tag` or `tags` |
| PUT | `/api/assets/:id/tags` | Replacement `tags`, optional `source` |
| POST | `/api/assets/tags` | `assetIds`, `tags`, optional `action` (`add` or `remove`) and `source` |
| POST | `/api/stacks/:id/tags` | `tag` or `tags`, optional `source`; applies across members |
| DELETE | `/api/stacks/:id/tags/:tag` | None; removes the tag across members |
| DELETE | `/api/stacks/:id/tags` | `tag` or `tags`; removes across members |

URL-encode tag names when placing them in an endpoint path.

## Copy assets

`POST /api/assets/copy` requires exactly one of `assetId` or `stackId`.
A stack request also requires `copyStackAll: true`.

```json
{
  "stackId": "STACK_ID",
  "copyStackAll": true,
  "targetPath": "/absolute/path/to/project",
  "targetSubfolder": "assets/hero"
}
```

`targetPath` is optional; the server otherwise uses the first configured
project path, then the active project path. `targetSubfolder` is optional
and must stay inside the destination. A whole-stack copy uses a folder
derived from the stack name if no subfolder is supplied. To copy only a
stack's representative file, send its `assetId`.

Success returns `success`, `copiedFiles`, `targetDirectory`, `copyMode`
(`asset` or `stack`), `copiedCount`, and `message`.

| Status | Error code | Meaning |
|---|---|---|
| 400 | `INVALID_COPY_REQUEST` | Invalid inputs or paths |
| 404 | `COPY_SOURCE_MISSING` | Missing asset, stack, or source |
| 409 | `COPY_CONFLICT` | Occupied or unsafe destination |
| 500 | `COPY_IO_ERROR` | Other copy I/O failure |

Errors contain `error`, `code`, and optional `details`. Execution-failure
details identify `copiedFiles`, `rolledBackFiles`, `remainingFiles`, and,
when known, `failedFile` and `targetDirectory`.

## Scanning and events

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/scan/status` | Current scan status |
| GET | `/api/scan/progress` | Server-Sent Events stream |
| POST | `/api/scan/start` | Start a scan; optionally save requested library paths |
| POST | `/api/scan/library` | Scan or reindex one configured library without changing settings |
| POST | `/api/scan/cancel` | Request cancellation |

`/api/scan/start` accepts optional `libraryPath` or `libraryPaths`. Without
these fields, it uses configured libraries. It also accepts `fullRescan: true`.

`/api/scan/library` takes `libraryPath`, which must be a configured library.
Without other fields it scans for new and changed files. With `reindex: true`
it deletes the library's index and rebuilds it from scratch: thumbnails,
metadata, stacks, and classifier results. The old index stays available
until the new one is committed; cancelling or an unavailable library leaves
it unchanged. `keepUserTags` (default `true`) restores user tags on assets
that still exist.

Concurrent scan requests return 409; invalid targets return 400.

```bash
curl -N http://127.0.0.1:3001/api/scan/progress
```

The SSE stream sends JSON in `data:` messages with `status` (`idle`,
`scanning`, `completed`, or `error`), `libraryPath`, `scannedCount`, and
`indexedCount`. Events may also include `committedCount` (assets committed to
the index so far in this scan), `libraryPaths`, `reindexing`, `currentFile`,
`message`, timing fields, `error`, and `failedScopes`. Comment heartbeats
keep the connection active.

## Settings, directories, and classifiers

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/settings` | Current application settings |
| POST | `/api/settings` | Update application settings |
| GET | `/api/fs/browse?path=...` | Browse visible subdirectories |
| POST | `/api/fs/validate` | Check a directory using `{ "path": "..." }` |
| GET | `/api/classifiers` | Classifier metadata and settings |
| GET | `/api/classifiers/targets` | Available directory, archive, and asset targets |
| GET | `/api/classifiers/:id` | One classifier's metadata and settings |
| PUT / POST | `/api/classifiers/:id/settings` | Save classifier settings |
| POST | `/api/classifiers/:id/run` | Run against a validated target scope |

Application settings include `libraryPath`, `libraryPaths`, `libraryNames`
(name lists by library path; libraries without names are omitted),
`activeProjectPath`, `projectPaths`, `thumbnailQuality`, `autoStackAnimations`, `autoStackAudio`,
`defaultFps`, and `catalogPaging` (`load-more` or `pages`). These API field names differ from the YAML names in
[Configuration](configuration.md).

By default, a library removed from `libraryPaths` keeps its indexed assets
until the next scan. Send `purgeRemovedLibraries: true` with the update to
delete their index immediately; the response then includes
`removedAssetCount`. That request returns 409 while a scan is running, and
nothing is saved.

Classifier IDs are `bpm`, `sprite`, `pack`, and `folder`. A run body specifies
`targetType` (`all`, `asset`, `directory`, or `archive`), `targetValue` when
needed, and optional `settingsOverride`. For example:

```json
{
  "targetType": "all"
}
```
