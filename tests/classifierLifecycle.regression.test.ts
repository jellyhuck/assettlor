import fs from 'fs';
import path from 'path';
import bmp from 'bmp-js';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addAssetTags,
  closeDatabase,
  getAssetById,
  getDatabase,
  initDatabase,
  upsertAsset,
} from '../server/src/db/database.js';
import { bpmClassifier } from '../server/src/services/classifiers/bpmClassifier.js';
import { runClassifier } from '../server/src/services/classifiers/engine.js';
import { packClassifier } from '../server/src/services/classifiers/packClassifier.js';
import { spriteClassifier } from '../server/src/services/classifiers/spriteClassifier.js';
import type { Classifier } from '../server/src/services/classifiers/types.js';
import { processImageBuffer } from '../server/src/services/image.js';
import { IMAGE_THUMBNAIL_SPEC } from '../server/src/services/processingFingerprint.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestWavBuffer,
  upsertTaggedAsset,
} from './helpers.js';

describe('Classifier result lifecycle', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('classifier-lifecycle-');
    initDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  function tagSources(assetId: string, tag: string): string[] {
    const rows = getDatabase().prepare(
      'SELECT source FROM tags WHERE asset_id = ? AND tag = ? ORDER BY source'
    ).all(assetId, tag) as { source: string }[];
    return rows.map((row) => row.source);
  }

  /** Write tag rows from before tags were reserved for users, then reopen to migrate them. */
  function seedLegacyTags(rows: [assetId: string, tag: string, source: string][]): void {
    const insert = getDatabase().prepare('INSERT INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');
    for (const row of rows) insert.run(...row);
    closeDatabase();
    initDatabase(tempDir);
  }

  it('clears a no-result pack a legacy generated tag owned while keeping an identical user tag', async () => {
    const filePath = path.join(tempDir, 'loose.png');
    upsertAsset({
      id: 'loose',
      path: 'loose.png',
      absolutePath: filePath,
      name: 'loose.png',
      extension: '.png',
      category: 'image',
      size: 0,
      mtime: 1,
      hash: 'loose-v1',
      isArchiveEntry: false,
      metadata: { pack: 'Old', width: 32 },
    });
    seedLegacyTags([['loose', 'pack:Old', 'classifier:pack'], ['loose', 'pack:Old', 'user']]);
    expect(tagSources('loose', 'pack:Old')).toEqual(['user']);

    const run = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'loose',
    });

    expect(run.details[0].outcome).toBe('no-result');
    expect(run.noResultCount).toBe(1);
    expect(run.errorCount).toBe(0);
    expect(getAssetById('loose')?.metadata).toMatchObject({ width: 32 });
    expect(getAssetById('loose')?.metadata.pack).toBeUndefined();
    expect(tagSources('loose', 'pack:Old')).toEqual(['user']);
    expect(getAssetById('loose')?.tags).toContain('pack:Old');
  });

  it('keeps an embedded pack value when no classifier result owns it', async () => {
    upsertAsset({
      id: 'embedded',
      path: 'loose.png',
      absolutePath: path.join(tempDir, 'loose.png'),
      name: 'loose.png',
      extension: '.png',
      category: 'image',
      size: 0,
      mtime: 1,
      hash: 'embedded-v1',
      isArchiveEntry: false,
      metadata: { pack: 'Embedded' },
    });

    const run = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'embedded',
    });

    expect(run.details[0].outcome).toBe('no-result');
    expect(getAssetById('embedded')?.metadata.pack).toBe('Embedded');
  });

  it('records a classified pack in metadata without writing tags', async () => {
    const filePath = path.join(tempDir, 'Fantasy', 'item.png');
    upsertTaggedAsset({
      id: 'item',
      path: 'Fantasy/item.png',
      absolutePath: filePath,
      name: 'item.png',
      extension: '.png',
      category: 'image',
      size: 0,
      mtime: 1,
      hash: 'item-v1',
      isArchiveEntry: false,
      metadata: { pack: 'Old' },
      tags: ['curated'],
    });

    const run = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'item',
    });
    expect(run.details[0].outcome).toBe('classified');
    expect(getAssetById('item')?.metadata.pack).toBe('Fantasy');
    expect(getAssetById('item')?.tags).toEqual(['curated']);
    expect(tagSources('item', 'curated')).toEqual(['user']);
  });

  it('clears old BPM results when a duration threshold makes analysis ineligible', async () => {
    const filePath = path.join(tempDir, 'short.wav');
    const wav = createTestWavBuffer(0.2);
    fs.writeFileSync(filePath, wav);
    upsertAsset({
      id: 'short',
      path: 'short.wav',
      absolutePath: filePath,
      name: 'short.wav',
      extension: '.wav',
      category: 'audio',
      size: wav.length,
      mtime: 1,
      hash: 'short-v1',
      isArchiveEntry: false,
      metadata: { bpm: 128, tempoDescription: 'fast-tempo', duration: 0.2 },
    });
    seedLegacyTags([['short', 'bpm:128', 'classifier:bpm'], ['short', 'favorite', 'user']]);

    const run = await runClassifier(bpmClassifier, {
      targetType: 'asset',
      targetValue: 'short',
      settingsOverride: { minDurationSeconds: 1 },
    });

    expect(run.details[0].outcome).toBe('no-result');
    expect(run.details[0].retryable).not.toBe(true);
    expect(getAssetById('short')?.metadata.bpm).toBeUndefined();
    expect(getAssetById('short')?.metadata.tempoDescription).toBeUndefined();
    expect(getAssetById('short')?.metadata.duration).toBe(0.2);
    expect(tagSources('short', 'bpm:128')).toEqual([]);
    expect(tagSources('short', 'favorite')).toEqual(['user']);
  });

  it('preserves embedded BPM metadata when no classifier result owns it', async () => {
    const filePath = path.join(tempDir, 'embedded.wav');
    const wav = createTestWavBuffer(0.2);
    fs.writeFileSync(filePath, wav);
    upsertAsset({
      id: 'embedded-bpm',
      path: 'embedded.wav',
      absolutePath: filePath,
      name: 'embedded.wav',
      extension: '.wav',
      category: 'audio',
      size: wav.length,
      mtime: 1,
      hash: 'embedded-bpm-v1',
      isArchiveEntry: false,
      metadata: { bpm: 74, tempoDescription: 'slow-tempo', duration: 0.2 },
    });

    const run = await runClassifier(bpmClassifier, {
      targetType: 'asset',
      targetValue: 'embedded-bpm',
      settingsOverride: { minDurationSeconds: 1 },
    });

    expect(run.details[0].outcome).toBe('no-result');
    expect(getAssetById('embedded-bpm')?.metadata).toMatchObject({
      bpm: 74,
      tempoDescription: 'slow-tempo',
      duration: 0.2,
    });
  });

  it('preserves prior BPM data and marks it stale on a transient file error', async () => {
    const missingPath = path.join(tempDir, 'missing.wav');
    upsertAsset({
      id: 'missing',
      path: 'missing.wav',
      absolutePath: missingPath,
      name: 'missing.wav',
      extension: '.wav',
      category: 'audio',
      size: 100,
      mtime: 1,
      hash: 'missing-v1',
      isArchiveEntry: false,
      metadata: { bpm: 120, tempoDescription: 'fast-tempo' },
    });

    const run = await runClassifier(bpmClassifier, {
      targetType: 'asset',
      targetValue: 'missing',
    });

    expect(run.errorCount).toBe(1);
    expect(run.noResultCount).toBe(0);
    expect(run.details[0]).toMatchObject({ outcome: 'error', stale: true, retryable: true });
    expect(getAssetById('missing')?.metadata).toMatchObject({
      bpm: 120,
      tempoDescription: 'fast-tempo',
    });
    expect(getAssetById('missing')?.tags).toEqual([]);
  });

  it('infers a pack from its source root without reading a missing media file', async () => {
    const sourceRoot = path.join(tempDir, 'source-library');
    upsertAsset({
      id: 'path-only',
      path: 'Library Label/Fantasy/items/gem.png',
      absolutePath: path.join(sourceRoot, 'Fantasy', 'items', 'gem.png'),
      sourceDirectory: sourceRoot,
      name: 'gem.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 1,
      hash: 'path-only-v1',
      isArchiveEntry: false,
    });

    const run = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'path-only',
    });

    expect(fs.existsSync(path.join(sourceRoot, 'Fantasy', 'items', 'gem.png'))).toBe(false);
    expect(run.details[0].outcome).toBe('classified');
    expect(run.details[0].result?.pack).toBe('Fantasy');
    expect(getAssetById('path-only')?.metadata.pack).toBe('Fantasy');
  });

  it('keeps a user sprite tag when a stricter confidence threshold yields no result', async () => {
    const fixturePath = path.resolve('sample/assets/characters/knight/Knight_Walk_01.png');
    const filePath = path.join(tempDir, 'Knight_Walk_01.png');
    const png = fs.readFileSync(fixturePath);
    fs.writeFileSync(filePath, png);
    upsertAsset({
      id: 'sprite',
      path: 'characters/knight/Knight_Walk_01.png',
      absolutePath: filePath,
      name: 'Knight_Walk_01.png',
      extension: '.png',
      category: 'image',
      size: png.length,
      mtime: 1,
      hash: 'sprite-v1',
      isArchiveEntry: false,
      metadata: { width: 64, height: 64 },
    });

    const first = await runClassifier(spriteClassifier, {
      targetType: 'asset',
      targetValue: 'sprite',
    });
    expect(first.details[0].outcome).toBe('classified');
    expect(getAssetById('sprite')?.metadata.spriteType).toBe('character');
    expect(getAssetById('sprite')?.tags).toEqual([]);
    addAssetTags('sprite', ['sprite:character']);

    const second = await runClassifier(spriteClassifier, {
      targetType: 'asset',
      targetValue: 'sprite',
      settingsOverride: { minConfidence: 1 },
    });

    expect(second.details[0].outcome).toBe('no-result');
    expect(second.noResultCount).toBe(1);
    expect(getAssetById('sprite')?.metadata.spriteType).not.toBe('character');
    expect(tagSources('sprite', 'sprite:character')).toEqual(['user']);
  });

  it('extracts equivalent visual features from PNG, BMP, and TGA images', async () => {
    const width = 32;
    const height = 32;
    const rgba = Buffer.alloc(width * height * 4);
    const bmpAbgr = Buffer.alloc(width * height * 4);
    const tgaPixels = Buffer.alloc(width * height * 3);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const rgbaOffset = (y * width + x) * 4;
        const tgaOffset = (y * width + x) * 3;
        const red = (x * 7) & 255;
        const green = (y * 7) & 255;
        const blue = ((x + y) * 3) & 255;
        rgba[rgbaOffset] = red;
        rgba[rgbaOffset + 1] = green;
        rgba[rgbaOffset + 2] = blue;
        rgba[rgbaOffset + 3] = 255;
        // bmp-js accepts ABGR input and encodes 24-bit BGR pixels.
        bmpAbgr[rgbaOffset] = 255;
        bmpAbgr[rgbaOffset + 1] = blue;
        bmpAbgr[rgbaOffset + 2] = green;
        bmpAbgr[rgbaOffset + 3] = red;
        tgaPixels[tgaOffset] = blue;
        tgaPixels[tgaOffset + 1] = green;
        tgaPixels[tgaOffset + 2] = red;
      }
    }
    const tgaHeader = Buffer.alloc(18);
    tgaHeader[2] = 2;
    tgaHeader.writeUInt16LE(width, 12);
    tgaHeader.writeUInt16LE(height, 14);
    tgaHeader[16] = 24;
    tgaHeader[17] = 0x20;
    const png = await sharp(rgba, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const formats = [
      { extension: '.png', buffer: png },
      { extension: '.bmp', buffer: bmp.encode({ data: bmpAbgr, width, height }).data },
      { extension: '.tga', buffer: Buffer.concat([tgaHeader, tgaPixels]) },
    ];
    const visualStep = spriteClassifier.steps.find((step) => step.id === 'analyze-visual-features');
    expect(visualStep).toBeDefined();
    const scores = [];
    const normalizedPixels: Buffer[] = [];

    for (const format of formats) {
      const id = format.extension.slice(1);
      upsertAsset({
        id,
        path: `solid${format.extension}`,
        absolutePath: path.join(tempDir, `solid${format.extension}`),
        name: `solid${format.extension}`,
        extension: format.extension,
        category: 'image',
        size: format.buffer.length,
        mtime: 1,
        hash: id,
        isArchiveEntry: false,
      });
      const asset = getAssetById(id)!;
      const intermediate = spriteClassifier.createIntermediateState(asset, spriteClassifier.defaultSettings);
      await visualStep!.execute({
        asset,
        buffer: format.buffer,
        settings: spriteClassifier.defaultSettings,
        intermediate,
      });
      expect(intermediate.error).toBeUndefined();
      expect(intermediate.visualScores).toBeDefined();
      scores.push(intermediate.visualScores);

      const normalized = await processImageBuffer(format.buffer, format.extension);
      normalizedPixels.push(await sharp(normalized.thumbnailBuffer).removeAlpha().raw().toBuffer());
    }

    expect(scores[1]).toEqual(scores[0]);
    expect(scores[2]).toEqual(scores[0]);
    for (const pixels of normalizedPixels.slice(1)) {
      const meanDifference = pixels.reduce((sum, channel, index) =>
        sum + Math.abs(channel - normalizedPixels[0][index]), 0) / pixels.length;
      expect(meanDifference).toBeLessThan(5);
    }
  });

  it('normalizes a large image to bounded pixels before sprite analysis', async () => {
    const width = 1600;
    const height = 1200;
    const png = await sharp({
      create: { width, height, channels: 4, background: { r: 128, g: 0, b: 255, alpha: 1 } },
    }).png().toBuffer();
    const normalized = await processImageBuffer(png, '.png');
    const thumbnail = await sharp(normalized.thumbnailBuffer).metadata();
    expect(thumbnail.width).toBeLessThanOrEqual(IMAGE_THUMBNAIL_SPEC.width);
    expect(thumbnail.height).toBeLessThanOrEqual(IMAGE_THUMBNAIL_SPEC.height);

    upsertAsset({
      id: 'large',
      path: 'large.png',
      absolutePath: path.join(tempDir, 'large.png'),
      name: 'large.png',
      extension: '.png',
      category: 'image',
      size: png.length,
      mtime: 1,
      hash: 'large-v1',
      isArchiveEntry: false,
    });
    const asset = getAssetById('large')!;
    const intermediate = spriteClassifier.createIntermediateState(asset, spriteClassifier.defaultSettings);
    const visualStep = spriteClassifier.steps.find((step) => step.id === 'analyze-visual-features');
    await visualStep!.execute({
      asset,
      buffer: png,
      settings: spriteClassifier.defaultSettings,
      intermediate,
    });
    expect(intermediate.error).toBeUndefined();
    expect(intermediate.visualScores).toBeDefined();
  });

  it('does not persist a delayed result over a newer indexed asset revision', async () => {
    const sourceRoot = path.join(tempDir, 'source-library');
    const filePath = path.join(sourceRoot, 'Old', 'item.png');
    upsertAsset({
      id: 'changing',
      path: 'Old/item.png',
      absolutePath: filePath,
      sourceDirectory: sourceRoot,
      name: 'item.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 1,
      hash: 'revision-1',
      isArchiveEntry: false,
    });

    let release!: () => void;
    let signalStarted!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const delayedClassifier: Classifier = {
      ...packClassifier,
      steps: [
        {
          id: 'hold',
          name: 'Hold analysis',
          description: 'Allows a concurrent reindex before classification completes.',
          execute: async () => {
            signalStarted();
            await held;
          },
        },
        ...packClassifier.steps,
      ],
    };

    const pending = runClassifier(delayedClassifier, {
      targetType: 'asset',
      targetValue: 'changing',
    });
    await started;
    upsertAsset({
      id: 'changing',
      path: 'New/item.png',
      absolutePath: path.join(sourceRoot, 'New', 'item.png'),
      sourceDirectory: sourceRoot,
      name: 'item.png',
      extension: '.png',
      category: 'image',
      size: 200,
      mtime: 2,
      hash: 'revision-2',
      isArchiveEntry: false,
      metadata: { pack: 'New' },
    });
    release();
    const run = await pending;

    expect(run.details[0]).toMatchObject({ outcome: 'error', stale: true });
    expect(getAssetById('changing')?.path).toBe('New/item.png');
    expect(getAssetById('changing')?.metadata.pack).toBe('New');
  });
});
