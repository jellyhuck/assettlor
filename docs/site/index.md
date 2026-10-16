---
title: Assettlor documentation
---

# Assettlor documentation

Assettlor indexes local images and audio, including files inside ZIP archives,
so you can search, preview, tag, and copy assets into your projects. Its React
interface talks to a local Fastify server; the catalog and thumbnails stay on
your machine.

![Assettlor asset catalog overview](screenshots/overview.png)

## Guides

| Guide | What you will find |
|---|---|
| [Getting started](getting-started.md) | Install, launch, and index your first library |
| [Using Assettlor](usage.md) | Search, previews, stacks, classifiers, and copying |
| [Configuration](configuration.md) | Library paths, storage, server, and pipeline settings |
| [API reference](api.md) | REST endpoints, scan events, and request examples |
| [Development](development.md) | Architecture, local development, and verification |
| [Publishing documentation](publishing.md) | Markdown authoring and the GitHub Pages workflow |

## Supported media

| Category | Extensions |
|---|---|
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.gif`, `.tga`, `.svg` |
| Audio | `.wav`, `.mp3`, `.ogg`, `.flac` |
| Archives | `.zip` |

ZIP entries use virtual paths such as `RetroPack.zip#/sprites/hero.png` and
are read in memory without extracting the library to disk. Assettlor generates
WebP thumbnails and groups matching animation frames and audio variations.

Image decoding is limited to 16 million pixels. Thumbnails apply EXIF
orientation, preserve transparency, and use the first frame of animated images.
TGA previews support uncompressed and RLE true-color or grayscale images;
color-mapped and interleaved variants are unsupported.

[Source repository](https://github.com/jellyhuck/assettlor)
