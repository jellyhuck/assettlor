import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  createStack,
  getAllFolders,
  getAssetById,
  getDatabase,
  initDatabase,
  queryAssets,
  updateAppSettings,
  upsertAsset,
} from '../server/src/db/database.js';
import {
  DEFAULT_FOLDER_SETTINGS,
  extractSubfolders,
  folderClassifier,
  sourceRelativeAssetPath,
} from '../server/src/services/classifiers/folderClassifier.js';
import {
  getClassifier,
  getClassifierInfo,
  saveClassifierSettings,
} from '../server/src/services/classifiers/registry.js';
import { runClassifier } from '../server/src/services/classifiers/engine.js';
import { ClassifierSettingsError } from '../server/src/services/classifiers/settings.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { formatFilterToken, parseFiltersFromQuery, updateSearchFilter } from '../shared/filterSync.js';
import type { Asset } from '../shared/types.js';
import { cleanupTempDir, createTempDir, createTestZipArchive, TINY_PNG_BUFFER } from './helpers.js';

function itemIds(search: string, isStackedView = false): string[] {
  return queryAssets({ search, isStackedView, limit: 200 }).items.map((item) => item.id).sort();
}

describe('Folder Classifier', () => {
  describe('path helpers', () => {
    it('lists every subfolder of a disk path, outermost first', () => {
      expect(extractSubfolders('items/coins/gold.png')).toEqual(['items', 'coins']);
      expect(extractSubfolders('a\\b\\c\\file.wav')).toEqual(['a', 'b', 'c']);
      expect(extractSubfolders('root.png')).toEqual([]);
    });

    it('lists folders before and inside an archive, but not the archive itself', () => {
      expect(extractSubfolders('packs/RetroPack.zip#/items/coins/gold.png'))
        .toEqual(['packs', 'items', 'coins']);
      expect(extractSubfolders('RetroPack.zip#/gold.png')).toEqual([]);
      expect(extractSubfolders('packs/RetroPack.zip#/items/coins/gold.png', { includeArchiveFolders: false }))
        .toEqual(['packs']);
    });

    it('lists a repeated folder name once with its first spelling', () => {
      expect(extractSubfolders('Sprites/hero/sprites/HERO/idle.png')).toEqual(['Sprites', 'hero']);
    });

    it('drops the scanner display prefix of a multi-library catalog', () => {
      const disk = {
        path: 'Library A/items/coin.png', absolutePath: '/libs/a/items/coin.png',
        sourceDirectory: '/libs/a', isArchiveEntry: false,
      } as Asset;
      expect(sourceRelativeAssetPath(disk)).toBe('items/coin.png');

      const entry = {
        path: 'Library A/packs/Retro.zip#/tiles/grass.png', absolutePath: '/libs/a/packs/Retro.zip',
        archivePath: '/libs/a/packs/Retro.zip', archiveEntryPath: 'tiles/grass.png',
        sourceDirectory: '/libs/a', isArchiveEntry: true,
      } as Asset;
      expect(sourceRelativeAssetPath(entry)).toBe('packs/Retro.zip#/tiles/grass.png');
    });
  });

  describe('registration and settings', () => {
    let dataDir: string;

    beforeEach(() => {
      dataDir = createTempDir('folder-classifier-settings-');
      resetConfigForTesting({ data_dir: dataDir });
      initDatabase(dataDir);
    });

    afterEach(() => {
      closeDatabase();
      resetConfigForTesting();
      cleanupTempDir(dataDir);
    });

    it('registers a general, path-only classifier with default settings', () => {
      expect(getClassifier('folder')).toBe(folderClassifier);
      expect(folderClassifier.category).toBe('general');
      expect(folderClassifier.requiresBuffer).toBe(false);
      const info = getClassifierInfo(folderClassifier);
      expect(info.name).toBe('Folder Classifier');
      expect(info.steps.map((step) => step.id)).toEqual(['resolve-path', 'extract-folders', 'persist-metadata']);
      expect(info.settings).toEqual(DEFAULT_FOLDER_SETTINGS);
    });

    it('validates its settings', () => {
      expect(saveClassifierSettings('folder', { includeArchiveFolders: false }))
        .toMatchObject({ includeArchiveFolders: false });
      expect(() => saveClassifierSettings('folder', { includeArchiveFolders: 'no' }))
        .toThrow(ClassifierSettingsError);
      expect(() => saveClassifierSettings('folder', { applyTag: true })).toThrow('Unknown folder setting');
    });
  });

  describe('classification and filters', () => {
    let libraryDir: string;

    const disk = (id: string, relativePath: string, extra: Partial<Parameters<typeof upsertAsset>[0]> = {}) => {
      const absolutePath = path.join(libraryDir, relativePath);
      upsertAsset({
        id, path: relativePath, absolutePath, name: path.basename(relativePath),
        extension: path.extname(relativePath), category: 'image', size: 10, mtime: 1000,
        hash: `hash-${id}`, isArchiveEntry: false, sourceDirectory: libraryDir,
        metadata: { width: 1, height: 1 }, ...extra,
      });
    };

    beforeEach(() => {
      libraryDir = createTempDir('folder-classifier-lib-');
      initDatabase(libraryDir);
      disk('coin', 'items/coins/gold.png');
      disk('gem', 'items/gems/ruby.png');
      disk('hero', 'Characters/Hero Knight/idle.png');
      disk('root', 'logo.png');
      const archive = path.join(libraryDir, 'packs', 'Retro.zip');
      upsertAsset({
        id: 'tile', path: 'packs/Retro.zip#/tiles/grass.png', absolutePath: archive,
        name: 'grass.png', extension: '.png', category: 'image', size: 10, mtime: 1000,
        hash: 'hash-tile', isArchiveEntry: true, archivePath: archive,
        archiveEntryPath: 'tiles/grass.png', sourceDirectory: libraryDir,
        metadata: { width: 1, height: 1 },
      });
    });

    afterEach(() => {
      closeDatabase();
      cleanupTempDir(libraryDir);
    });

    it('stores subfolders as metadata without writing tags', async () => {
      const run = await runClassifier(folderClassifier, { targetType: 'all' });
      expect(run.classifiedCount).toBe(4);
      expect(run.noResultCount).toBe(1);
      expect(getAssetById('coin')!.metadata.folders).toEqual(['items', 'coins']);
      expect(getAssetById('hero')!.metadata.folders).toEqual(['Characters', 'Hero Knight']);
      expect(getAssetById('tile')!.metadata.folders).toEqual(['packs', 'tiles']);
      expect(getAssetById('root')!.metadata.folders).toBeUndefined();
      expect(run.details.find((detail) => detail.assetId === 'root')?.error).toContain('library root');
      expect((getDatabase().prepare('SELECT COUNT(*) AS count FROM tags').get() as { count: number }).count).toBe(0);
    });

    it('lists each folder once with its asset count', async () => {
      await runClassifier(folderClassifier, { targetType: 'all' });
      expect(getAllFolders()).toEqual([
        { name: 'items', count: 2 },
        { name: 'Characters', count: 1 },
        { name: 'coins', count: 1 },
        { name: 'gems', count: 1 },
        { name: 'Hero Knight', count: 1 },
        { name: 'packs', count: 1 },
        { name: 'tiles', count: 1 },
      ]);
    });

    it('matches folder names exactly, by wildcard, and by status preset', async () => {
      await runClassifier(folderClassifier, { targetType: 'all' });
      expect(itemIds('folder:items')).toEqual(['coin', 'gem']);
      expect(itemIds('folder:COINS')).toEqual(['coin']);
      // A folder filter matches a whole folder name, unlike path:.
      expect(itemIds('folder:coin')).toEqual([]);
      expect(itemIds('folder:"Hero Knight"')).toEqual(['hero']);
      expect(itemIds('folder:ge*')).toEqual(['gem']);
      expect(itemIds('folder:tiles')).toEqual(['tile']);
      expect(itemIds('folder:none')).toEqual(['root']);
      expect(itemIds('folder:any')).toEqual(['coin', 'gem', 'hero', 'tile']);
      expect(itemIds('folder:items -folder:gems')).toEqual(['coin']);
      expect(queryAssets({ folder: 'gems' }).items.map((item) => item.id)).toEqual(['gem']);
    });

    it('treats quoted presets and wildcards as literal folder names', async () => {
      disk('literal-none', 'none/a.png');
      disk('literal-star', 'ge*/b.png');
      await runClassifier(folderClassifier, { targetType: 'all' });
      expect(itemIds('folder:"none"')).toEqual(['literal-none']);
      expect(itemIds('folder:"ge*"')).toEqual(['literal-star']);
    });

    it('matches a stack through any member in the stacked view', async () => {
      disk('frame-1', 'anim/a/walk_01.png');
      disk('frame-2', 'anim/b/walk_02.png');
      createStack({
        id: 'walk', name: 'walk', type: 'animation', itemCount: 2, representativeAssetId: 'frame-1',
        assetIdsWithIndex: [{ assetId: 'frame-1', index: 0 }, { assetId: 'frame-2', index: 1 }],
      });
      await runClassifier(folderClassifier, { targetType: 'all' });
      expect(itemIds('folder:b', true)).toEqual(['walk']);
      expect(itemIds('folder:b')).toEqual(['frame-2']);
    });

    it('replaces folders on a rerun and clears them when none remain', async () => {
      await runClassifier(folderClassifier, { targetType: 'all' });
      await runClassifier(folderClassifier, {
        targetType: 'asset', targetValue: 'tile', settingsOverride: { includeArchiveFolders: false },
      });
      expect(getAssetById('tile')!.metadata.folders).toEqual(['packs']);

      const coin = getAssetById('coin')!;
      upsertAsset({
        id: 'coin', path: 'gold.png', absolutePath: path.join(libraryDir, 'gold.png'),
        name: 'gold.png', extension: '.png', category: 'image', size: coin.size, mtime: coin.mtime,
        hash: coin.hash, isArchiveEntry: false, sourceDirectory: libraryDir, metadata: coin.metadata,
      });
      const rerun = await runClassifier(folderClassifier, { targetType: 'asset', targetValue: 'coin' });
      expect(rerun.noResultCount).toBe(1);
      expect(getAssetById('coin')!.metadata.folders).toBeUndefined();
    });
  });

  describe('HTTP routes', () => {
    let libraryDir: string;
    let app: FastifyInstance;

    beforeEach(async () => {
      libraryDir = createTempDir('folder-classifier-routes-');
      initDatabase(libraryDir);
      updateAppSettings({ libraryPath: libraryDir, activeProjectPath: libraryDir });
      upsertAsset({
        id: 'coin', path: 'items/coins/gold.png', absolutePath: path.join(libraryDir, 'items/coins/gold.png'),
        name: 'gold.png', extension: '.png', category: 'image', size: 10, mtime: 1000,
        hash: 'hash-coin', isArchiveEntry: false, sourceDirectory: libraryDir, metadata: {},
      });
      app = await buildServer({ initDb: false, logger: false });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
      closeDatabase();
      cleanupTempDir(libraryDir);
    });

    it('runs the classifier and serves folder facets and filters', async () => {
      const run = await app.inject({
        method: 'POST', url: '/api/classifiers/folder/run', payload: { targetType: 'all' },
      });
      expect(run.statusCode).toBe(200);

      const folders = await app.inject({ method: 'GET', url: '/api/folders' });
      expect(folders.statusCode).toBe(200);
      expect(folders.json()).toEqual([{ name: 'coins', count: 1 }, { name: 'items', count: 1 }]);

      const bySearch = await app.inject({ method: 'GET', url: '/api/assets?search=folder:coins' });
      expect(bySearch.json().items.map((item: { id: string }) => item.id)).toEqual(['coin']);
      const byParam = await app.inject({ method: 'GET', url: '/api/assets?folder=items' });
      expect(byParam.json().items.map((item: { id: string }) => item.id)).toEqual(['coin']);
    });
  });

  describe('automatic run after a scan', () => {
    let fixture: string;
    let dataDir: string;

    beforeEach(() => {
      fixture = createTempDir('folder-classifier-scan-');
      dataDir = path.join(fixture, 'data');
    });

    afterEach(() => {
      closeDatabase();
      resetConfigForTesting();
      cleanupTempDir(fixture);
    });

    it('classifies scanned disk files and archive entries relative to each library', async () => {
      const libraryA = path.join(fixture, 'Sprites');
      const libraryB = path.join(fixture, 'Packs');
      fs.mkdirSync(path.join(libraryA, 'items', 'coins'), { recursive: true });
      fs.writeFileSync(path.join(libraryA, 'items', 'coins', 'gold.png'), TINY_PNG_BUFFER);
      fs.mkdirSync(path.join(libraryB, 'retro'), { recursive: true });
      createTestZipArchive(path.join(libraryB, 'retro', 'Tiles.zip'), [
        { name: 'ground/grass.png', content: TINY_PNG_BUFFER },
      ]);
      resetConfigForTesting({
        data_dir: dataDir,
        libraries: [libraryA, libraryB],
        classifiers: {
          bpm: { enabled: false }, sprite: { enabled: false }, pack: { enabled: false },
        },
      });
      initDatabase(dataDir);

      expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
      const rows = getDatabase().prepare('SELECT id, path FROM assets ORDER BY path').all() as
        { id: string; path: string }[];
      const folders = Object.fromEntries(rows.map((row) => [row.path, getAssetById(row.id)!.metadata.folders]));
      // Display paths carry the library name; the folders are relative to each library.
      expect(folders).toEqual({
        'Packs/retro/Tiles.zip#/ground/grass.png': ['retro', 'ground'],
        'Sprites/items/coins/gold.png': ['items', 'coins'],
      });
      expect(itemIds('folder:ground')).toHaveLength(1);
    });
  });
});

describe('folder filter search syncing', () => {
  it('formats sidebar selections as folder tokens', () => {
    expect(formatFilterToken('folder', 'coins')).toBe('folder:coins');
    expect(formatFilterToken('folder', 'Hero Knight')).toBe('folder:"Hero Knight"');
    expect(formatFilterToken('folder', 'none')).toBe('folder:"none"');
    expect(formatFilterToken('folder', 'ge*')).toBe('folder:"ge*"');
  });

  it('reads and replaces a folder selection in the search query', () => {
    expect(parseFiltersFromQuery('hero folder:"Hero Knight"').folder).toBe('Hero Knight');
    expect(parseFiltersFromQuery('folder:a OR folder:b').folder).toBeNull();
    expect(updateSearchFilter('hero folder:coins', 'folder', 'gems')).toBe('hero folder:gems');
    expect(updateSearchFilter('hero folder:coins', 'folder', null)).toBe('hero');
  });
});
