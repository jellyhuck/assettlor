import fs from 'fs';
import path from 'path';
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
import {
  cleanupTempDir,
  createTempDir,
  createTestWavBuffer,
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

  it('clears a no-result pack and its generated tag while keeping an identical user tag', async () => {
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
      tags: [
        { tag: 'pack:Old', source: 'classifier:pack' },
        { tag: 'pack:Old', source: 'user' },
      ],
    });

    const run = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'loose',
      settingsOverride: { applyTag: false },
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

  it('replaces generated tags when the prefix changes and tagging is disabled', async () => {
    const filePath = path.join(tempDir, 'Fantasy', 'item.png');
    upsertAsset({
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
      tags: [
        { tag: 'old-pack:Old', source: 'classifier:pack' },
        { tag: 'curated', source: 'user' },
      ],
    });

    const tagged = await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'item',
      settingsOverride: { applyTag: true, tagPrefix: 'new-pack:' },
    });
    expect(tagged.details[0].outcome).toBe('classified');
    expect(tagSources('item', 'old-pack:Old')).toEqual([]);
    expect(tagSources('item', 'new-pack:Fantasy')).toEqual(['classifier:pack']);

    await runClassifier(packClassifier, {
      targetType: 'asset',
      targetValue: 'item',
      settingsOverride: { applyTag: false },
    });
    expect(tagSources('item', 'new-pack:Fantasy')).toEqual([]);
    expect(tagSources('item', 'curated')).toEqual(['user']);
    expect(getAssetById('item')?.metadata.pack).toBe('Fantasy');
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
      tags: [
        { tag: 'bpm:128', source: 'classifier:bpm' },
        { tag: 'favorite', source: 'user' },
      ],
    });

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
      tags: [{ tag: 'bpm:120', source: 'classifier:bpm' }],
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
    expect(tagSources('missing', 'bpm:120')).toEqual(['classifier:bpm']);
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

  it('removes an obsolete sprite tag when a stricter confidence threshold yields no result', async () => {
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
      settingsOverride: { applySpriteTag: true },
    });
    expect(first.details[0].outcome).toBe('classified');
    expect(getAssetById('sprite')?.metadata.spriteType).toBe('character');
    expect(tagSources('sprite', 'sprite:character')).toEqual(['classifier:sprite']);
    addAssetTags('sprite', ['sprite:character']);

    const second = await runClassifier(spriteClassifier, {
      targetType: 'asset',
      targetValue: 'sprite',
      settingsOverride: { minConfidence: 1, applySpriteTag: false },
    });

    expect(second.details[0].outcome).toBe('no-result');
    expect(second.noResultCount).toBe(1);
    expect(getAssetById('sprite')?.metadata.spriteType).not.toBe('character');
    expect(tagSources('sprite', 'sprite:character')).toEqual(['user']);
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
