# Task list 6 — Media decoding and thumbnail correctness

## Context for the implementer

Repository `REDACTED_LOCAL_PATH`; baseline `972395c`, audited 2026-10-09. `image.ts` supports PNG/JPEG/WebP/GIF/SVG through Sharp, BMP through bmp-js, and an inline TGA decoder. Both disk and ZIP paths call the same buffer processors. `audio.ts` extracts music metadata and creates an SVG-based WebP placeholder; browser waveforms are generated separately by WaveSurfer. Images currently default to 400×400 bounding boxes, audio thumbnails to 400×240, and WebP encoding hardcodes quality 85.

Own `server/src/services/image.ts`, `server/src/services/audio.ts`, media metadata additions in `shared/types.ts`, and focused decoder tests. Task 2 owns archive traversal/cache freshness, Task 3 owns raw HTTP streaming, and Task 8 owns browser preview fallbacks. Preserve the existing processing functions by adding optional parameters or reading the validated settings layer; other packages must not need to change all call sites just to consume this fix.

Read `AGENTS.md`/`CODE_STYLE.md`; backend imports need `.js`. Existing tests `tests/image.test.ts`/`tests/audio.test.ts` mostly assert dimensions/format/metadata, not visual color correctness. Use small generated binary fixtures and inspect decoded pixels with Sharp. Add `tests/mediaPixels.regression.test.ts` for exact channel/orientation cases. Use approximate color assertions for lossy WebP or test the raw conversion separately.

## Refactor-first execution order — F5 normalized media and thumbnail options

Extract only stages that let the supported format paths reuse correctness fixes. Preserve the existing file/buffer processing exports through compatible wrappers or optional parameters.

1. Establish pixel/header/error fixtures, then separate **format validation/decode → normalized pixels and source metadata → resize/encode** where TGA/BMP currently mix these concerns. Fix **M1/M2** in those seams; a small BMP channel correction can land immediately if the extraction is larger. Reuse the validated decoder boundary for **M3** compressed TGA.
2. Centralize **validated thumbnail options and encoder invocation** for **M4** and introduce a documented processor-version/options fingerprint. Publish that minimal contract early for Task 2's I10 cache work; do not make the scanner wait for every format enhancement.
3. Separate **thumbnail-generation provenance from audio parse outcome** for **M5**, then use the shared processing/version contract for **M6** orientation, frame policy, and disk/ZIP consistency checks. Retain useful source-specific metadata; normalization must not erase alpha/orientation/error information.

**Completion gate:** output pixel and malformed-header tests exercise real decoders/encoders, old processing call sites still work, and output-affecting option/version changes alter the freshness fingerprint. Avoid a new decoder-plugin architecture unless the listed fixes actually need one.

## Tasks

- [x] **M1 — P1, reproduced: convert BMP channels correctly.** bmp-js exposes ABGR bytes (confirmed in installed `node_modules/bmp-js/README.md` and `lib/decoder.js`). The code passes them directly to Sharp as RGBA. A hand-built red 1×1 24-bit BMP produced `[0, 0, 0, 255]` in the decoded thumbnail. Reorder channels explicitly and make alpha behavior match the source bit depth/format; ordinary 24-bit BMP must be opaque. Add red, green, blue, white, asymmetric multicolor, row-padding, and top/down orientation fixtures; include meaningful 32-bit alpha if supported. Existing uniform-128 fixture cannot catch this bug.

- [x] **M2 — P1/P2, code-confirmed: validate TGA before allocating or reading.** The decoder reads header fields without a minimum-length check, allocates `width*height*4` before validating dimensions/pixel layout, and substitutes zero for truncated pixel data. It supports only types 2/3, ignores horizontal-origin bit 4, and always reports alpha even for 24-bit opaque source data. Validate header size, ID/color-map offsets, permitted depth/type combinations, dimensions, byte-count arithmetic, and an explicit pixel limit before allocation. Reject truncated/corrupt input with a descriptive processing error instead of producing a plausible image. Correct horizontal/vertical origin mapping and source alpha metadata. Test all four origin orientations with asymmetric pixels and malformed lengths/depths/huge dimensions using small headers.

