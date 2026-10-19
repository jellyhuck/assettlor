import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  closeDatabase,
  upsertAsset,
  getAssetById,
  saveClassifierSettings,
  queryAssets,
} from '../server/src/db/database.js';
import { compileFilterExpression } from '../server/src/services/filterParser.js';
import {
  spriteClassifier,
  DEFAULT_SPRITE_SETTINGS,
} from '../server/src/services/classifiers/spriteClassifier.js';
import {
  getAllClassifiers,
  getClassifier,
  getClassifierInfo,
} from '../server/src/services/classifiers/registry.js';
import { runClassifier } from '../server/src/services/classifiers/engine.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

describe('Sprite Classifier Subsystem (Todo #5)', () => {
  let tempLibraryDir: string;
  const sampleAssetsDir = path.resolve(__dirname, '../sample/assets');

  beforeEach(() => {
    tempLibraryDir = createTempDir('sprite-classifier-test-');
    initDatabase(tempLibraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempLibraryDir);
  });

  describe('Sprite Classifier Structure & Registration', () => {
    it('should be registered in registry with id "sprite"', () => {
      const classifiers = getAllClassifiers();
      expect(classifiers.some((c) => c.id === 'sprite')).toBe(true);

      const sprite = getClassifier('sprite');
      expect(sprite).toBeDefined();
      expect(sprite?.id).toBe('sprite');
      expect(sprite?.category).toBe('image');
      expect(sprite?.name).toBe('Sprite Classifier');
    });

    it('should declare 5 sequential pipeline steps', () => {
      expect(spriteClassifier.steps.length).toBe(5);
      expect(spriteClassifier.steps.map((s) => s.id)).toEqual([
        'probe-image',
        'analyze-visual-features',
        'analyze-context-signals',
        'score-classification',
        'persist-metadata',
      ]);
    });

    it('should return valid classifier info with default settings', () => {
      const info = getClassifierInfo(spriteClassifier);
      expect(info.id).toBe('sprite');
      expect(info.category).toBe('image');
      expect(info.steps.length).toBe(5);
      expect((info.settings as any).minConfidence).toBe(DEFAULT_SPRITE_SETTINGS.minConfidence);
      expect((info.settings as any).enableVisualAnalysis).toBe(true);
    });
  });

  describe('Sprite Classification on Sample Assets', () => {
    it('should classify character sprite (Knight_Walk_01.png)', async () => {
      const knightPath = path.join(sampleAssetsDir, 'characters/knight/Knight_Walk_01.png');
      const buffer = fs.readFileSync(knightPath);
      const testPath = path.join(tempLibraryDir, 'Knight_Walk_01.png');
      fs.writeFileSync(testPath, buffer);

      upsertAsset({
        id: 'asset_knight',
        path: 'characters/knight/Knight_Walk_01.png',
        absolutePath: testPath,
        name: 'Knight_Walk_01.png',
        extension: '.png',
        category: 'image',
        size: buffer.length,
        mtime: Date.now(),
        hash: 'hash_knight',
        isArchiveEntry: false,
        metadata: { width: 64, height: 64 },
      });

      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_knight',
      });

      expect(res.totalTargeted).toBe(1);
      expect(res.processedCount).toBe(1);
      expect(res.classifiedCount).toBe(1);

      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('character');
      expect(detail.result?.confidence).toBeGreaterThanOrEqual(0.5);

      const updated = getAssetById('asset_knight');
      expect(updated?.metadata.spriteType).toBe('character');
      expect(updated?.metadata.spriteConfidence).toBeGreaterThanOrEqual(0.5);
      expect(updated?.tags).toEqual([]);
    });

    it('should classify object sprite (Coin_Spin_01.png)', async () => {
      const coinPath = path.join(sampleAssetsDir, 'items/coins/Coin_Spin_01.png');
      const buffer = fs.readFileSync(coinPath);
      const testPath = path.join(tempLibraryDir, 'Coin_Spin_01.png');
      fs.writeFileSync(testPath, buffer);

      upsertAsset({
        id: 'asset_coin',
        path: 'items/coins/Coin_Spin_01.png',
        absolutePath: testPath,
        name: 'Coin_Spin_01.png',
        extension: '.png',
        category: 'image',
        size: buffer.length,
        mtime: Date.now(),
        hash: 'hash_coin',
        isArchiveEntry: false,
        metadata: { width: 32, height: 32 },
      });

      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_coin',
      });

      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('object');
      expect(detail.result?.confidence).toBeGreaterThanOrEqual(0.5);

      const updated = getAssetById('asset_coin');
      expect(updated?.metadata.spriteType).toBe('object');
      expect(updated?.tags).toEqual([]);
    });

    it('should classify background image (dungeon_background.jpg)', async () => {
      const bgPath = path.join(sampleAssetsDir, 'environment/dungeon_background.jpg');
      const buffer = fs.readFileSync(bgPath);
      const testPath = path.join(tempLibraryDir, 'dungeon_background.jpg');
      fs.writeFileSync(testPath, buffer);

      upsertAsset({
        id: 'asset_bg',
        path: 'environment/dungeon_background.jpg',
        absolutePath: testPath,
        name: 'dungeon_background.jpg',
        extension: '.jpg',
        category: 'image',
        size: buffer.length,
        mtime: Date.now(),
        hash: 'hash_bg',
        isArchiveEntry: false,
        metadata: { width: 480, height: 270 },
      });

      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_bg',
      });

      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('background');
      expect(detail.result?.confidence).toBeGreaterThanOrEqual(0.5);

      const updated = getAssetById('asset_bg');
      expect(updated?.metadata.spriteType).toBe('background');
      expect(updated?.tags).toEqual([]);
    });

    it('should classify texture / tile (stone_brick_tile.tga)', async () => {
      const tilePath = path.join(sampleAssetsDir, 'environment/stone_brick_tile.tga');
      const buffer = fs.readFileSync(tilePath);
      const testPath = path.join(tempLibraryDir, 'stone_brick_tile.tga');
      fs.writeFileSync(testPath, buffer);

      upsertAsset({
        id: 'asset_tile',
        path: 'environment/stone_brick_tile.tga',
        absolutePath: testPath,
        name: 'stone_brick_tile.tga',
        extension: '.tga',
        category: 'image',
        size: buffer.length,
        mtime: Date.now(),
        hash: 'hash_tile',
        isArchiveEntry: false,
        metadata: { width: 64, height: 64 },
      });

      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_tile',
      });

      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('texture');
      expect(detail.result?.confidence).toBeGreaterThanOrEqual(0.5);

      const updated = getAssetById('asset_tile');
      expect(updated?.metadata.spriteType).toBe('texture');
      expect(updated?.tags).toEqual([]);
    });
  });

  describe('Fallback to sprite:unclassified', () => {
    it('should mark asset as unclassified when confidence < minConfidence', async () => {
      const testPath = path.join(tempLibraryDir, 'unknown_123.png');
      fs.writeFileSync(testPath, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'asset_unknown',
        path: 'raw_dump/unknown_123.png',
        absolutePath: testPath,
        name: 'unknown_123.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_unknown',
        isArchiveEntry: false,
        metadata: { width: 1, height: 1 },
      });

      // Override minConfidence to a very high bar (0.95)
      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_unknown',
        settingsOverride: { minConfidence: 0.95 },
      });

      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('unclassified');

      const updated = getAssetById('asset_unknown');
      expect(updated?.metadata.spriteType).toBe('unclassified');
      expect(updated?.tags).toEqual([]);
    });
  });

  describe('Virtual Zip Archive Assets & Progress Reporting', () => {
    it('should classify image files inside virtual zip archives', async () => {
      const knightPath = path.join(sampleAssetsDir, 'characters/knight/Knight_Walk_01.png');
      const knightBuffer = fs.readFileSync(knightPath);

      const zipPath = path.join(tempLibraryDir, 'Packs.zip');
      createTestZipArchive(zipPath, [
        { name: 'sprites/hero_jump.png', content: knightBuffer },
      ]);

      upsertAsset({
        id: 'asset_zip_hero',
        path: 'Packs.zip#/sprites/hero_jump.png',
        absolutePath: `${zipPath}#/sprites/hero_jump.png`,
        name: 'hero_jump.png',
        extension: '.png',
        category: 'image',
        size: knightBuffer.length,
        mtime: Date.now(),
        hash: 'hash_zip_hero',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'sprites/hero_jump.png',
        metadata: { width: 64, height: 64 },
      });

      const res = await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_zip_hero',
      });

      expect(res.processedCount).toBe(1);
      const detail = res.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.spriteType).toBe('character');
    });

    it('should trigger progress callbacks across all 5 steps', async () => {
      const knightPath = path.join(sampleAssetsDir, 'characters/knight/Knight_Walk_01.png');
      const testPath = path.join(tempLibraryDir, 'progress_knight.png');
      fs.writeFileSync(testPath, fs.readFileSync(knightPath));

      upsertAsset({
        id: 'asset_progress',
        path: 'progress_knight.png',
        absolutePath: testPath,
        name: 'progress_knight.png',
        extension: '.png',
        category: 'image',
        size: 500,
        mtime: Date.now(),
        hash: 'hash_prog',
        isArchiveEntry: false,
      });

      const progressEvents: any[] = [];
      await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_progress',
        onProgress: (p) => progressEvents.push(p),
      });

      expect(progressEvents.length).toBe(5);
      expect(progressEvents[0].stepName).toBe('Validate Image Buffer');
      expect(progressEvents[4].stepName).toBe('Persist Metadata');
      expect(progressEvents[4].stepIndex).toBe(5);
      expect(progressEvents[4].totalSteps).toBe(5);
    });

    it('should not assign tags and make labels accessible via sprite: search keyword', async () => {
      const knightPath = path.join(sampleAssetsDir, 'characters/knight/Knight_Walk_01.png');
      const testPath = path.join(tempLibraryDir, 'search_knight.png');
      fs.writeFileSync(testPath, fs.readFileSync(knightPath));

      upsertAsset({
        id: 'asset_search_test',
        path: 'sprites/search_knight.png',
        absolutePath: testPath,
        name: 'search_knight.png',
        extension: '.png',
        category: 'image',
        size: 500,
        mtime: Date.now(),
        hash: 'hash_search_test',
        isArchiveEntry: false,
      });

      await runClassifier(spriteClassifier, {
        targetType: 'asset',
        targetValue: 'asset_search_test',
      });

      const updated = getAssetById('asset_search_test');
      expect(updated?.metadata.spriteType).toBe('character');
      // No tags should be assigned
      expect(updated?.tags).toEqual([]);

      // Label is accessible via sprite: search keyword
      const spriteQuery = queryAssets({ sprite: 'character' });
      expect(spriteQuery.items.some((item) => item.id === 'asset_search_test')).toBe(true);

      const filterResult = compileFilterExpression('sprite:character', false);
      expect(filterResult.isParsed).toBe(true);
      expect(filterResult.sql).toContain("LOWER(json_extract(a.metadata, '$.spriteType')) = ?");
    });
  });
});
