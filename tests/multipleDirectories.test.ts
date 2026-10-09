import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  getDatabase,
  closeDatabase,
  getAppSettings,
  updateAppSettings,
  upsertAsset,
  getAssetById,
  queryAssets,
} from '../server/src/db/database.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { copyAssetToProject } from '../server/src/services/copier.js';
import { buildServer } from '../server/src/index.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
  createTestWavBuffer,
} from './helpers.js';

describe('Multiple Source and Project Directories', () => {
  let primaryDir: string;

  beforeEach(() => {
    primaryDir = createTempDir('multi-primary-');
    initDatabase(primaryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(primaryDir);
  });

  describe('Project Directories Management & Ordering', () => {
    it('should store multiple project directories and set the first as active project', () => {
      const projA = '/path/to/game_a';
      const projB = '/path/to/game_b';
      const projC = '/path/to/game_c';

      const updated = updateAppSettings({
        projectPaths: [projA, projB, projC],
      });

      expect(updated.projectPaths).toEqual([projA, projB, projC]);
      expect(updated.activeProjectPath).toBe(projA);

      const refetched = getAppSettings();
      expect(refetched.projectPaths).toEqual([projA, projB, projC]);
      expect(refetched.activeProjectPath).toBe(projA);
    });

    it('should reorder project directories so moving a project to the first position makes it active', () => {
      const projA = '/path/to/game_a';
      const projB = '/path/to/game_b';
      const projC = '/path/to/game_c';

      updateAppSettings({ projectPaths: [projA, projB, projC] });

      // User moves projC to the front (active project)
      const reordered = updateAppSettings({
        projectPaths: [projC, projA, projB],
      });

      expect(reordered.projectPaths).toEqual([projC, projA, projB]);
      expect(reordered.activeProjectPath).toBe(projC);

      const fetched = getAppSettings();
      expect(fetched.activeProjectPath).toBe(projC);
      expect(fetched.projectPaths[0]).toBe(projC);
    });

    it('should keep projectPaths and activeProjectPath in sync when legacy activeProjectPath is updated', () => {
      const projA = '/path/to/game_a';
      const projB = '/path/to/game_b';

      updateAppSettings({ projectPaths: [projA, projB] });

      // Legacy update setting activeProjectPath directly
      const updated = updateAppSettings({ activeProjectPath: projB });

      expect(updated.activeProjectPath).toBe(projB);
      expect(updated.projectPaths[0]).toBe(projB);
      expect(updated.projectPaths).toContain(projA);
    });

    it('should copy to active project by default and to explicit targetPath when selected', async () => {
      const projActive = createTempDir('active-proj-');
      const projSecondary = createTempDir('sec-proj-');

      try {
        updateAppSettings({ projectPaths: [projActive, projSecondary] });

        // Create sample file on disk
        const sampleFile = path.join(primaryDir, 'icon.png');
        fs.writeFileSync(sampleFile, TINY_PNG_BUFFER);

        upsertAsset({
          id: 'test_icon',
          path: 'icon.png',
          absolutePath: sampleFile,
          name: 'icon.png',
          extension: '.png',
          category: 'image',
          size: TINY_PNG_BUFFER.length,
          mtime: Date.now(),
          hash: 'hash_icon',
          isArchiveEntry: false,
        });

        // 1. Copy without targetPath -> copies to active project (first in list)
        const resDefault = await copyAssetToProject({ assetId: 'test_icon' });
        expect(resDefault.success).toBe(true);
        expect(resDefault.targetDirectory).toBe(projActive);
        expect(fs.existsSync(path.join(projActive, 'icon.png'))).toBe(true);
        expect(fs.existsSync(path.join(projSecondary, 'icon.png'))).toBe(false);

        // 2. Copy with explicit targetPath -> copies to secondary project
        const resExplicit = await copyAssetToProject({
          assetId: 'test_icon',
          targetPath: projSecondary,
        });
        expect(resExplicit.success).toBe(true);
        expect(resExplicit.targetDirectory).toBe(projSecondary);
        expect(fs.existsSync(path.join(projSecondary, 'icon.png'))).toBe(true);

        // 3. Move secondary project to first in settings -> now default copy goes to projSecondary
        updateAppSettings({ projectPaths: [projSecondary, projActive] });
        const resReordered = await copyAssetToProject({
          assetId: 'test_icon',
          targetSubfolder: 'sub',
        });
        expect(resReordered.success).toBe(true);
        expect(resReordered.targetDirectory).toBe(projSecondary);
        expect(fs.existsSync(path.join(projSecondary, 'sub', 'icon.png'))).toBe(true);
      } finally {
        cleanupTempDir(projActive);
        cleanupTempDir(projSecondary);
      }
    });
  });

  describe('Source Directories (Libraries) Management & Scanning', () => {
    it('should store multiple library source directories and maintain default libraryPath', () => {
      const libA = '/path/to/lib_a';
      const libB = '/path/to/lib_b';

      const updated = updateAppSettings({
        libraryPaths: [libA, libB],
      });

      expect(updated.libraryPaths).toEqual([libA, libB]);
      expect(updated.libraryPath).toBe(libA);

      const refetched = getAppSettings();
      expect(refetched.libraryPaths).toEqual([libA, libB]);
      expect(refetched.libraryPath).toBe(libA);
    });

    it('should scan multiple library source directories and index assets from all directories', async () => {
      const lib1 = createTempDir('source-lib1-');
      const lib2 = createTempDir('source-lib2-');

      try {
        // Source 1 assets: 2 walk animation frames and 1 sound
        const charDir1 = path.join(lib1, 'characters');
        fs.mkdirSync(charDir1, { recursive: true });
        fs.writeFileSync(path.join(charDir1, 'hero_walk_01.png'), TINY_PNG_BUFFER);
        fs.writeFileSync(path.join(charDir1, 'hero_walk_02.png'), TINY_PNG_BUFFER);

        const soundDir1 = path.join(lib1, 'sounds');
        fs.mkdirSync(soundDir1, { recursive: true });
        fs.writeFileSync(path.join(soundDir1, 'laser_01.wav'), createTestWavBuffer(0.1, 8000));
        fs.writeFileSync(path.join(soundDir1, 'laser_02.wav'), createTestWavBuffer(0.1, 8000));

        // Source 2 assets: 2 monster frames, 1 audio file, and a zip archive
        const charDir2 = path.join(lib2, 'monsters');
        fs.mkdirSync(charDir2, { recursive: true });
        fs.writeFileSync(path.join(charDir2, 'goblin_run_01.png'), TINY_PNG_BUFFER);
        fs.writeFileSync(path.join(charDir2, 'goblin_run_02.png'), TINY_PNG_BUFFER);

        createTestZipArchive(path.join(lib2, 'items.zip'), [
          { name: 'potion.png', content: TINY_PNG_BUFFER },
        ]);

        // Run multi-directory scan
        const status = await scanLibrary([lib1, lib2]);

        expect(status.status).toBe('completed');
        // Total assets: 2 hero frames + 2 laser sounds + 2 goblin frames + 1 potion in zip = 7
        expect(status.indexedCount).toBe(7);

        const db = getDatabase();
        const assetCount = (db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c;
        expect(assetCount).toBe(7);

        // Verify assets have sourceDirectory populated
        const allAssets = db.prepare('SELECT path, source_directory FROM assets').all() as any[];
        expect(allAssets).toHaveLength(7);

        const lib1Assets = allAssets.filter((a) => a.source_directory === lib1);
        const lib2Assets = allAssets.filter((a) => a.source_directory === lib2);

        expect(lib1Assets).toHaveLength(4);
        expect(lib2Assets).toHaveLength(3);

        // Verify paths are prefixed with unique folder names
        const prefix1 = path.basename(lib1);
        const prefix2 = path.basename(lib2);

        for (const a of lib1Assets) {
          expect(a.path.startsWith(`${prefix1}/`)).toBe(true);
        }
        for (const a of lib2Assets) {
          expect(a.path.startsWith(`${prefix2}/`)).toBe(true);
        }

        // Verify stacks were formed separately within each source directory
        const stackCount = (db.prepare('SELECT COUNT(*) as c FROM stacks').get() as any).c;
        // Stacks: hero_walk (lib1), laser (lib1), goblin_run (lib2) = 3 stacks
        expect(stackCount).toBe(3);

        const stacks = db.prepare('SELECT name, type, item_count FROM stacks').all() as any[];
        const stackNames = stacks.map((s) => s.name);
        expect(stackNames).toContain('Hero Walk');
        expect(stackNames).toContain('Laser');
        expect(stackNames).toContain('Goblin Run');

        // Check queryAssets in stacked view
        const stackedQuery = queryAssets({ isStackedView: true });
        // 3 stacks + 1 potion in zip = 4 items
        expect(stackedQuery.items).toHaveLength(4);

        // Verify tags include folder tags and source library folder names
        const allTags = db.prepare('SELECT DISTINCT tag FROM tags').all() as any[];
        const tagNames = allTags.map((t) => t.tag);
        expect(tagNames).toContain(prefix1);
        expect(tagNames).toContain(prefix2);
      } finally {
        cleanupTempDir(lib1);
        cleanupTempDir(lib2);
      }
    });

    it('should cleanly remove assets when a source directory is removed on subsequent scan', async () => {
      const lib1 = createTempDir('source-keep-');
      const lib2 = createTempDir('source-remove-');

      try {
        fs.writeFileSync(path.join(lib1, 'keep.png'), TINY_PNG_BUFFER);
        fs.writeFileSync(path.join(lib2, 'remove.png'), TINY_PNG_BUFFER);

        // Scan both
        updateAppSettings({ libraryPaths: [lib1, lib2] });
        await scanLibrary([lib1, lib2]);
        let db = getDatabase();
        expect((db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c).toBe(2);

        // Rescan with only lib1
        updateAppSettings({ libraryPaths: [lib1] });
        await scanLibrary([lib1]);
        db = getDatabase();
        expect((db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c).toBe(1);
        expect(db.prepare("SELECT * FROM assets WHERE name = 'remove.png'").get()).toBeUndefined();
        expect(db.prepare("SELECT * FROM assets WHERE name = 'keep.png'").get()).toBeDefined();
      } finally {
        cleanupTempDir(lib1);
        cleanupTempDir(lib2);
      }
    });
  });

  describe('API Routes for Multiple Directories', () => {
    it('GET & POST /api/settings should read and update projectPaths and libraryPaths', async () => {
      const server = await buildServer({ initDb: false });
      initDatabase(primaryDir);

      try {
        const getRes = await server.inject({
          method: 'GET',
          url: '/api/settings',
        });
        expect(getRes.statusCode).toBe(200);
        const settings = getRes.json();
        expect(Array.isArray(settings.projectPaths)).toBe(true);
        expect(Array.isArray(settings.libraryPaths)).toBe(true);

        const postRes = await server.inject({
          method: 'POST',
          url: '/api/settings',
          payload: {
            projectPaths: ['/games/rpg', '/games/platformer'],
            libraryPaths: [primaryDir, '/extra/assets'],
          },
        });
        expect(postRes.statusCode).toBe(200);
        const updated = postRes.json();
        expect(updated.projectPaths).toEqual(['/games/rpg', '/games/platformer']);
        expect(updated.activeProjectPath).toBe('/games/rpg');
        expect(updated.libraryPaths).toEqual([primaryDir, '/extra/assets']);
        expect(updated.libraryPath).toBe(primaryDir);
      } finally {
        await server.close();
      }
    });

    it('POST /api/scan/start should accept libraryPaths array', async () => {
      const server = await buildServer({ initDb: false });
      initDatabase(primaryDir);

      try {
        const res = await server.inject({
          method: 'POST',
          url: '/api/scan/start',
          payload: {
            libraryPaths: [primaryDir],
          },
        });
        expect(res.statusCode).toBe(200);
        const data = res.json();
        expect(data.message).toBe('Scan started');
        expect(data.libraryPaths).toEqual([primaryDir]);
      } finally {
        await server.close();
      }
    });
  });
});
