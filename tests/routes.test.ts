import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import {
  initDatabase,
  closeDatabase,
  upsertAsset,
  createStack,
  updateAppSettings,
} from '../server/src/db/database.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
  createTestWavBuffer,
  createTestBpmWavBuffer,
  createTestTgaBuffer,
} from './helpers.js';

describe('HTTP API Routes', () => {
  let app: FastifyInstance;
  let tempLibraryDir: string;
  let tempProjectDir: string;

  beforeEach(async () => {
    tempLibraryDir = createTempDir('routes-lib-');
    tempProjectDir = createTempDir('routes-proj-');

    initDatabase(tempLibraryDir);
    updateAppSettings({
      libraryPath: tempLibraryDir,
      activeProjectPath: tempProjectDir,
    });

    app = await buildServer({
      initDb: false, // already initialized
      logger: false,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    cleanupTempDir(tempLibraryDir);
    cleanupTempDir(tempProjectDir);
  });

  describe('GET /api/assets & Sub-routes', () => {
    beforeEach(() => {
      // Seed assets
      const diskPng = path.join(tempLibraryDir, 'hero.png');
      fs.writeFileSync(diskPng, TINY_PNG_BUFFER);

      const diskThumb = path.join(tempLibraryDir, '.assettlor', 'thumbnails', 'hero_id.webp');
      fs.writeFileSync(diskThumb, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'hero_id',
        path: 'hero.png',
        absolutePath: diskPng,
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: 1000,
        hash: 'h_hero',
        isArchiveEntry: false,
        thumbnailPath: diskThumb,
        metadata: { width: 1, height: 1 },
        tags: [{ tag: 'player', source: 'auto' }],
      });

      const wavBuf = createTestWavBuffer(0.1, 8000);
      const diskWav = path.join(tempLibraryDir, 'laser.wav');
      fs.writeFileSync(diskWav, wavBuf);

      upsertAsset({
        id: 'laser_id',
        path: 'laser.wav',
        absolutePath: diskWav,
        name: 'laser.wav',
        extension: '.wav',
        category: 'audio',
        size: wavBuf.length,
        mtime: 2000,
        hash: 'h_laser',
        isArchiveEntry: false,
        metadata: { duration: 0.1, bpm: 120 },
        tags: [{ tag: 'sfx', source: 'auto' }],
      });
    });

    it('GET /api/assets should list assets and return summary', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/assets',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(2);
      expect(body.items).toHaveLength(2);
      expect(body.summary.imageCount).toBe(1);
      expect(body.summary.audioCount).toBe(1);
    });

    it('GET /api/assets with category and search filter', async () => {
      const catRes = await app.inject({
        method: 'GET',
        url: '/api/assets?category=image',
      });
      expect(catRes.statusCode).toBe(200);
      const catBody = catRes.json();
      expect(catBody.items).toHaveLength(1);
      expect(catBody.items[0].id).toBe('hero_id');

      const searchRes = await app.inject({
        method: 'GET',
        url: '/api/assets?search=laser',
      });
      expect(searchRes.statusCode).toBe(200);
      const searchBody = searchRes.json();
      expect(searchBody.items).toHaveLength(1);
      expect(searchBody.items[0].id).toBe('laser_id');

      // Test filter expression in search parameter
      const exprRes = await app.inject({
        method: 'GET',
        url: '/api/assets?search=' + encodeURIComponent('size:<2000 ext:png'),
      });
      expect(exprRes.statusCode).toBe(200);
      const exprBody = exprRes.json();
      expect(exprBody.items).toHaveLength(1);
      expect(exprBody.items[0].id).toBe('hero_id');

      // Test resolution parameter
      const resParamRes = await app.inject({
        method: 'GET',
        url: '/api/assets?resolution=1x1',
      });
      expect(resParamRes.statusCode).toBe(200);
      const resParamBody = resParamRes.json();
      expect(resParamBody.items).toHaveLength(1);
      expect(resParamBody.items[0].id).toBe('hero_id');

      // Test resolution expression in search parameter
      const resExprRes = await app.inject({
        method: 'GET',
        url: '/api/assets?search=' + encodeURIComponent('res:1x1'),
      });
      expect(resExprRes.statusCode).toBe(200);
      const resExprBody = resExprRes.json();
      expect(resExprBody.items).toHaveLength(1);
      expect(resExprBody.items[0].id).toBe('hero_id');

      // Test bpm query parameter
      const bpmRes = await app.inject({
        method: 'GET',
        url: '/api/assets?bpm=120',
      });
      expect(bpmRes.statusCode).toBe(200);
      const bpmBody = bpmRes.json();
      expect(bpmBody.items).toHaveLength(1);
      expect(bpmBody.items[0].id).toBe('laser_id');

      // Test width and height query parameters
      const widthRes = await app.inject({
        method: 'GET',
        url: '/api/assets?width=1',
      });
      expect(widthRes.statusCode).toBe(200);
      expect(widthRes.json().items).toHaveLength(1);
      expect(widthRes.json().items[0].id).toBe('hero_id');

      const heightRes = await app.inject({
        method: 'GET',
        url: '/api/assets?height=1',
      });
      expect(heightRes.statusCode).toBe(200);
      expect(heightRes.json().items).toHaveLength(1);
      expect(heightRes.json().items[0].id).toBe('hero_id');

      // Test duration query parameter
      const durRes = await app.inject({
        method: 'GET',
        url: '/api/assets?duration=<1',
      });
      expect(durRes.statusCode).toBe(200);
      expect(durRes.json().items).toHaveLength(1);
      expect(durRes.json().items[0].id).toBe('laser_id');

      // Test sorting by bpm and duration
      const sortBpmRes = await app.inject({
        method: 'GET',
        url: '/api/assets?sortBy=bpm&sortOrder=desc',
      });
      expect(sortBpmRes.statusCode).toBe(200);
      expect(sortBpmRes.json().items[0].id).toBe('laser_id');

      const sortDurRes = await app.inject({
        method: 'GET',
        url: '/api/assets?sortBy=duration&sortOrder=desc',
      });
      expect(sortDurRes.statusCode).toBe(200);
      expect(sortDurRes.json().items[0].id).toBe('laser_id');
    });

    it('GET /api/assets/:id should return asset by id or 404', async () => {
      const okRes = await app.inject({
        method: 'GET',
        url: '/api/assets/hero_id',
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().name).toBe('hero.png');

      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/assets/non_existent_id',
      });
      expect(notFoundRes.statusCode).toBe(404);
      expect(notFoundRes.json().error).toMatch(/not found/i);
    });

    it('GET /api/assets/:id/thumbnail should serve WebP thumbnail or 404', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/assets/hero_id/thumbnail',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/webp');
      expect(res.rawPayload.length).toBeGreaterThan(0);

      // 404 on unknown asset
      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/assets/does_not_exist/thumbnail',
      });
      expect(notFoundRes.statusCode).toBe(404);

      // 404 when thumbnail file missing
      const noThumbRes = await app.inject({
        method: 'GET',
        url: '/api/assets/laser_id/thumbnail',
      });
      expect(noThumbRes.statusCode).toBe(404);
    });

    it('GET /api/assets/:id/file should serve regular file and support byte ranges (HTTP 206)', async () => {
      // Full download
      const fullRes = await app.inject({
        method: 'GET',
        url: '/api/assets/hero_id/file',
      });
      expect(fullRes.statusCode).toBe(200);
      expect(fullRes.headers['content-type']).toBe('image/png');
      expect(fullRes.rawPayload.equals(TINY_PNG_BUFFER)).toBe(true);

      // Range download (HTTP 206)
      const rangeRes = await app.inject({
        method: 'GET',
        url: '/api/assets/hero_id/file',
        headers: { range: 'bytes=0-3' },
      });
      expect(rangeRes.statusCode).toBe(206);
      expect(rangeRes.headers['content-range']).toMatch(/^bytes 0-3\//);
      expect(rangeRes.rawPayload.length).toBe(4);

      // Invalid range (HTTP 416)
      const invalidRangeRes = await app.inject({
        method: 'GET',
        url: '/api/assets/hero_id/file',
        headers: { range: 'bytes=99999-999999' },
      });
      expect(invalidRangeRes.statusCode).toBe(416);
    });

    it('GET /api/assets/:id/file should serve TGA file with image/x-tga content-type', async () => {
      const diskTga = path.join(tempLibraryDir, 'stone_brick_tile.tga');
      const tgaBuf = createTestTgaBuffer(2, 2, false);
      fs.writeFileSync(diskTga, tgaBuf);

      upsertAsset({
        id: 'stone_brick_tile_id',
        path: 'stone_brick_tile.tga',
        absolutePath: diskTga,
        name: 'stone_brick_tile.tga',
        extension: '.tga',
        category: 'image',
        size: tgaBuf.length,
        mtime: 3000,
        hash: 'h_tile',
        isArchiveEntry: false,
        metadata: { width: 2, height: 2, format: 'tga' },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/assets/stone_brick_tile_id/file',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/x-tga');
      expect(res.rawPayload.equals(tgaBuf)).toBe(true);
    });

    it('GET /api/assets/:id/file should stream virtual zip entries with ranges', async () => {
      const zipPath = path.join(tempLibraryDir, 'pack.zip');
      const innerContent = Buffer.from('Zip file inner content text 1234567890');
      createTestZipArchive(zipPath, [
        { name: 'inner/data.wav', content: innerContent },
      ]);

      upsertAsset({
        id: 'zip_entry_id',
        path: 'pack.zip#/inner/data.wav',
        absolutePath: zipPath,
        name: 'data.wav',
        extension: '.wav',
        category: 'audio',
        size: innerContent.length,
        mtime: 100,
        hash: 'h_zip_entry',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'inner/data.wav',
      });

      // Full zip entry download
      const fullRes = await app.inject({
        method: 'GET',
        url: '/api/assets/zip_entry_id/file',
      });
      expect(fullRes.statusCode).toBe(200);
      expect(fullRes.rawPayload.equals(innerContent)).toBe(true);

      // Range request on zip entry
      const rangeRes = await app.inject({
        method: 'GET',
        url: '/api/assets/zip_entry_id/file',
        headers: { range: 'bytes=0-5' },
      });
      expect(rangeRes.statusCode).toBe(206);
      expect(rangeRes.rawPayload.length).toBe(6);

      // 416 Range Not Satisfiable on zip entry
      const badRangeRes = await app.inject({
        method: 'GET',
        url: '/api/assets/zip_entry_id/file',
        headers: { range: 'bytes=999-1000' },
      });
      expect(badRangeRes.statusCode).toBe(416);
    });

    it('GET /api/assets/:id/file and /thumbnail should handle long asset IDs exceeding 100 characters', async () => {
      const zipPath = path.join(tempLibraryDir, 'databreache_joelsteudler.zip');
      const innerWav = createTestWavBuffer(1.0, 8000);
      const entryName = 'Data Breach/Conspiracy_Theory_-_128bpm_120s.wav';
      createTestZipArchive(zipPath, [
        { name: entryName, content: innerWav },
      ]);

      const virtualPath = `databreache_joelsteudler.zip#/${entryName}`;
      const longId = `zip_${Buffer.from(virtualPath).toString('base64url')}`;
      expect(longId.length).toBeGreaterThan(100);

      const diskThumb = path.join(tempLibraryDir, '.assettlor', 'thumbnails', `${longId}.webp`);
      fs.mkdirSync(path.dirname(diskThumb), { recursive: true });
      fs.writeFileSync(diskThumb, TINY_PNG_BUFFER);

      upsertAsset({
        id: longId,
        path: virtualPath,
        absolutePath: zipPath,
        name: 'Conspiracy_Theory_-_128bpm_120s.wav',
        extension: '.wav',
        category: 'audio',
        size: innerWav.length,
        mtime: 100,
        hash: 'h_long_audio',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: entryName,
        thumbnailPath: diskThumb,
        metadata: { duration: 120, bpm: 128 },
      });

      // GET asset by long ID
      const assetRes = await app.inject({
        method: 'GET',
        url: `/api/assets/${encodeURIComponent(longId)}`,
      });
      expect(assetRes.statusCode).toBe(200);
      expect(assetRes.json().id).toBe(longId);

      // GET thumbnail by long ID
      const thumbRes = await app.inject({
        method: 'GET',
        url: `/api/assets/${encodeURIComponent(longId)}/thumbnail`,
      });
      expect(thumbRes.statusCode).toBe(200);

      // GET file by long ID
      const fileRes = await app.inject({
        method: 'GET',
        url: `/api/assets/${encodeURIComponent(longId)}/file`,
      });
      expect(fileRes.statusCode).toBe(200);
      expect(fileRes.headers['content-type']).toBe('audio/wav');
      expect(fileRes.rawPayload.equals(innerWav)).toBe(true);

      // Range request by long ID
      const rangeRes = await app.inject({
        method: 'GET',
        url: `/api/assets/${encodeURIComponent(longId)}/file`,
        headers: { range: 'bytes=0-99' },
      });
      expect(rangeRes.statusCode).toBe(206);
      expect(rangeRes.rawPayload.length).toBe(100);
    });

    it('GET /api/assets/:id/file should return 404 if file is missing on disk', async () => {
      upsertAsset({
        id: 'missing_disk_file',
        path: 'ghost.png',
        absolutePath: path.join(tempLibraryDir, 'ghost.png'),
        name: 'ghost.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 100,
        hash: 'h_ghost',
        isArchiveEntry: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/assets/missing_disk_file/file',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/missing on disk/i);
    });

    it('GET /api/assets/:id/file should return 404 if archive entry is missing inside zip', async () => {
      const zipPath = path.join(tempLibraryDir, 'pack_empty.zip');
      createTestZipArchive(zipPath, []);

      upsertAsset({
        id: 'missing_zip_entry',
        path: 'pack_empty.zip#/not_here.png',
        absolutePath: zipPath,
        name: 'not_here.png',
        extension: '.png',
        category: 'image',
        size: 100,
        mtime: 100,
        hash: 'h_not_here',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'not_here.png',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/assets/missing_zip_entry/file',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toMatch(/Entry not found in archive/i);
    });

    it('GET /api/tags should return list of tags', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/tags',
      });
      expect(res.statusCode).toBe(200);
      const tags = res.json();
      expect(Array.isArray(tags)).toBe(true);
      expect(tags.some((t: any) => t.name === 'player')).toBe(true);
    });

    it('GET /api/formats should return list of formats', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/formats',
      });
      expect(res.statusCode).toBe(200);
      const formats = res.json();
      expect(Array.isArray(formats)).toBe(true);
      expect(formats.some((f: any) => f.extension === '.png')).toBe(true);
    });

    it('GET /api/resolutions should return list of image resolutions', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/resolutions',
      });
      expect(res.statusCode).toBe(200);
      const resolutions = res.json();
      expect(Array.isArray(resolutions)).toBe(true);
      expect(resolutions.some((r: any) => r.formatted === '1x1')).toBe(true);
    });

    it('GET /api/bpms should return list of detected BPMs', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/bpms',
      });
      expect(res.statusCode).toBe(200);
      const bpms = res.json();
      expect(Array.isArray(bpms)).toBe(true);
      expect(bpms.some((b: any) => b.bpm === 120)).toBe(true);
    });

    it('POST /api/assets/copy should copy asset or return 404 when missing', async () => {
      const okRes = await app.inject({
        method: 'POST',
        url: '/api/assets/copy',
        payload: {
          assetId: 'hero_id',
          targetPath: tempProjectDir,
        },
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().success).toBe(true);

      const badRes = await app.inject({
        method: 'POST',
        url: '/api/assets/copy',
        payload: {
          assetId: 'non_existent_asset',
        },
      });
      expect(badRes.statusCode).toBe(404);
      expect(badRes.json().error).toMatch(/not found/i);
    });

    it('POST /api/assets/copy should copy entire stack', async () => {
      createStack({
        id: 'route_stack_1',
        name: 'Hero Walk',
        type: 'animation',
        itemCount: 1,
        representativeAssetId: 'hero_id',
        assetIdsWithIndex: [{ assetId: 'hero_id', index: 0 }],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/assets/copy',
        payload: {
          stackId: 'route_stack_1',
          copyStackAll: true,
          targetPath: tempProjectDir,
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().copiedFiles.length).toBe(1);
    });
  });

  describe('GET /api/stacks/:id & /assets', () => {
    beforeEach(() => {
      upsertAsset({
        id: 'f1',
        path: 'f1.png',
        absolutePath: '/f1.png',
        name: 'f1.png',
        extension: '.png',
        category: 'image',
        size: 10,
        mtime: 10,
        hash: 'h1',
        isArchiveEntry: false,
      });

      createStack({
        id: 'test_stack',
        name: 'Test Stack',
        type: 'animation',
        itemCount: 1,
        representativeAssetId: 'f1',
        assetIdsWithIndex: [{ assetId: 'f1', index: 0 }],
      });
    });

    it('should return stack by id and 404 for missing', async () => {
      const okRes = await app.inject({
        method: 'GET',
        url: '/api/stacks/test_stack',
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().name).toBe('Test Stack');

      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/stacks/non_existent',
      });
      expect(notFoundRes.statusCode).toBe(404);
    });

    it('should return stack assets', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/stacks/test_stack/assets',
      });
      expect(res.statusCode).toBe(200);
      const assets = res.json();
      expect(assets).toHaveLength(1);
      expect(assets[0].id).toBe('f1');
    });

    it('should hide member assets from /api/assets stacked results and serve each content asset via /api/stacks/:id/assets', async () => {
      // Add a second frame and new multi-frame stack
      upsertAsset({
        id: 'f2',
        path: 'f2.png',
        absolutePath: '/f2.png',
        name: 'f2.png',
        extension: '.png',
        category: 'image',
        size: 20,
        mtime: 20,
        hash: 'h2',
        isArchiveEntry: false,
      });

      createStack({
        id: 'multi_frame_stack',
        name: 'Multi Frame Stack',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'f1',
        assetIdsWithIndex: [
          { assetId: 'f1', index: 0 },
          { assetId: 'f2', index: 1 },
        ],
      });

      // GET /api/assets with stacked view (default)
      const listRes = await app.inject({
        method: 'GET',
        url: '/api/assets?isStackedView=true',
      });
      expect(listRes.statusCode).toBe(200);
      const items = listRes.json().items;
      const itemIds = items.map((i: any) => i.id);
      expect(itemIds).toContain('multi_frame_stack');
      expect(itemIds).not.toContain('f2');

      // GET /api/stacks/multi_frame_stack/assets provides each content asset separately
      const stackAssetsRes = await app.inject({
        method: 'GET',
        url: '/api/stacks/multi_frame_stack/assets',
      });
      expect(stackAssetsRes.statusCode).toBe(200);
      const stackAssets = stackAssetsRes.json();
      expect(stackAssets).toHaveLength(2);
      expect(stackAssets[0].name).toBe('f1.png');
      expect(stackAssets[1].name).toBe('f2.png');
    });
  });

  describe('Settings Routes (/api/settings)', () => {
    it('GET /api/settings and POST /api/settings', async () => {
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/settings',
      });
      expect(getRes.statusCode).toBe(200);
      const settings = getRes.json();
      expect(settings.libraryPath).toBe(tempLibraryDir);

      const postRes = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: {
          thumbnailQuality: 92,
          defaultFps: 16,
        },
      });
      expect(postRes.statusCode).toBe(200);
      const updated = postRes.json();
      expect(updated.thumbnailQuality).toBe(92);
      expect(updated.defaultFps).toBe(16);
    });
  });

  describe('Filesystem Routes (/api/fs)', () => {
    it('GET /api/fs/browse should return directory contents', async () => {
      // Create subdirectories
      fs.mkdirSync(path.join(tempLibraryDir, 'subdir_a'));
      fs.mkdirSync(path.join(tempLibraryDir, 'subdir_b'));
      fs.mkdirSync(path.join(tempLibraryDir, '.hidden_dir'));

      const res = await app.inject({
        method: 'GET',
        url: `/api/fs/browse?path=${encodeURIComponent(tempLibraryDir)}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.currentPath).toBe(tempLibraryDir);
      const dirNames = body.directories.map((d: any) => d.name);
      expect(dirNames).toContain('subdir_a');
      expect(dirNames).toContain('subdir_b');
      expect(dirNames).not.toContain('.hidden_dir');
    });

    it('POST /api/fs/validate should check path existence and isDirectory', async () => {
      const okRes = await app.inject({
        method: 'POST',
        url: '/api/fs/validate',
        payload: { path: tempLibraryDir },
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().exists).toBe(true);
      expect(okRes.json().isDirectory).toBe(true);

      const fakeRes = await app.inject({
        method: 'POST',
        url: '/api/fs/validate',
        payload: { path: '/totally/fake/path/does/not/exist' },
      });
      expect(fakeRes.statusCode).toBe(200);
      expect(fakeRes.json().exists).toBe(false);
    });
  });

  describe('Scan Routes (/api/scan)', () => {
    it('GET /api/scan/status should return current status', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/scan/status',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBeDefined();
    });

    it('POST /api/scan/start should start scan', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scan/start',
        payload: { libraryPath: tempLibraryDir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('Scan started');
    });

    it('POST /api/scan/start should return 400 if library path is not provided', async () => {
      updateAppSettings({ libraryPath: '' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/scan/start',
        payload: { libraryPath: '' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/Library path is required/i);
    });

    it('POST /api/scan/cancel should accept cancel request', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scan/cancel',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('Cancel requested');
    });

    it('POST /api/scan/rescan should start full rescan', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/scan/rescan',
        payload: { libraryPath: tempLibraryDir },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().message).toBe('Full rescan started');
      expect(res.json().fullRescan).toBe(true);
    });
  });

  describe('Static Client Serving & SPA Routing', () => {
    let distDir: string;
    let spaApp: FastifyInstance;

    beforeEach(async () => {
      distDir = createTempDir('dist-test-');
      fs.writeFileSync(
        path.join(distDir, 'index.html'),
        '<!DOCTYPE html><html><body>Assettlor Test SPA</body></html>'
      );
      spaApp = await buildServer({
        initDb: false,
        logger: false,
        clientDistPath: distDir,
      });
      await spaApp.ready();
    });

    afterEach(async () => {
      await spaApp.close();
      cleanupTempDir(distDir);
    });

    it('should serve index.html for root and SPA client routes', async () => {
      const rootRes = await spaApp.inject({
        method: 'GET',
        url: '/',
      });
      expect(rootRes.statusCode).toBe(200);
      expect(rootRes.payload).toContain('Assettlor Test SPA');

      const spaRes = await spaApp.inject({
        method: 'GET',
        url: '/view/animation/123',
      });
      expect(spaRes.statusCode).toBe(200);
      expect(spaRes.payload).toContain('Assettlor Test SPA');
    });

    it('should still return 404 JSON for missing /api routes with static client enabled', async () => {
      const res = await spaApp.inject({
        method: 'GET',
        url: '/api/missing-api-endpoint',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Endpoint not found');
    });
  });

  describe('Classifier API Routes', () => {
    it('GET /api/classifiers should list registered classifiers', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/classifiers',
      });
      expect(res.statusCode).toBe(200);
      const classifiers = res.json();
      expect(Array.isArray(classifiers)).toBe(true);
      const bpm = classifiers.find((c: any) => c.id === 'bpm');
      expect(bpm).toBeDefined();
      expect(bpm.name).toBe('BPM & Tempo Classifier');
      expect(bpm.steps.length).toBe(4);
    });

    it('GET /api/classifiers/:id should return details for valid classifier or 404', async () => {
      const okRes = await app.inject({
        method: 'GET',
        url: '/api/classifiers/bpm',
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().id).toBe('bpm');

      const notFoundRes = await app.inject({
        method: 'GET',
        url: '/api/classifiers/nonexistent',
      });
      expect(notFoundRes.statusCode).toBe(404);
    });

    it('PUT /api/classifiers/:id/settings should update and persist classifier settings', async () => {
      const updateRes = await app.inject({
        method: 'PUT',
        url: '/api/classifiers/bpm/settings',
        payload: {
          minBpm: 65,
          maxBpm: 195,
          applyTempoTag: true,
        },
      });
      expect(updateRes.statusCode).toBe(200);
      const body = updateRes.json();
      expect(body.success).toBe(true);
      expect(body.settings.minBpm).toBe(65);
      expect(body.settings.maxBpm).toBe(195);

      // Verify subsequent GET reflects updated settings
      const getRes = await app.inject({
        method: 'GET',
        url: '/api/classifiers/bpm',
      });
      expect(getRes.json().settings.minBpm).toBe(65);
    });

    it('POST /api/classifiers/:id/run should execute classifier on target scope', async () => {
      // Seed a test music track
      const rhythmicWav = createTestBpmWavBuffer(120, 4, 22050);
      const trackPath = path.join(tempLibraryDir, 'beat_track.wav');
      fs.writeFileSync(trackPath, rhythmicWav);

      upsertAsset({
        id: 'beat_track_id',
        path: 'beat_track.wav',
        absolutePath: trackPath,
        name: 'beat_track.wav',
        extension: '.wav',
        category: 'audio',
        size: rhythmicWav.length,
        mtime: Date.now(),
        hash: 'h_beat',
        isArchiveEntry: false,
        metadata: { duration: 4.0 },
      });

      const runRes = await app.inject({
        method: 'POST',
        url: '/api/classifiers/bpm/run',
        payload: {
          targetType: 'asset',
          targetValue: 'beat_track_id',
        },
      });

      expect(runRes.statusCode).toBe(200);
      const result = runRes.json();
      expect(result.classifierId).toBe('bpm');
      expect(result.totalTargeted).toBe(1);
      expect(result.classifiedCount).toBe(1);
      expect(result.details[0].result.bpm).toBe(120);

      // Verify asset metadata via GET /api/assets
      const assetRes = await app.inject({
        method: 'GET',
        url: '/api/assets?search=beat_track',
      });
      expect(assetRes.statusCode).toBe(200);
      const items = assetRes.json().items;
      expect(items.length).toBe(1);
      expect(items[0].metadata.bpm).toBe(120);
    });
  });

  describe('Tag Endpoints (/api/assets/:id/tags, /api/assets/tags, /api/stacks/:id/tags)', () => {
    beforeEach(() => {
      upsertAsset({
        id: 'route_tag_asset_1',
        path: 'sprites/knight.png',
        absolutePath: path.join(tempLibraryDir, 'sprites/knight.png'),
        name: 'knight.png',
        extension: '.png',
        category: 'image',
        size: 1024,
        mtime: 100,
        hash: 'h_rt_1',
        isArchiveEntry: false,
        tags: [{ tag: 'pixel-art', source: 'auto' }],
      });

      upsertAsset({
        id: 'route_tag_asset_2',
        path: 'sprites/orc.png',
        absolutePath: path.join(tempLibraryDir, 'sprites/orc.png'),
        name: 'orc.png',
        extension: '.png',
        category: 'image',
        size: 1024,
        mtime: 100,
        hash: 'h_rt_2',
        isArchiveEntry: false,
        tags: [{ tag: 'pixel-art', source: 'auto' }],
      });

      createStack({
        id: 'route_tag_stack_1',
        name: 'Knight Walk',
        type: 'animation',
        itemCount: 2,
        representativeAssetId: 'route_tag_asset_1',
        assetIdsWithIndex: [
          { assetId: 'route_tag_asset_1', index: 0 },
          { assetId: 'route_tag_asset_2', index: 1 },
        ],
      });
    });

    it('POST /api/assets/:id/tags should assign tags to asset', async () => {
      // Single tag
      const res1 = await app.inject({
        method: 'POST',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tag: 'character' },
      });
      expect(res1.statusCode).toBe(200);
      const json1 = res1.json();
      expect(json1.success).toBe(true);
      expect(json1.tags).toContain('character');
      expect(json1.tags).toContain('pixel-art');

      // Multiple tags with leading hash
      const res2 = await app.inject({
        method: 'POST',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tags: ['#hero', 'melee'] },
      });
      expect(res2.statusCode).toBe(200);
      const json2 = res2.json();
      expect(json2.tags).toContain('hero');
      expect(json2.tags).toContain('melee');
      expect(json2.tags).not.toContain('#hero');
    });

    it('POST /api/assets/:id/tags should return 400 for empty tags and 404 for missing asset', async () => {
      const badRes = await app.inject({
        method: 'POST',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: {},
      });
      expect(badRes.statusCode).toBe(400);

      const notFoundRes = await app.inject({
        method: 'POST',
        url: '/api/assets/non_existent_id/tags',
        payload: { tag: 'foo' },
      });
      expect(notFoundRes.statusCode).toBe(404);
    });

    it('DELETE /api/assets/:id/tags/:tag should remove a specific tag via URL param', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tags: ['weapon', 'sword'] },
      });

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/assets/route_tag_asset_1/tags/weapon',
      });
      expect(delRes.statusCode).toBe(200);
      const json = delRes.json();
      expect(json.success).toBe(true);
      expect(json.tags).not.toContain('weapon');
      expect(json.tags).toContain('sword');

      // 404 for non-existent asset
      const notFoundRes = await app.inject({
        method: 'DELETE',
        url: '/api/assets/non_existent_id/tags/sword',
      });
      expect(notFoundRes.statusCode).toBe(404);
    });

    it('DELETE /api/assets/:id/tags should remove tags via request body', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tags: ['tag1', 'tag2', 'tag3'] },
      });

      const delRes = await app.inject({
        method: 'DELETE',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tags: ['#tag1', 'tag2'] },
      });
      expect(delRes.statusCode).toBe(200);
      const json = delRes.json();
      expect(json.tags).not.toContain('tag1');
      expect(json.tags).not.toContain('tag2');
      expect(json.tags).toContain('tag3');

      // 400 if no tags provided in body
      const badRes = await app.inject({
        method: 'DELETE',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: {},
      });
      expect(badRes.statusCode).toBe(400);
    });

    it('PUT /api/assets/:id/tags should replace all tags on asset', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/api/assets/route_tag_asset_1/tags',
        payload: { tags: ['brand_new_1', '#brand_new_2'] },
      });
      expect(putRes.statusCode).toBe(200);
      const json = putRes.json();
      expect(json.tags).toEqual(['brand_new_1', 'brand_new_2']);
    });

    it('POST /api/assets/tags should batch add and remove tags across multiple assets', async () => {
      // Batch add
      const addRes = await app.inject({
        method: 'POST',
        url: '/api/assets/tags',
        payload: {
          assetIds: ['route_tag_asset_1', 'route_tag_asset_2'],
          tags: ['fantasy', 'rpg'],
          action: 'add',
        },
      });
      expect(addRes.statusCode).toBe(200);
      const addJson = addRes.json();
      expect(addJson.affectedCount).toBe(2);

      // Verify both have the tags
      const a1Res = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_1' });
      const a2Res = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_2' });
      expect(a1Res.json().tags).toContain('fantasy');
      expect(a2Res.json().tags).toContain('fantasy');

      // Batch remove
      const remRes = await app.inject({
        method: 'POST',
        url: '/api/assets/tags',
        payload: {
          assetIds: ['route_tag_asset_1', 'route_tag_asset_2'],
          tags: ['fantasy'],
          action: 'remove',
        },
      });
      expect(remRes.statusCode).toBe(200);
      expect(remRes.json().affectedCount).toBe(2);

      const a1After = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_1' });
      const a2After = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_2' });
      expect(a1After.json().tags).not.toContain('fantasy');
      expect(a2After.json().tags).not.toContain('fantasy');
      expect(a1After.json().tags).toContain('rpg');
    });

    it('POST & DELETE /api/stacks/:id/tags should assign and remove tags to/from all stack member assets', async () => {
      // Add tag to stack
      const addRes = await app.inject({
        method: 'POST',
        url: '/api/stacks/route_tag_stack_1/tags',
        payload: { tag: 'running_cycle' },
      });
      expect(addRes.statusCode).toBe(200);
      expect(addRes.json().stack.tags).toContain('running_cycle');

      // Both members should have tag
      const a1 = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_1' });
      const a2 = await app.inject({ method: 'GET', url: '/api/assets/route_tag_asset_2' });
      expect(a1.json().tags).toContain('running_cycle');
      expect(a2.json().tags).toContain('running_cycle');

      // Remove tag from stack via URL param
      const delParamRes = await app.inject({
        method: 'DELETE',
        url: '/api/stacks/route_tag_stack_1/tags/running_cycle',
      });
      expect(delParamRes.statusCode).toBe(200);
      expect(delParamRes.json().tags).not.toContain('running_cycle');

      // Remove via body
      await app.inject({
        method: 'POST',
        url: '/api/stacks/route_tag_stack_1/tags',
        payload: { tags: ['tag_x', 'tag_y'] },
      });
      const delBodyRes = await app.inject({
        method: 'DELETE',
        url: '/api/stacks/route_tag_stack_1/tags',
        payload: { tags: ['tag_x'] },
      });
      expect(delBodyRes.statusCode).toBe(200);
      expect(delBodyRes.json().tags).not.toContain('tag_x');
      expect(delBodyRes.json().tags).toContain('tag_y');
    });
  });

  describe('Not Found handler for API', () => {
    it('should return JSON error 404 for unknown /api routes', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/unknown-route',
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('Endpoint not found');
    });
  });
});

