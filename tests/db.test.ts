import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  getCurrentLibraryPath,
  getAppSettings,
  updateAppSettings,
  upsertAsset,
  getAssetById,
  getAssetByPath,
  getAllTags,
  getAllFormats,
  createStack,
  getStackById,
  getStackAssets,
  clearStacks,
  removeDeletedAssets,
  queryAssets,
} from '../server/src/db/database.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

describe('Database Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('db-test-');
    initDatabase(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('initDatabase & getDatabase lifecycle', () => {
    it('should throw an error if getDatabase is called when dbInstance is null', () => {
      closeDatabase();
      expect(() => getDatabase()).toThrow(/Database has not been initialized/);
    });

    it('should create necessary tables, indexes, and directory structure', () => {
      const db = getDatabase();
      expect(db).toBeDefined();

      const assettlorDir = path.join(tempDir, '.assettlor');
      const thumbnailsDir = path.join(assettlorDir, 'thumbnails');
      expect(fs.existsSync(assettlorDir)).toBe(true);
      expect(fs.existsSync(thumbnailsDir)).toBe(true);

      // Verify schema tables exist
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];
      const tableNames = tables.map((t) => t.name);

      expect(tableNames).toContain('assets');
      expect(tableNames).toContain('stacks');
      expect(tableNames).toContain('tags');
      expect(tableNames).toContain('settings');
    });

    it('should reuse dbInstance when called with identical libraryPath', () => {
      const db1 = getDatabase();
      const db2 = initDatabase(tempDir);
      expect(db1).toBe(db2);
      expect(getCurrentLibraryPath()).toBe(tempDir);
    });

    it('should close old db and switch when called with different libraryPath', () => {
      const otherDir = createTempDir('db-other-');
      const db1 = getDatabase();
      const db2 = initDatabase(otherDir);
      expect(db2).not.toBe(db1);
      expect(getCurrentLibraryPath()).toBe(otherDir);
      cleanupTempDir(otherDir);
    });
  });

  describe('AppSettings', () => {
    it('should return default settings if none were stored', () => {
      const settings = getAppSettings();
      expect(settings).toBeDefined();
      expect(settings.thumbnailQuality).toBe(80);
      expect(settings.autoStackAnimations).toBe(true);
      expect(settings.autoStackAudio).toBe(true);
      expect(settings.defaultFps).toBe(12);
      expect(settings.libraryPath).toBe(tempDir);
    });

    it('should update and persist settings', () => {
      const updated = updateAppSettings({
        thumbnailQuality: 95,
        autoStackAnimations: false,
        defaultFps: 24,
      });

      expect(updated.thumbnailQuality).toBe(95);
      expect(updated.autoStackAnimations).toBe(false);
      expect(updated.defaultFps).toBe(24);

      const refetched = getAppSettings();
      expect(refetched.thumbnailQuality).toBe(95);
      expect(refetched.autoStackAnimations).toBe(false);
      expect(refetched.defaultFps).toBe(24);
    });
  });

  describe('upsertAsset & Asset Retrieval', () => {
    it('should insert a new asset and retrieve it with tags and metadata', () => {
      upsertAsset({
        id: 'asset_1',
        path: 'sprites/hero.png',
        absolutePath: path.join(tempDir, 'sprites/hero.png'),
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: 1024,
        mtime: 12345678,
        hash: 'hash_123',
        isArchiveEntry: false,
        metadata: { width: 32, height: 32, format: 'png' },
        tags: [
          { tag: 'pixel-art', source: 'auto' },
          { tag: 'character', source: 'folder' },
          { tag: '   ', source: 'auto' }, // empty tag should be ignored
        ],
      });

      const asset = getAssetById('asset_1');
      expect(asset).not.toBeNull();
      expect(asset!.id).toBe('asset_1');
      expect(asset!.name).toBe('hero.png');
      expect(asset!.extension).toBe('.png');
      expect(asset!.size).toBe(1024);
      expect(asset!.metadata.width).toBe(32);
      expect(asset!.fileUrl).toBe('/api/assets/asset_1/file');
      expect(asset!.tags).toContain('pixel-art');
      expect(asset!.tags).toContain('character');
      expect(asset!.tags).not.toContain('');

      const byPath = getAssetByPath('sprites/hero.png');
      expect(byPath).not.toBeNull();
      expect(byPath!.id).toBe('asset_1');
    });

    it('should update asset on path conflict', () => {
      upsertAsset({
        id: 'asset_1',
        path: 'sprites/hero.png',
        absolutePath: path.join(tempDir, 'sprites/hero.png'),
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: 1024,
        mtime: 100,
        hash: 'h1',
        isArchiveEntry: false,
        tags: [{ tag: 'tag1', source: 'auto' }],
      });

      upsertAsset({
        id: 'asset_1_mod',
        path: 'sprites/hero.png',
        absolutePath: path.join(tempDir, 'sprites/hero.png'),
        name: 'hero_renamed.png',
        extension: '.png',
        category: 'image',
        size: 2048,
        mtime: 200,
        hash: 'h2',
        isArchiveEntry: false,
        tags: [{ tag: 'tag2', source: 'auto' }],
      });

      const asset = getAssetByPath('sprites/hero.png');
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe('hero_renamed.png');
      expect(asset!.size).toBe(2048);
      expect(asset!.hash).toBe('h2');
      expect(asset!.tags).toEqual(['tag2']);
    });

    it('should handle corrupted metadata JSON gracefully', () => {
      upsertAsset({
        id: 'bad_meta',
        path: 'bad.png',
        absolutePath: path.join(tempDir, 'bad.png'),
        name: 'bad.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: 10,
        hash: 'h',
        isArchiveEntry: false,
      });

      const db = getDatabase();
      db.prepare("UPDATE assets SET metadata = 'INVALID_JSON{' WHERE id = 'bad_meta'").run();

      const asset = getAssetById('bad_meta');
      expect(asset).not.toBeNull();
      expect(asset!.metadata).toEqual({});
    });

    it('should return null for non-existent asset ID or path', () => {
      expect(getAssetById('non_existent')).toBeNull();
      expect(getAssetByPath('non_existent/path.png')).toBeNull();
    });
  });

  describe('getAllTags & getAllFormats', () => {
    it('should aggregate tags with counts and sources', () => {
      upsertAsset({
        id: 'a1',
        path: 'a1.png',
        absolutePath: '/a1.png',
        name: 'a1.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: 10,
        hash: 'h1',
        isArchiveEntry: false,
        tags: [
          { tag: 'sfx', source: 'folder' },
          { tag: 'game', source: 'auto' },
        ],
      });

      upsertAsset({
        id: 'a2',
        path: 'a2.png',
        absolutePath: '/a2.png',
        name: 'a2.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: 10,
        hash: 'h2',
        isArchiveEntry: false,
        tags: [{ tag: 'sfx', source: 'folder' }],
      });

      const tags = getAllTags();
      const sfx = tags.find((t) => t.name === 'sfx');
      expect(sfx).toBeDefined();
      expect(sfx!.count).toBe(2);

      const game = tags.find((t) => t.name === 'game');
      expect(game).toBeDefined();
      expect(game!.count).toBe(1);
    });

    it('should aggregate formats with counts', () => {
      upsertAsset({
        id: 'img1',
        path: 'img1.png',
        absolutePath: '/img1.png',
        name: 'img1.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: 10,
        hash: 'h1',
        isArchiveEntry: false,
      });
      upsertAsset({
        id: 'snd1',
        path: 'snd1.wav',
        absolutePath: '/snd1.wav',
        name: 'snd1.wav',
        extension: '.wav',
        category: 'audio',
        size: 20,
        mtime: 20,
        hash: 'h2',
        isArchiveEntry: false,
      });

      const formats = getAllFormats();
      const png = formats.find((f) => f.extension === '.png');
      expect(png).toBeDefined();
      expect(png!.category).toBe('image');
      expect(png!.count).toBe(1);

      const wav = formats.find((f) => f.extension === '.wav');
      expect(wav).toBeDefined();
      expect(wav!.category).toBe('audio');
      expect(wav!.count).toBe(1);
    });
  });

  describe('Stack Management', () => {
    beforeEach(() => {
      upsertAsset({
        id: 'frame_1',
        path: 'walk_01.png',
        absolutePath: '/walk_01.png',
        name: 'walk_01.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 100,
        hash: 'h1',
        isArchiveEntry: false,
        tags: [{ tag: 'knight', source: 'auto' }],
      });
      upsertAsset({
        id: 'frame_2',
        path: 'walk_02.png',
        absolutePath: '/walk_02.png',
        name: 'walk_02.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 100,
        hash: 'h2',
        isArchiveEntry: false,
        tags: [{ tag: 'animated', source: 'auto' }],
      });
    });

    it('should create stack, link assets, and retrieve stack with ordered assets', () => {
      createStack({
        id: 'stack_walk',
        name: 'Knight Walk',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'frame_1',
        metadata: { fps: 12 },
        assetIdsWithIndex: [
          { assetId: 'frame_1', index: 0 },
          { assetId: 'frame_2', index: 1 },
        ],
      });

      const stack = getStackById('stack_walk');
      expect(stack).not.toBeNull();
      expect(stack!.name).toBe('Knight Walk');
      expect(stack!.type).toBe('animation');
      expect(stack!.itemCount).toBe(2);
      expect(stack!.representativeAssetId).toBe('frame_1');
      expect(stack!.representativeAsset?.id).toBe('frame_1');
      expect(stack!.assets).toHaveLength(2);
      expect(stack!.assets![0].id).toBe('frame_1');
      expect(stack!.assets![1].id).toBe('frame_2');
      // Unique tags across assets merged
      expect(stack!.tags).toContain('knight');
      expect(stack!.tags).toContain('animated');

      const stackAssets = getStackAssets('stack_walk');
      expect(stackAssets).toHaveLength(2);
      expect(stackAssets[0].id).toBe('frame_1');
      expect(stackAssets[1].id).toBe('frame_2');
    });

    it('should clear stacks and unlink assets', () => {
      createStack({
        id: 'stack_walk',
        name: 'Knight Walk',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'frame_1',
        assetIdsWithIndex: [
          { assetId: 'frame_1', index: 0 },
          { assetId: 'frame_2', index: 1 },
        ],
      });

      clearStacks();
      expect(getStackById('stack_walk')).toBeNull();

      const a1 = getAssetById('frame_1');
      expect(a1!.stackId).toBeNull();
      expect(a1!.stackIndex).toBeNull();
    });
  });

  describe('removeDeletedAssets', () => {
    it('should remove assets not present in the active paths set and delete their thumbnails', () => {
      const thumbPath = path.join(tempDir, '.assettlor/thumbnails/old_thumb.webp');
      fs.writeFileSync(thumbPath, 'dummy thumb');

      upsertAsset({
        id: 'removable',
        path: 'deleted.png',
        absolutePath: '/deleted.png',
        name: 'deleted.png',
        extension: '.png',
        category: 'image',
        size: 50,
        mtime: 50,
        hash: 'h',
        isArchiveEntry: false,
        thumbnailPath: thumbPath,
        tags: [{ tag: 'temp', source: 'auto' }],
      });

      upsertAsset({
        id: 'kept',
        path: 'kept.png',
        absolutePath: '/kept.png',
        name: 'kept.png',
        extension: '.png',
        category: 'image',
        size: 50,
        mtime: 50,
        hash: 'h2',
        isArchiveEntry: false,
      });

      const removedCount = removeDeletedAssets(new Set(['kept.png']));
      expect(removedCount).toBe(1);

      expect(getAssetById('removable')).toBeNull();
      expect(getAssetById('kept')).not.toBeNull();
      expect(fs.existsSync(thumbPath)).toBe(false);
    });
  });

  describe('queryAssets - Comprehensive Search, Filters, Sorting & Pagination', () => {
    beforeEach(() => {
      upsertAsset({
        id: 'img_k1',
        path: 'chars/Knight_Walk_01.png',
        absolutePath: '/chars/Knight_Walk_01.png',
        name: 'Knight_Walk_01.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 1000,
        hash: 'hk1',
        isArchiveEntry: false,
        tags: [{ tag: 'knight', source: 'folder' }, { tag: 'pixel-art', source: 'auto' }],
      });

      upsertAsset({
        id: 'img_k2',
        path: 'chars/Knight_Walk_02.png',
        absolutePath: '/chars/Knight_Walk_02.png',
        name: 'Knight_Walk_02.png',
        extension: '.png',
        category: 'image',
        size: 200,
        mtime: 2000,
        hash: 'hk2',
        isArchiveEntry: false,
        tags: [{ tag: 'knight', source: 'folder' }],
      });

      upsertAsset({
        id: 'snd_laser',
        path: 'sfx/laser_gun.wav',
        absolutePath: '/sfx/laser_gun.wav',
        name: 'laser_gun.wav',
        extension: '.wav',
        category: 'audio',
        size: 500,
        mtime: 3000,
        hash: 'hs1',
        isArchiveEntry: false,
        tags: [{ tag: 'laser', source: 'auto' }, { tag: 'sfx', source: 'folder' }],
      });

      createStack({
        id: 'stack_knight',
        name: 'Knight Walk',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'img_k1',
        assetIdsWithIndex: [
          { assetId: 'img_k1', index: 0 },
          { assetId: 'img_k2', index: 1 },
        ],
      });
    });

    it('should return summary counts correctly', () => {
      const res = queryAssets({});
      expect(res.summary.totalAssets).toBe(3);
      expect(res.summary.imageCount).toBe(2);
      expect(res.summary.audioCount).toBe(1);
      expect(res.summary.animationStackCount).toBe(1);
      expect(res.summary.totalSize).toBe(800);
    });

    it('should distinguish between stacked view and flat view', () => {
      const stacked = queryAssets({ isStackedView: true });
      // Stacked view returns: 1 stack card (Knight Walk) + 1 audio card (laser_gun.wav)
      expect(stacked.items).toHaveLength(2);
      const stackItem = stacked.items.find((i: any) => i.isStack);
      expect(stackItem).toBeDefined();
      expect(stackItem!.name).toBe('Knight Walk');

      const flat = queryAssets({ isStackedView: false });
      // Flat view returns all 3 individual asset rows
      expect(flat.items).toHaveLength(3);
    });

    it('should filter by category', () => {
      const imgRes = queryAssets({ category: 'image', isStackedView: false });
      expect(imgRes.items).toHaveLength(2);
      expect(imgRes.items.every((i) => i.category === 'image')).toBe(true);

      const audRes = queryAssets({ category: 'audio', isStackedView: false });
      expect(audRes.items).toHaveLength(1);
      expect(audRes.items[0].id).toBe('snd_laser');
    });

    it('should filter by format extension', () => {
      const wavRes = queryAssets({ format: '.wav', isStackedView: false });
      expect(wavRes.items).toHaveLength(1);
      expect(wavRes.items[0].name).toBe('laser_gun.wav');

      const pngStacked = queryAssets({ format: '.png', isStackedView: true });
      expect(pngStacked.items).toHaveLength(1);
    });

    it('should filter by tag with and without hash symbol', () => {
      const tagRes1 = queryAssets({ tag: 'pixel-art', isStackedView: true });
      expect(tagRes1.items).toHaveLength(1);

      const tagRes2 = queryAssets({ tag: '#pixel-art', isStackedView: true });
      expect(tagRes2.items).toHaveLength(1);

      const tagRes3 = queryAssets({ tag: 'sfx', isStackedView: false });
      expect(tagRes3.items).toHaveLength(1);
      expect(tagRes3.items[0].id).toBe('snd_laser');
    });

    it('should search by token with space/underscore substitution', () => {
      // Searching "knight walk" matches "Knight_Walk_01.png" and stack "Knight Walk"
      const res = queryAssets({ search: 'knight walk', isStackedView: true });
      expect(res.items).toHaveLength(1);
      expect(res.items[0].name).toBe('Knight Walk');

      // Tag search syntax in search query (#sfx)
      const tagSearch = queryAssets({ search: '#sfx', isStackedView: false });
      expect(tagSearch.items).toHaveLength(1);
      expect(tagSearch.items[0].id).toBe('snd_laser');
    });

    it('should filter by stackType', () => {
      const anims = queryAssets({ stackType: 'animation', isStackedView: true });
      expect(anims.items).toHaveLength(1);
      expect(anims.items[0].name).toBe('Knight Walk');

      const audioVars = queryAssets({ stackType: 'audio_variation', isStackedView: true });
      expect(audioVars.items).toHaveLength(0);
    });

    it('should sort assets by size and mtime ascending and descending', () => {
      const sizeAsc = queryAssets({ sortBy: 'size', sortOrder: 'asc', isStackedView: false });
      expect(sizeAsc.items[0].size).toBe(100);
      expect(sizeAsc.items[2].size).toBe(500);

      const sizeDesc = queryAssets({ sortBy: 'size', sortOrder: 'desc', isStackedView: false });
      expect(sizeDesc.items[0].size).toBe(500);
      expect(sizeDesc.items[2].size).toBe(100);

      const mtimeDesc = queryAssets({ sortBy: 'mtime', sortOrder: 'desc', isStackedView: false });
      expect(mtimeDesc.items[0].id).toBe('snd_laser');
    });

    it('should paginate results properly', () => {
      const page1 = queryAssets({ limit: 1, page: 1, isStackedView: false });
      expect(page1.items).toHaveLength(1);
      expect(page1.total).toBe(3);
      expect(page1.totalPages).toBe(3);
      expect(page1.page).toBe(1);

      const page2 = queryAssets({ limit: 1, page: 2, isStackedView: false });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });
});
