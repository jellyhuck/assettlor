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
| [Development](development.md) | Architecture, local development, verification, and documentation publishing |

## Supported media

| Category | Extensions |
|---|---|
| Images | `.png`, `.jpg`, `.jpeg`, `.webp`, `.bmp`, `.gif`, `.tga`, `.svg` |
| Audio | `.wav`, `.mp3`, `.ogg`, `.flac` |
| 3D models | `.glb` (binary glTF 2.0) |
| Archives | `.zip` |

ZIP entries use virtual paths such as `RetroPack.zip#/sprites/hero.png` and
are read in place without extracting the library to disk. Assettlor generates
WebP thumbnails and groups matching animation frames and audio variations.

Image decoding is limited to 16 million pixels. Thumbnails apply EXIF
orientation, preserve transparency, and use the first frame of animated images.
TGA previews support uncompressed and RLE true-color or grayscale images;
color-mapped and interleaved variants are unsupported.

GLB thumbnails are rendered on the CPU from the model's default scene:
flat-shaded geometry in its base colors (tinted by the average color of each
base-color texture), seen from the front right. Draco-compressed geometry,
buffers stored outside the file, and models over 256 MB keep their statistics
but get a placeholder thumbnail, and the inspector notes why. The inspector's
three.js viewer decodes meshopt compression but not Draco geometry or KTX2
textures. Multi-file `.gltf` models are not indexed.

[Source repository](https://github.com/jellyhuck/assettlor)
