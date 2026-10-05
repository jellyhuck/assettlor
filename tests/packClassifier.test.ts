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
  packClassifier,
  DEFAULT_PACK_SETTINGS,
  extractArchiveBaseName,
  extractDirectoryCandidate,
  normalizePackName,
} from '../server/src/services/classifiers/packClassifier.js';
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

describe('Pack Classifier Subsystem (Todo #6)', () => {
  let tempLibraryDir: string;

  beforeEach(() => {
    tempLibraryDir = createTempDir('pack-classifier-test-');
    initDatabase(tempLibraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempLibraryDir);
  });

  describe('Pack Classifier Structure & Registration', () => {
    it('should be registered in registry with id "pack"', () => {
      const classifiers = getAllClassifiers();
      expect(classifiers.some((c) => c.id === 'pack')).toBe(true);

      const pack = getClassifier('pack');
      expect(pack).toBeDefined();
      expect(pack?.id).toBe('pack');
      expect(pack?.category).toBe('general');
      expect(pack?.name).toBe('Pack Classifier');
    });

    it('should declare 4 sequential pipeline steps', () => {
      expect(packClassifier.steps.length).toBe(4);
      expect(packClassifier.steps.map((s) => s.id)).toEqual([
        'probe-source',
        'extract-name',
        'normalize-name',
        'persist-metadata',
      ]);
    });

    it('should return valid classifier info with default settings', () => {
      const info = getClassifierInfo(packClassifier);
      expect(info.id).toBe('pack');
      expect(info.name).toBe('Pack Classifier');
      expect(info.steps.length).toBe(4);
      expect(info.settings).toMatchObject({
        enabled: true,
        inferFromArchive: true,
        inferFromDirectory: true,
        directoryStrategy: 'top',
        directoryDepth: 1,
        cleanSeparators: true,
        stripVersionSuffix: true,
        stripAffixes: false,
        applyTag: true,
        tagPrefix: 'pack:',
      });
    });
  });

  describe('Helper Functions Unit Tests', () => {
    it('extractArchiveBaseName should correctly isolate archive basename', () => {
      expect(extractArchiveBaseName('RetroPack.zip')).toBe('RetroPack');
      expect(extractArchiveBaseName('RetroPack.zip#/sprites/hero.png')).toBe('RetroPack');
      expect(extractArchiveBaseName('path/to/Packs/SciFi_Tiles.zip#/floor.png')).toBe('SciFi_Tiles');
      expect(extractArchiveBaseName('Packs/FantasyMedieval.tar.gz')).toBe('FantasyMedieval.tar');
      expect(extractArchiveBaseName('')).toBe('');
    });

    it('extractDirectoryCandidate should resolve directory based on chosen strategy', () => {
      // Top strategy (default depth 1)
      expect(extractDirectoryCandidate('Packs/SciFi/weapons/laser.wav', 'top', 1)).toBe('Packs');
      expect(extractDirectoryCandidate('Packs/SciFi/weapons/laser.wav', 'top', 2)).toBe('SciFi');
      expect(extractDirectoryCandidate('Packs/SciFi/weapons/laser.wav', 'top', 3)).toBe('weapons');

      // Enclosing strategy
      expect(extractDirectoryCandidate('Packs/SciFi/weapons/laser.wav', 'enclosing')).toBe('weapons');
      expect(extractDirectoryCandidate('FantasyPack/hero.png', 'enclosing')).toBe('FantasyPack');

      // Pattern strategy: prefers segment with 'pack'/'bundle'/'set' keyword
      expect(extractDirectoryCandidate('assets/FantasyPack/items/sword.png', 'pattern')).toBe('FantasyPack');
      expect(extractDirectoryCandidate('packs/SciFiAssets/laser.wav', 'pattern')).toBe('SciFiAssets');
      expect(extractDirectoryCandidate('packs/Dungeon/tiles/floor.png', 'pattern')).toBe('Dungeon');

      // Root level file returns null
      expect(extractDirectoryCandidate('icon.png', 'top', 1)).toBeNull();
      // Virtual archive path returns null
      expect(extractDirectoryCandidate('Pack.zip#/hero.png', 'top', 1)).toBeNull();
    });

    it('normalizePackName should format separators, strip versions, and handle casing', () => {
      // Version suffix stripping
      expect(normalizePackName('Retro_Pack_v1.0', { stripVersionSuffix: true, cleanSeparators: true })).toBe('Retro Pack');
      expect(normalizePackName('Fantasy-Pack-v2', { stripVersionSuffix: true, cleanSeparators: true })).toBe('Fantasy Pack');
      expect(normalizePackName('SciFi_Pack_1.2.3', { stripVersionSuffix: true, cleanSeparators: true })).toBe('SciFi Pack');

      // Preserving original version if disabled
      expect(normalizePackName('Retro_Pack_v1.0', { stripVersionSuffix: false, cleanSeparators: false })).toBe('Retro_Pack_v1.0');

      // Separators
      expect(normalizePackName('dungeon_crawler_pack', { cleanSeparators: true })).toBe('dungeon crawler pack');
      expect(normalizePackName('pixel-art-characters', { cleanSeparators: true })).toBe('pixel art characters');

      // Affix stripping
      expect(normalizePackName('RetroPack', { stripAffixes: true })).toBe('Retro');
      expect(normalizePackName('Fantasy_Asset_Pack', { stripAffixes: true, cleanSeparators: true })).toBe('Fantasy');
      expect(normalizePackName('RetroPack', { stripAffixes: false })).toBe('RetroPack');

      // Casing conventions
      expect(normalizePackName('retro_pack', { cleanSeparators: true, caseConvention: 'as-is' })).toBe('retro pack');
      expect(normalizePackName('retro_pack', { cleanSeparators: true, caseConvention: 'title' })).toBe('Retro Pack');
      expect(normalizePackName('Retro_Pack', { cleanSeparators: true, caseConvention: 'lower' })).toBe('retro pack');
      expect(normalizePackName('retro_pack', { cleanSeparators: true, caseConvention: 'upper' })).toBe('RETRO PACK');
    });
  });

  describe('Archive-Based Pack Classification', () => {
    it('should classify assets inside virtual zip archives and apply metadata & tag', async () => {
      const zipPath = path.join(tempLibraryDir, 'RetroPack.zip');
      createTestZipArchive(zipPath, [
        { name: 'sprites/hero_01.png', content: TINY_PNG_BUFFER },
        { name: 'sprites/hero_02.png', content: TINY_PNG_BUFFER },
      ]);

      const virtualPath1 = 'RetroPack.zip#/sprites/hero_01.png';
      const virtualPath2 = 'RetroPack.zip#/sprites/hero_02.png';

      upsertAsset({
        id: 'asset_zip_1',
        path: virtualPath1,
        absolutePath: zipPath,
        name: 'hero_01.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_zip_1',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'sprites/hero_01.png',
        tags: [{ tag: 'RetroPack', source: 'archive' }],
      });

      upsertAsset({
        id: 'asset_zip_2',
        path: virtualPath2,
        absolutePath: zipPath,
        name: 'hero_02.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_zip_2',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'sprites/hero_02.png',
        tags: [{ tag: 'RetroPack', source: 'archive' }],
      });

      const runRes = await runClassifier(packClassifier, {
        targetType: 'all',
      });

      expect(runRes.classifiedCount).toBe(2);
      expect(runRes.failedCount).toBe(0);

      const asset1 = getAssetById('asset_zip_1');
      expect(asset1?.metadata.pack).toBe('RetroPack');
      expect(asset1?.tags).toContain('pack:RetroPack');

      const asset2 = getAssetById('asset_zip_2');
      expect(asset2?.metadata.pack).toBe('RetroPack');
      expect(asset2?.tags).toContain('pack:RetroPack');
    });

    it('should clean archive filenames with version suffixes and separators', async () => {
      const zipPath = path.join(tempLibraryDir, 'SciFi_Audio_v2.0.zip');
      createTestZipArchive(zipPath, [
        { name: 'laser.wav', content: Buffer.from('RIFF....WAVE') },
      ]);

      upsertAsset({
        id: 'asset_scifi_1',
        path: 'SciFi_Audio_v2.0.zip#/laser.wav',
        absolutePath: zipPath,
        name: 'laser.wav',
        extension: '.wav',
        category: 'audio',
        size: 100,
        mtime: Date.now(),
        hash: 'hash_scifi_1',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'laser.wav',
        tags: [],
      });

      const runRes = await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_scifi_1',
      });

      expect(runRes.classifiedCount).toBe(1);
      const asset = getAssetById('asset_scifi_1');
      expect(asset?.metadata.pack).toBe('SciFi Audio');
      expect(asset?.tags).toContain('pack:SciFi Audio');
    });
  });

  describe('Directory-Based Pack Classification', () => {
    it('should infer pack from directory hierarchy for filesystem assets', async () => {
      const diskDir = path.join(tempLibraryDir, 'FantasyKingdom', 'monsters');
      fs.mkdirSync(diskDir, { recursive: true });
      const filePath = path.join(diskDir, 'goblin.png');
      fs.writeFileSync(filePath, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'asset_disk_1',
        path: 'FantasyKingdom/monsters/goblin.png',
        absolutePath: filePath,
        name: 'goblin.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_disk_1',
        isArchiveEntry: false,
        tags: [],
      });

      const runRes = await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_disk_1',
      });

      expect(runRes.classifiedCount).toBe(1);
      const asset = getAssetById('asset_disk_1');
      expect(asset?.metadata.pack).toBe('FantasyKingdom');
      expect(asset?.tags).toContain('pack:FantasyKingdom');
    });

    it('should skip root assets that lack enclosing directories', async () => {
      const filePath = path.join(tempLibraryDir, 'root_icon.png');
      fs.writeFileSync(filePath, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'asset_root_1',
        path: 'root_icon.png',
        absolutePath: filePath,
        name: 'root_icon.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_root_1',
        isArchiveEntry: false,
        tags: [],
      });

      const runRes = await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_root_1',
      });

      expect(runRes.classifiedCount).toBe(0);
      expect(runRes.failedCount).toBe(1);
      expect(runRes.details[0].error).toContain('root level');
    });

    it('should support enclosing directory strategy', async () => {
      const diskDir = path.join(tempLibraryDir, 'packs', 'Cyberpunk', 'items');
      fs.mkdirSync(diskDir, { recursive: true });
      const filePath = path.join(diskDir, 'chip.png');
      fs.writeFileSync(filePath, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'asset_cyber_1',
        path: 'packs/Cyberpunk/items/chip.png',
        absolutePath: filePath,
        name: 'chip.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: Date.now(),
        hash: 'hash_cyber_1',
        isArchiveEntry: false,
        tags: [],
      });

      // Run with directoryStrategy: 'enclosing'
      const runRes = await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_cyber_1',
        settingsOverride: {
          directoryStrategy: 'enclosing',
        },
      });

      expect(runRes.classifiedCount).toBe(1);
      const asset = getAssetById('asset_cyber_1');
      expect(asset?.metadata.pack).toBe('items');
    });
  });

  describe('Selective Scope & Customization', () => {
    it('should filter execution by targetType archive', async () => {
      const zipPathA = path.join(tempLibraryDir, 'PackA.zip');
      const zipPathB = path.join(tempLibraryDir, 'PackB.zip');
      createTestZipArchive(zipPathA, [{ name: 'a.png', content: TINY_PNG_BUFFER }]);
      createTestZipArchive(zipPathB, [{ name: 'b.png', content: TINY_PNG_BUFFER }]);

      upsertAsset({
        id: 'asset_a',
        path: 'PackA.zip#/a.png',
        absolutePath: zipPathA,
        name: 'a.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: Date.now(),
        hash: 'h_a',
        isArchiveEntry: true,
        archivePath: zipPathA,
        archiveEntryPath: 'a.png',
        tags: [],
      });

      upsertAsset({
        id: 'asset_b',
        path: 'PackB.zip#/b.png',
        absolutePath: zipPathB,
        name: 'b.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: Date.now(),
        hash: 'h_b',
        isArchiveEntry: true,
        archivePath: zipPathB,
        archiveEntryPath: 'b.png',
        tags: [],
      });

      const runRes = await runClassifier(packClassifier, {
        targetType: 'archive',
        targetValue: 'PackA.zip',
      });

      expect(runRes.totalTargeted).toBe(1);
      expect(runRes.classifiedCount).toBe(1);

      const assetA = getAssetById('asset_a');
      expect(assetA?.metadata.pack).toBe('PackA');

      const assetB = getAssetById('asset_b');
      expect(assetB?.metadata.pack).toBeUndefined();
    });

    it('should respect targetArchives filter in settings', async () => {
      const zipPathA = path.join(tempLibraryDir, 'PackOne.zip');
      const zipPathB = path.join(tempLibraryDir, 'PackTwo.zip');
      createTestZipArchive(zipPathA, [{ name: 'one.png', content: TINY_PNG_BUFFER }]);
      createTestZipArchive(zipPathB, [{ name: 'two.png', content: TINY_PNG_BUFFER }]);

      upsertAsset({
        id: 'asset_one',
        path: 'PackOne.zip#/one.png',
        absolutePath: zipPathA,
        name: 'one.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: Date.now(),
        hash: 'h_1',
        isArchiveEntry: true,
        archivePath: zipPathA,
        archiveEntryPath: 'one.png',
        tags: [],
      });

      upsertAsset({
        id: 'asset_two',
        path: 'PackTwo.zip#/two.png',
        absolutePath: zipPathB,
        name: 'two.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: Date.now(),
        hash: 'h_2',
        isArchiveEntry: true,
        archivePath: zipPathB,
        archiveEntryPath: 'two.png',
        tags: [],
      });

      // Override settings to only target PackOne
      const runRes = await runClassifier(packClassifier, {
        targetType: 'all',
        settingsOverride: {
          targetArchives: ['PackOne.zip'],
        },
      });

      expect(runRes.classifiedCount).toBe(1);
      expect(runRes.failedCount).toBe(1);

      expect(getAssetById('asset_one')?.metadata.pack).toBe('PackOne');
      expect(getAssetById('asset_two')?.metadata.pack).toBeUndefined();
    });

    it('should respect applyTag: false and custom tagPrefix', async () => {
      const zipPath = path.join(tempLibraryDir, 'Bundle.zip');
      createTestZipArchive(zipPath, [{ name: 'item.png', content: TINY_PNG_BUFFER }]);

      upsertAsset({
        id: 'asset_custom_tag',
        path: 'Bundle.zip#/item.png',
        absolutePath: zipPath,
        name: 'item.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: Date.now(),
        hash: 'h_c',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'item.png',
        tags: [],
      });

      // 1. Custom prefix
      await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_custom_tag',
        settingsOverride: {
          tagPrefix: 'asset-pack:',
        },
      });

      let asset = getAssetById('asset_custom_tag');
      expect(asset?.metadata.pack).toBe('Bundle');
      expect(asset?.tags).toContain('asset-pack:Bundle');

      // 2. Disable tags
      await runClassifier(packClassifier, {
        targetType: 'asset',
        targetValue: 'asset_custom_tag',
        settingsOverride: {
          applyTag: false,
        },
      });

      asset = getAssetById('asset_custom_tag');
      expect(asset?.metadata.pack).toBe('Bundle');
      expect(asset?.tags.some((t) => t.includes('Bundle'))).toBe(false);
    });
  });

  describe('Search & Query Integration', () => {
    beforeEach(async () => {
      const zipPath = path.join(tempLibraryDir, 'RetroPack.zip');
      createTestZipArchive(zipPath, [{ name: 'hero.png', content: TINY_PNG_BUFFER }]);

      upsertAsset({
        id: 'asset_search_retro',
        path: 'RetroPack.zip#/hero.png',
        absolutePath: zipPath,
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: Date.now(),
        hash: 'h_retro',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'hero.png',
        metadata: { pack: 'RetroPack' },
        tags: [{ tag: 'pack:RetroPack', source: 'classifier:pack' }],
      });

      upsertAsset({
        id: 'asset_search_fantasy',
        path: 'FantasyMedieval/monsters/orc.png',
        absolutePath: path.join(tempLibraryDir, 'FantasyMedieval/monsters/orc.png'),
        name: 'orc.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: Date.now(),
        hash: 'h_fantasy',
        isArchiveEntry: false,
        metadata: { pack: 'Fantasy Medieval' },
        tags: [{ tag: 'pack:Fantasy Medieval', source: 'classifier:pack' }],
      });
    });

    it('should query assets by pack parameter', () => {
      const res = queryAssets({ pack: 'RetroPack' });
      expect(res.items.length).toBe(1);
      expect((res.items[0] as any).id).toBe('asset_search_retro');
    });

    it('should query assets using search expression pack:RetroPack', () => {
      const res = queryAssets({ search: 'pack:RetroPack' });
      expect(res.items.length).toBe(1);
      expect((res.items[0] as any).id).toBe('asset_search_retro');
    });

    it('should query assets using wildcard search pack:retro*', () => {
      const res = queryAssets({ search: 'pack:retro*' });
      expect(res.items.length).toBe(1);
      expect((res.items[0] as any).id).toBe('asset_search_retro');
    });

    it('should query assets using pack status presets pack:any and pack:none', () => {
      const anyRes = queryAssets({ search: 'pack:any' });
      expect(anyRes.items.length).toBe(2);

      const noneRes = queryAssets({ search: 'pack:none' });
      expect(noneRes.items.length).toBe(0);
    });
  });
});
