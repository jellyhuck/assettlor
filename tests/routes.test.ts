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

    it('POST /api/assets/copy should copy asset or return 400 on error', async () => {
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
      expect(badRes.statusCode).toBe(400);
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
