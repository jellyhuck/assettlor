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
  getAllResolutions,
  getAllBpms,
  createStack,
  getStackById,
  getStackAssets,
  clearStacks,
  removeDeletedAssets,
  queryAssets,
  addAssetTags,
  removeAssetTag,
  removeAssetTags,
  setAssetTags,
  addTagsToAssets,
  removeTagsFromAssets,
  addTagsToStack,
  removeTagsFromStack,
} from '../server/src/db/database.js';
import { createTempDir, cleanupTempDir, upsertTaggedAsset } from './helpers.js';

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
      expect(getCurrentLibraryPath()).toBe('');
    });

    it('should close old db and switch when called with different libraryPath', () => {
      const otherDir = createTempDir('db-other-');
      const db1 = getDatabase();
      const db2 = initDatabase(otherDir);
      expect(db2).not.toBe(db1);
      expect(getCurrentLibraryPath()).toBe('');
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
      expect(settings.catalogPaging).toBe('load-more');
      expect(settings.libraryPath).toBe('');
    });

    it('should update and persist settings', () => {
      const updated = updateAppSettings({
        thumbnailQuality: 95,
        autoStackAnimations: false,
        defaultFps: 24,
        catalogPaging: 'pages',
      });

      expect(updated.thumbnailQuality).toBe(95);
      expect(updated.catalogPaging).toBe('pages');
      expect(updated.autoStackAnimations).toBe(false);
      expect(updated.defaultFps).toBe(24);

      const refetched = getAppSettings();
      expect(refetched.thumbnailQuality).toBe(95);
      expect(refetched.autoStackAnimations).toBe(false);
      expect(refetched.defaultFps).toBe(24);
      expect(refetched.catalogPaging).toBe('pages');
    });
  });

  describe('upsertAsset & Asset Retrieval', () => {
    it('should insert a new asset and retrieve it with tags and metadata', () => {
      upsertTaggedAsset({
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
          'pixel-art',
          'character',
          '   ', // empty tag should be ignored
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
      upsertTaggedAsset({
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
        tags: ['tag1'],
      });

      upsertTaggedAsset({
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
      });

      const asset = getAssetByPath('sprites/hero.png');
      expect(asset).not.toBeNull();
      expect(asset!.name).toBe('hero_renamed.png');
      expect(asset!.size).toBe(2048);
      expect(asset!.hash).toBe('h2');
      expect(asset!.tags).toEqual(['tag1']);
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
      upsertTaggedAsset({
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
          'sfx',
          'game',
        ],
      });

      upsertTaggedAsset({
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
        tags: ['sfx'],
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

    it('should aggregate image resolutions with counts', () => {
      upsertAsset({
        id: 'img_res_1',
        path: 'icon1.png',
        absolutePath: '/icon1.png',
        name: 'icon1.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 10,
        hash: 'hr1',
        isArchiveEntry: false,
        metadata: { width: 64, height: 64 },
      });

      upsertAsset({
        id: 'img_res_2',
        path: 'icon2.png',
        absolutePath: '/icon2.png',
        name: 'icon2.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 10,
        hash: 'hr2',
        isArchiveEntry: false,
        metadata: { width: 64, height: 64 },
      });

      upsertAsset({
        id: 'img_res_3',
        path: 'banner.png',
        absolutePath: '/banner.png',
        name: 'banner.png',
        extension: '.png',
        category: 'image',
        size: 500,
        mtime: 10,
        hash: 'hr3',
        isArchiveEntry: false,
        metadata: { width: 1920, height: 1080 },
      });

      upsertAsset({
        id: 'audio_no_res',
        path: 'sound.wav',
        absolutePath: '/sound.wav',
        name: 'sound.wav',
        extension: '.wav',
        category: 'audio',
        size: 500,
        mtime: 10,
        hash: 'hr4',
        isArchiveEntry: false,
      });

      const resolutions = getAllResolutions();
      expect(resolutions).toHaveLength(2);

      const res64 = resolutions.find((r) => r.formatted === '64x64');
      expect(res64).toBeDefined();
      expect(res64!.count).toBe(2);
      expect(res64!.width).toBe(64);
      expect(res64!.height).toBe(64);

      const res1080 = resolutions.find((r) => r.formatted === '1920x1080');
      expect(res1080).toBeDefined();
      expect(res1080!.count).toBe(1);
    });
  });

  describe('Stack Management', () => {
    beforeEach(() => {
      upsertTaggedAsset({
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
        tags: ['knight'],
      });
      upsertTaggedAsset({
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
        tags: ['animated'],
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

      upsertTaggedAsset({
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
        tags: ['temp'],
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
      upsertTaggedAsset({
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
        metadata: { width: 64, height: 64 },
        tags: ['knight', 'pixel-art'],
      });

      upsertTaggedAsset({
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
        metadata: { width: 64, height: 64 },
        tags: ['knight'],
      });

      upsertTaggedAsset({
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
        tags: ['laser', 'sfx'],
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
      expect(res.summary.modelCount).toBe(0);
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

    it('should hide member assets included into a stack in stacked view while allowing separate content asset inspection', () => {
      const stacked = queryAssets({ isStackedView: true });
      // The member assets (img_k1, img_k2) should NOT appear as standalone items in stacked view
      const standaloneIds = stacked.items.map((i: any) => i.id);
      expect(standaloneIds).not.toContain('img_k2');
      expect(standaloneIds).toContain('stack_knight');
      expect(standaloneIds).toContain('snd_laser');

      // The stack must provide each of its content assets separately
      const stackAssets = getStackAssets('stack_knight');
      expect(stackAssets).toHaveLength(2);
      expect(stackAssets[0].id).toBe('img_k1');
      expect(stackAssets[0].name).toBe('Knight_Walk_01.png');
      expect(stackAssets[1].id).toBe('img_k2');
      expect(stackAssets[1].name).toBe('Knight_Walk_02.png');

      // Full stack retrieval must also include the content assets array
      const stackDetails = getStackById('stack_knight');
      expect(stackDetails).not.toBeNull();
      expect(stackDetails!.assets).toHaveLength(2);
      expect(stackDetails!.assets![0].name).toBe('Knight_Walk_01.png');
      expect(stackDetails!.assets![1].name).toBe('Knight_Walk_02.png');
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

    it('should filter queryAssets with expressions: size, tags, ext, boolean logic', () => {
      // Size filter: size:<300 matches img_k1 (100) and img_k2 (200), excludes snd_laser (500)
      const sizeLess = queryAssets({ search: 'size:<300', isStackedView: false });
      expect(sizeLess.items).toHaveLength(2);
      expect(sizeLess.items.map((i: any) => i.id)).toEqual(['img_k1', 'img_k2']);

      // Size filter: size:>400 matches snd_laser (500)
      const sizeGreater = queryAssets({ search: 'size:>400', isStackedView: false });
      expect(sizeGreater.items).toHaveLength(1);
      expect(sizeGreater.items[0].id).toBe('snd_laser');

      // Size with plus suffix: size:200+
      const sizePlus = queryAssets({ search: 'size:200+', isStackedView: false });
      expect(sizePlus.items).toHaveLength(2);
      expect(sizePlus.items.map((i: any) => i.id)).toEqual(['img_k2', 'snd_laser']);

      // Extension filter: ext:wav
      const extWav = queryAssets({ search: 'ext:wav', isStackedView: false });
      expect(extWav.items).toHaveLength(1);
      expect(extWav.items[0].id).toBe('snd_laser');

      // Category filter: cat:audio
      const catAudio = queryAssets({ search: 'cat:audio', isStackedView: false });
      expect(catAudio.items).toHaveLength(1);
      expect(catAudio.items[0].id).toBe('snd_laser');

      // Boolean OR filter: tag:laser OR tag:pixel-art
      const tagOr = queryAssets({ search: 'tag:laser OR tag:pixel-art', isStackedView: false });
      expect(tagOr.items).toHaveLength(2);
      expect(tagOr.items.map((i: any) => i.id)).toContain('img_k1');
      expect(tagOr.items.map((i: any) => i.id)).toContain('snd_laser');

      // Negative tag filter: -tag:knight (only laser_gun is not tagged knight)
      const notKnight = queryAssets({ search: '-tag:knight', isStackedView: false });
      expect(notKnight.items).toHaveLength(1);
      expect(notKnight.items[0].id).toBe('snd_laser');

      // Grouped query: (tag:knight OR tag:laser) AND size:<200
      const grouped = queryAssets({ search: '(tag:knight OR tag:laser) AND size:<200', isStackedView: false });
      expect(grouped.items).toHaveLength(1);
      expect(grouped.items[0].id).toBe('img_k1');
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

    it('should filter queryAssets by resolution parameter', () => {
      upsertTaggedAsset({
        id: 'img_hd_1',
        path: 'backgrounds/forest.png',
        absolutePath: '/backgrounds/forest.png',
        name: 'forest.png',
        extension: '.png',
        category: 'image',
        size: 3000,
        mtime: 4000,
        hash: 'h_hd',
        isArchiveEntry: false,
        metadata: { width: 1920, height: 1080 },
        tags: ['env'],
      });

      // Exact resolution: 64x64 matches img_k1 and img_k2
      const res64Flat = queryAssets({ resolution: '64x64', isStackedView: false });
      expect(res64Flat.items).toHaveLength(2);
      expect(res64Flat.items.map((i: any) => i.id)).toEqual(['img_k1', 'img_k2']);

      // Exact resolution in stacked view matches stack_knight
      const res64Stacked = queryAssets({ resolution: '64x64', isStackedView: true });
      expect(res64Stacked.items).toHaveLength(1);
      expect(res64Stacked.items[0].name).toBe('Knight Walk');

      // Preset resolution: square matches 64x64
      const resSquare = queryAssets({ resolution: 'square', isStackedView: false });
      expect(resSquare.items).toHaveLength(2);

      // Preset resolution: <=64
      const resTiny = queryAssets({ resolution: '<=64', isStackedView: false });
      expect(resTiny.items).toHaveLength(2);

      // Preset resolution: large or >1024 matches 1920x1080
      const resLarge = queryAssets({ resolution: 'large', isStackedView: false });
      expect(resLarge.items).toHaveLength(1);
      expect(resLarge.items[0].id).toBe('img_hd_1');

      // Audio is never matched by resolution
      const resAudio = queryAssets({ resolution: '64x64', category: 'audio', isStackedView: false });
      expect(resAudio.items).toHaveLength(0);
    });

    it('should sort queryAssets by resolution ascending and descending', () => {
      upsertAsset({
        id: 'img_hd_2',
        path: 'backgrounds/sky.png',
        absolutePath: '/backgrounds/sky.png',
        name: 'sky.png',
        extension: '.png',
        category: 'image',
        size: 2500,
        mtime: 4500,
        hash: 'h_sky',
        isArchiveEntry: false,
        metadata: { width: 1920, height: 1080 },
      });

      const resDesc = queryAssets({ sortBy: 'resolution', sortOrder: 'desc', isStackedView: false });
      // 1920x1080 (2,073,600) should come before 64x64 (4096)
      expect(resDesc.items[0].id).toBe('img_hd_2');

      const resAsc = queryAssets({ category: 'image', sortBy: 'resolution', sortOrder: 'asc', isStackedView: false });
      // 64x64 (4096) should come before 1920x1080
      expect((resAsc.items[0] as any).metadata.width).toBe(64);
      expect((resAsc.items[resAsc.items.length - 1] as any).metadata.width).toBe(1920);
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

    it('should aggregate detected BPMs via getAllBpms', () => {
      upsertAsset({
        id: 'snd_bpm1',
        path: 'music/track1.wav',
        absolutePath: '/music/track1.wav',
        name: 'track1.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_b1',
        isArchiveEntry: false,
        metadata: { duration: 120, bpm: 128 },
      });

      upsertAsset({
        id: 'snd_bpm2',
        path: 'music/track2.wav',
        absolutePath: '/music/track2.wav',
        name: 'track2.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_b2',
        isArchiveEntry: false,
        metadata: { duration: 60, bpm: 128 },
      });

      upsertAsset({
        id: 'snd_bpm3',
        path: 'music/track3.wav',
        absolutePath: '/music/track3.wav',
        name: 'track3.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_b3',
        isArchiveEntry: false,
        metadata: { duration: 45, bpm: 85 },
      });

      const bpms = getAllBpms();
      expect(bpms.length).toBeGreaterThanOrEqual(2);
      const b128 = bpms.find((b) => b.bpm === 128);
      expect(b128).toBeDefined();
      expect(b128!.count).toBe(2);
      expect(b128!.formatted).toBe('128 BPM');

      const b85 = bpms.find((b) => b.bpm === 85);
      expect(b85).toBeDefined();
      expect(b85!.count).toBe(1);
    });

    it('should filter queryAssets by bpm parameter', () => {
      upsertAsset({
        id: 'snd_dance',
        path: 'music/dance.wav',
        absolutePath: '/music/dance.wav',
        name: 'dance.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_dance',
        isArchiveEntry: false,
        metadata: { bpm: 128 },
      });
      upsertAsset({
        id: 'snd_chill',
        path: 'music/chill.wav',
        absolutePath: '/music/chill.wav',
        name: 'chill.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_chill',
        isArchiveEntry: false,
        metadata: { bpm: 75 },
      });

      // Exact BPM
      const exact = queryAssets({ bpm: '128', isStackedView: false });
      expect(exact.items.map((i: any) => i.id)).toContain('snd_dance');
      expect(exact.items.map((i: any) => i.id)).not.toContain('snd_chill');

      // Preset BPM: slow (<90)
      const slow = queryAssets({ bpm: 'slow', isStackedView: false });
      expect(slow.items.map((i: any) => i.id)).toContain('snd_chill');
      expect(slow.items.map((i: any) => i.id)).not.toContain('snd_dance');

      // Preset BPM: fast (120-160)
      const fast = queryAssets({ bpm: 'fast', isStackedView: false });
      expect(fast.items.map((i: any) => i.id)).toContain('snd_dance');
      expect(fast.items.map((i: any) => i.id)).not.toContain('snd_chill');

      // Comparison BPM
      const gt100 = queryAssets({ bpm: '>100', isStackedView: false });
      expect(gt100.items.map((i: any) => i.id)).toContain('snd_dance');
      expect(gt100.items.map((i: any) => i.id)).not.toContain('snd_chill');

      // Range BPM
      const range = queryAssets({ bpm: '70-80', isStackedView: false });
      expect(range.items.map((i: any) => i.id)).toContain('snd_chill');
      expect(range.items.map((i: any) => i.id)).not.toContain('snd_dance');
    });

    it('should filter queryAssets by width and height parameters', () => {
      upsertAsset({
        id: 'img_wide',
        path: 'ui/banner.png',
        absolutePath: '/ui/banner.png',
        name: 'banner.png',
        extension: '.png',
        category: 'image',
        size: 1000,
        mtime: 1000,
        hash: 'h_wide',
        isArchiveEntry: false,
        metadata: { width: 800, height: 100 },
      });

      // Width filter
      const w800 = queryAssets({ width: '800', isStackedView: false });
      expect(w800.items.map((i: any) => i.id)).toContain('img_wide');
      expect(w800.items.map((i: any) => i.id)).not.toContain('img_k1');

      // Height filter
      const h100 = queryAssets({ height: '100', isStackedView: false });
      expect(h100.items.map((i: any) => i.id)).toContain('img_wide');
      expect(h100.items.map((i: any) => i.id)).not.toContain('img_k1');

      // Height preset <=64 matches 64x64 knight
      const hTiny = queryAssets({ height: '<=64', isStackedView: false });
      expect(hTiny.items.map((i: any) => i.id)).toContain('img_k1');
      expect(hTiny.items.map((i: any) => i.id)).not.toContain('img_wide');
    });

    it('should filter queryAssets by duration parameter', () => {
      upsertAsset({
        id: 'snd_sfx_short',
        path: 'sfx/coin.wav',
        absolutePath: '/sfx/coin.wav',
        name: 'coin.wav',
        extension: '.wav',
        category: 'audio',
        size: 100,
        mtime: 1000,
        hash: 'h_coin',
        isArchiveEntry: false,
        metadata: { duration: 0.8 },
      });
      upsertAsset({
        id: 'snd_song_long',
        path: 'music/theme.ogg',
        absolutePath: '/music/theme.ogg',
        name: 'theme.ogg',
        extension: '.ogg',
        category: 'audio',
        size: 5000,
        mtime: 1000,
        hash: 'h_theme',
        isArchiveEntry: false,
        metadata: { duration: 180 },
      });

      // Duration preset short (< 5s)
      const short = queryAssets({ duration: 'short', isStackedView: false });
      expect(short.items.map((i: any) => i.id)).toContain('snd_sfx_short');
      expect(short.items.map((i: any) => i.id)).not.toContain('snd_song_long');

      // Duration preset music (> 120s)
      const music = queryAssets({ duration: 'music', isStackedView: false });
      expect(music.items.map((i: any) => i.id)).toContain('snd_song_long');
      expect(music.items.map((i: any) => i.id)).not.toContain('snd_sfx_short');

      // Comparison duration
      const gt10 = queryAssets({ duration: '>10', isStackedView: false });
      expect(gt10.items.map((i: any) => i.id)).toContain('snd_song_long');
      expect(gt10.items.map((i: any) => i.id)).not.toContain('snd_sfx_short');
    });

    it('should sort queryAssets by bpm, duration, width, height', () => {
      upsertAsset({
        id: 'snd_fast_bpm',
        path: 'music/fast.wav',
        absolutePath: '/music/fast.wav',
        name: 'fast.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_fbpm',
        isArchiveEntry: false,
        metadata: { bpm: 175, duration: 15 },
      });
      upsertAsset({
        id: 'snd_slow_bpm',
        path: 'music/slow.wav',
        absolutePath: '/music/slow.wav',
        name: 'slow.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 1000,
        hash: 'h_sbpm',
        isArchiveEntry: false,
        metadata: { bpm: 60, duration: 240 },
      });

      // Sort by BPM desc
      const bpmDesc = queryAssets({ category: 'audio', sortBy: 'bpm', sortOrder: 'desc', isStackedView: false });
      expect(bpmDesc.items[0].id).toBe('snd_fast_bpm');

      // Sort by BPM asc
      const bpmAsc = queryAssets({ category: 'audio', sortBy: 'bpm', sortOrder: 'asc', isStackedView: false });
      const nonZeroBpm = bpmAsc.items.filter((i: any) => i.metadata?.bpm);
      expect(nonZeroBpm[0].id).toBe('snd_slow_bpm');

      // Sort by Duration desc
      const durDesc = queryAssets({ category: 'audio', sortBy: 'duration', sortOrder: 'desc', isStackedView: false });
      expect(durDesc.items[0].id).toBe('snd_slow_bpm');

      // Sort by Duration asc
      const durAsc = queryAssets({ category: 'audio', sortBy: 'duration', sortOrder: 'asc', isStackedView: false });
      const nonZeroDur = durAsc.items.filter((i: any) => i.metadata?.duration);
      expect(nonZeroDur[0].id).toBe('snd_fast_bpm');

      // Sort by Width desc
      upsertAsset({
        id: 'img_huge_w',
        path: 'ui/huge.png',
        absolutePath: '/ui/huge.png',
        name: 'huge.png',
        extension: '.png',
        category: 'image',
        size: 1000,
        mtime: 1000,
        hash: 'h_huge',
        isArchiveEntry: false,
        metadata: { width: 2560, height: 100 },
      });

      const wDesc = queryAssets({ category: 'image', sortBy: 'width', sortOrder: 'desc', isStackedView: false });
      expect(wDesc.items[0].id).toBe('img_huge_w');

      // Sort by Height desc
      upsertAsset({
        id: 'img_tall_h',
        path: 'ui/tall.png',
        absolutePath: '/ui/tall.png',
        name: 'tall.png',
        extension: '.png',
        category: 'image',
        size: 1000,
        mtime: 1000,
        hash: 'h_tall',
        isArchiveEntry: false,
        metadata: { width: 100, height: 3000 },
      });

      const hDesc = queryAssets({ category: 'image', sortBy: 'height', sortOrder: 'desc', isStackedView: false });
      expect(hDesc.items[0].id).toBe('img_tall_h');
    });
  });

  describe('Asset & Stack Tag Assignment and Removal', () => {
    beforeEach(() => {
      upsertTaggedAsset({
        id: 'asset_tag_1',
        path: 'sprites/hero.png',
        absolutePath: path.join(tempDir, 'sprites/hero.png'),
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: 1024,
        mtime: 100,
        hash: 'h_tag_1',
        isArchiveEntry: false,
        tags: ['pixel-art'],
      });

      upsertTaggedAsset({
        id: 'asset_tag_2',
        path: 'sprites/enemy.png',
        absolutePath: path.join(tempDir, 'sprites/enemy.png'),
        name: 'enemy.png',
        extension: '.png',
        category: 'image',
        size: 2048,
        mtime: 100,
        hash: 'h_tag_2',
        isArchiveEntry: false,
        tags: ['monster'],
      });
    });

    it('should assign single and multiple tags to an asset with user source', () => {
      // Add single tag as string
      const updated1 = addAssetTags('asset_tag_1', ['character']);
      expect(updated1).not.toBeNull();
      expect(updated1!.tags).toContain('character');
      expect(updated1!.tags).toContain('pixel-art');

      // Add tag with leading hash and object format
      const updated2 = addAssetTags('asset_tag_1', [{ tag: '#animated', source: 'user' }]);
      expect(updated2!.tags).toContain('animated');
      expect(updated2!.tags).not.toContain('#animated');

      // Check DB directly for source
      const db = getDatabase();
      const row = db.prepare('SELECT source FROM tags WHERE asset_id = ? AND tag = ?').get('asset_tag_1', 'character') as any;
      expect(row.source).toBe('user');
    });

    it('should ignore empty tags and duplicate tags (case-insensitive)', () => {
      addAssetTags('asset_tag_1', ['  ', '#', 'character', 'Character', 'CHARACTER']);
      const asset = getAssetById('asset_tag_1');
      expect(asset!.tags.filter((t) => t.toLowerCase() === 'character').length).toBe(1);
      expect(asset!.tags).not.toContain('');
    });

    it('should remove a single tag from an asset (case-insensitive and leading hash support)', () => {
      addAssetTags('asset_tag_1', ['character', 'warrior']);
      let asset = getAssetById('asset_tag_1');
      expect(asset!.tags).toContain('character');

      // Remove with different case and leading hash
      const removed = removeAssetTag('asset_tag_1', '#CHARACTER');
      expect(removed).toBe(true);

      asset = getAssetById('asset_tag_1');
      expect(asset!.tags).not.toContain('character');
      expect(asset!.tags).toContain('warrior');

      // Removing non-existent tag returns false
      const removedAgain = removeAssetTag('asset_tag_1', 'nonexistent');
      expect(removedAgain).toBe(false);
    });

    it('should remove multiple tags from an asset at once', () => {
      addAssetTags('asset_tag_1', ['tag_a', 'tag_b', 'tag_c']);
      let asset = getAssetById('asset_tag_1');
      expect(asset!.tags).toContain('tag_a');
      expect(asset!.tags).toContain('tag_b');
      expect(asset!.tags).toContain('tag_c');

      const count = removeAssetTags('asset_tag_1', ['#tag_a', 'tag_b']);
      expect(count).toBe(2);

      asset = getAssetById('asset_tag_1');
      expect(asset!.tags).not.toContain('tag_a');
      expect(asset!.tags).not.toContain('tag_b');
      expect(asset!.tags).toContain('tag_c');
    });

    it('should replace all tags on an asset using setAssetTags', () => {
      addAssetTags('asset_tag_1', ['old1', 'old2']);
      const asset = setAssetTags('asset_tag_1', ['new_alpha', '#new_beta']);
      expect(asset).not.toBeNull();
      expect(asset!.tags).toEqual(['new_alpha', 'new_beta']);
    });

    it('should batch add and remove tags across multiple assets', () => {
      const added = addTagsToAssets(['asset_tag_1', 'asset_tag_2'], ['common_tag', 'game']);
      expect(added.length).toBe(2);

      const a1 = getAssetById('asset_tag_1');
      const a2 = getAssetById('asset_tag_2');
      expect(a1!.tags).toContain('common_tag');
      expect(a2!.tags).toContain('common_tag');

      const removed = removeTagsFromAssets(['asset_tag_1', 'asset_tag_2'], ['common_tag']);
      expect(removed.length).toBe(2);

      const a1After = getAssetById('asset_tag_1');
      const a2After = getAssetById('asset_tag_2');
      expect(a1After!.tags).not.toContain('common_tag');
      expect(a2After!.tags).not.toContain('common_tag');
    });

    it('should assign and remove tags to/from all member assets in a stack', () => {
      upsertAsset({
        id: 'frame_1',
        path: 'sprites/walk_01.png',
        absolutePath: path.join(tempDir, 'sprites/walk_01.png'),
        name: 'walk_01.png',
        extension: '.png',
        category: 'image',
        size: 500,
        mtime: 100,
        hash: 'h_f1',
        isArchiveEntry: false,
      });

      upsertAsset({
        id: 'frame_2',
        path: 'sprites/walk_02.png',
        absolutePath: path.join(tempDir, 'sprites/walk_02.png'),
        name: 'walk_02.png',
        extension: '.png',
        category: 'image',
        size: 500,
        mtime: 100,
        hash: 'h_f2',
        isArchiveEntry: false,
      });

      createStack({
        id: 'stack_walk',
        name: 'walk',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'frame_1',
        assetIdsWithIndex: [
          { assetId: 'frame_1', index: 0 },
          { assetId: 'frame_2', index: 1 },
        ],
      });

      // Add tag to stack
      const updatedStack = addTagsToStack('stack_walk', ['walking_anim']);
      expect(updatedStack).not.toBeNull();
      expect(updatedStack!.tags).toContain('walking_anim');

      // Both frame assets should have the tag
      const f1 = getAssetById('frame_1');
      const f2 = getAssetById('frame_2');
      expect(f1!.tags).toContain('walking_anim');
      expect(f2!.tags).toContain('walking_anim');

      // Remove tag from stack
      const stackAfterRemoval = removeTagsFromStack('stack_walk', ['walking_anim']);
      expect(stackAfterRemoval!.tags).not.toContain('walking_anim');

      const f1After = getAssetById('frame_1');
      const f2After = getAssetById('frame_2');
      expect(f1After!.tags).not.toContain('walking_anim');
      expect(f2After!.tags).not.toContain('walking_anim');
    });

    it('should update getAllTags counts when tags are assigned and removed', () => {
      const initialTags = getAllTags();
      const initialCustom = initialTags.find((t) => t.name === 'custom_flag');
      expect(initialCustom).toBeUndefined();

      addAssetTags('asset_tag_1', ['custom_flag']);
      addAssetTags('asset_tag_2', ['custom_flag']);

      const tagsAfterAdd = getAllTags();
      const customTag = tagsAfterAdd.find((t) => t.name === 'custom_flag');
      expect(customTag).toBeDefined();
      expect(customTag!.count).toBe(2);

      removeAssetTag('asset_tag_1', 'custom_flag');
      const tagsAfterRemoveOne = getAllTags();
      const customTagRemaining = tagsAfterRemoveOne.find((t) => t.name === 'custom_flag');
      expect(customTagRemaining!.count).toBe(1);

      removeAssetTag('asset_tag_2', 'custom_flag');
      const tagsAfterRemoveAll = getAllTags();
      const customTagGone = tagsAfterRemoveAll.find((t) => t.name === 'custom_flag');
      expect(customTagGone).toBeUndefined();
    });
  });
});