- [x] **M3 — P2, supported-format gap: handle common compressed TGA deliberately.** README advertises `.tga`, but the custom decoder only accepts uncompressed true-color/grayscale; falling through to standard Sharp does not provide a reliable TGA decoder. Add bounded RLE true-color/grayscale support (types 10/11) using a maintained decoder or a carefully tested local decoder. Reject unsupported color-map/interleaving variants explicitly if they remain out of scope and document the precise supported subset. Test raw and run-length packets, packet boundaries, overrun/truncation, and the same image encoded compressed/uncompressed. Do not add unrelated PSD/3D formats.

- [x] **M4 — P2, code-confirmed: honor configured thumbnail quality consistently.** `thumbnailQuality` is persisted and shown in Settings, but all image/audio `.webp` calls hardcode 85. Route the effective validated quality through every format path, including TGA/BMP and ZIP callers, with compatible defaults. Expose a stable processing-version/settings fingerprint for Task 2 to include in cache freshness; do not require a destructive rescan to apply quality/decoder fixes. Test different quality values with a nontrivial fixture and spies/options assertions; preserve dimensions and output format. Do not assert every tiny image must have a different byte length at different qualities.

- [ ] **M5 — P2, code-confirmed: separate audio placeholder freshness from metadata success.** `audioThumbnailVersion: 4` is added only when metadata parsing yields duration/sample rate, but a placeholder is generated even if parsing fails. Scanner uses that metadata version to decide whether the thumbnail is current, so unsupported/corrupt audio is reprocessed every scan. Put thumbnail-generation provenance on every generated placeholder, distinguish parse failure/partial metadata from a valid zero-duration clip, and retain useful diagnostic information. Keep disk and buffer parsing behavior aligned. Test malformed/truncated audio, metadata-only audio, and unchanged placeholder reuse with a mocked scanner/cache consumer.

- [ ] **M6 — P2, verification gap: make supported previews visually consistent.** Add regression fixtures for EXIF-oriented JPEG, transparent PNG, animated GIF first-frame policy, SVG viewBox sizing, and equivalent disk/ZIP processing. Apply a documented orientation/frame policy and report dimensions consistent with the displayed thumbnail. Keep resource bounds explicit for oversized raster/SVG inputs. Verify that a failed format-specific decode is not silently converted into an unrelated fallback result; preserve useful error context. This is visual correctness coverage, not a new design or thumbnail redesign.

## Acceptance and verification

- [x] BMP primary colors, alpha, and orientation match source pixels; nonuniform fixtures catch channel swaps.
- [x] TGA corruption is rejected before large allocation, supported variants decode consistently, and unsupported variants have explicit errors.
- [ ] Quality settings affect every thumbnail path and provide a non-destructive cache invalidation signal.
- [ ] Audio parse failures generate identifiable placeholders without triggering endless unchanged-file work.
- [ ] Existing supported formats still produce valid WebP output with correct dimensions/orientation.
- [ ] Run `npx vitest run tests/image.test.ts tests/audio.test.ts tests/archive.test.ts tests/mediaPixels.regression.test.ts`, then `npm test` and `npm --prefix client run lint`. Run `npm run build` if shared types changed and server type-check for service changes.

## Execution record

- 2026-10-10, M1: normalized bmp-js ABGR pixels to RGBA, preserved meaningful 32-bit alpha, and bounded dimensions before bmp-js allocation. Added primary-color, padding, orientation, and alpha pixel regressions. Image renderer version 2 invalidates earlier BMP thumbnails through the existing scanner fingerprint. Focused pixels, `npm test` (643 tests), client lint (0 errors; existing warnings), client build, and server type-check passed.
- M4 was delivered earlier in commit `2521e72` with quality-aware processing and versioned fingerprint consumption by scanner and ZIP paths; `tests/processingFingerprint.test.ts` and the full suite passed in this run.
- 2026-10-10, M2: added bounded TGA header/depth/offset validation and normalized all four origin orientations, grayscale, and source alpha. The shared raster encoder now serves BMP and TGA; corrupt TGA is reported as TGA failure without fallback. Image renderer version 3 refreshes prior TGA metadata/thumbnails. Focused pixel and image suites, `npm test` (649 tests), client lint (0 errors; existing warnings), and server type-check passed.
- 2026-10-10, M3: added bounded type 10/11 TGA RLE decoding for true-color and grayscale through the existing origin/alpha mapping. Raw and run packets, 128-pixel boundaries, truncation, overrun, and equivalent compressed/uncompressed output are covered; README states the supported subset. Image renderer version 4 refreshes cached previews. Required focused suite (49 tests), `npm test` (653 tests), client lint (0 errors; existing warnings), client build, and server type-check passed.
