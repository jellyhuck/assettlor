import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  addTagsToAssets,
  closeDatabase,
  createStack,
  getDatabase,
  initDatabase,
  removeLibraryIndex,
  upsertAsset,
} from '../server/src/db/database.js';
import { purgeLibraryIndexes, requestCancelScan, scanLibrary } from '../server/src/services/scanner.js';
import { cleanupTempDir, createTempDir, createTestZipArchive, TINY_PNG_BUFFER } from './helpers.js';

interface Row {
  id: string;
  absolute_path: string;
  source_directory: string | null;
  thumbnail_path: string | null;
  metadata: string | null;
}

function rows(): Row[] {
  return getDatabase().prepare(
    'SELECT id, absolute_path, source_directory, thumbnail_path, metadata FROM assets ORDER BY absolute_path'
  ).all() as Row[];
}

function tags(): { asset_id: string; tag: string }[] {
  return getDatabase().prepare('SELECT asset_id, tag FROM tags ORDER BY asset_id, tag').all() as
    { asset_id: string; tag: string }[];
}

function archivePaths(): string[] {
  return (getDatabase().prepare('SELECT absolute_path FROM archives ORDER BY absolute_path').all() as
    { absolute_path: string }[]).map((row) => row.absolute_path);
}

function byPath(file: string): Row | undefined {
  return rows().find((row) => row.absolute_path === file);
}

describe('library index removal and reindex', () => {
  let fixture: string;
  let libraryA: string;
  let libraryB: string;
  let dataDir: string;

  beforeEach(() => {
    fixture = createTempDir('library-reindex-');
    libraryA = path.join(fixture, 'library-a');
    libraryB = path.join(fixture, 'library-b');
    dataDir = path.join(fixture, 'data');
    fs.mkdirSync(libraryA, { recursive: true });
    fs.mkdirSync(libraryB, { recursive: true });
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryA, libraryB],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
        folder: { enabled: false },
      },
    });
    initDatabase(dataDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(fixture);
  });

  function writePng(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TINY_PNG_BUFFER);
  }

  function seed(id: string, root: string, name: string): void {
    upsertAsset({
      id, path: `${path.basename(root)}/${name}`, absolutePath: path.join(root, name), name,
      extension: '.png', category: 'image', size: 1, mtime: 1, hash: `h_${id}`,
      isArchiveEntry: false, sourceDirectory: root,
    });
  }

  describe('database', () => {
    it('removes only the target library rows, tags, aliases, and emptied stacks', () => {
      seed('a1', libraryA, 'walk_01.png');
      seed('a2', libraryA, 'walk_02.png');
      seed('b1', libraryB, 'icon.png');
      addTagsToAssets(['a1', 'b1'], ['hero']);
      createStack({
        id: 'stack_a', name: 'walk', type: 'animation', itemCount: 2, representativeAssetId: 'a1',
        assetIdsWithIndex: [{ assetId: 'a1', index: 0 }, { assetId: 'a2', index: 1 }],
      });
      const db = getDatabase();
      db.prepare('INSERT INTO asset_id_aliases (old_id, asset_id) VALUES (?, ?)').run('old_a1', 'a1');
      db.prepare('INSERT INTO asset_id_aliases (old_id, asset_id) VALUES (?, ?)').run('old_b1', 'b1');

      const result = removeLibraryIndex(libraryA + path.sep);

      expect(result.removedCount).toBe(2);
      expect(result.tags).toEqual([{ asset_id: 'a1', tag: 'hero', source: 'user' }]);
      expect(rows().map((row) => row.id)).toEqual(['b1']);
      expect(tags()).toEqual([{ asset_id: 'b1', tag: 'hero' }]);
      expect(db.prepare('SELECT old_id FROM asset_id_aliases').all()).toEqual([{ old_id: 'old_b1' }]);
      expect(db.prepare('SELECT id FROM stacks').all()).toEqual([]);
    });

    it('selects a library through an index on resolved source directories', () => {
      seed('a1', libraryA, 'one.png');
      seed('a2', libraryA, 'two.png');
      const db = getDatabase();
      db.prepare('UPDATE assets SET source_directory = ? WHERE id = ?').run(`${libraryA}/sub/..`, 'a1');
      db.prepare('UPDATE assets SET source_directory = NULL WHERE id = ?').run('a2');
      closeDatabase();
      initDatabase(dataDir);

      expect(rows().map((row) => row.source_directory)).toEqual([libraryA, libraryA]);
      const plan = getDatabase().prepare('EXPLAIN QUERY PLAN DELETE FROM assets WHERE source_directory = ?')
        .all(libraryA) as { detail: string }[];
      expect(plan.map((step) => step.detail).join(' ')).toContain('idx_assets_source_directory');
    });

    it('purges removed libraries and their unused thumbnails', async () => {
      const fileA = path.join(libraryA, 'a.png');
      const fileB = path.join(libraryB, 'b.png');
      writePng(fileA);
      writePng(fileB);
      expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
      const thumbnailB = byPath(fileB)!.thumbnail_path!;
      expect(fs.existsSync(thumbnailB)).toBe(true);

      expect(purgeLibraryIndexes([libraryB])).toEqual({ removedCount: 1 });

      expect(rows().map((row) => row.absolute_path)).toEqual([fileA]);
      expect(fs.existsSync(thumbnailB)).toBe(false);
      const marker = getDatabase().prepare("SELECT value FROM settings WHERE key = 'scan:configured-roots'")
        .get() as { value: string };
      expect(JSON.parse(marker.value)).toEqual([libraryA]);
    });

    it('drops archive bookkeeping with the library on purge and reindex', async () => {
      const zipA = createTestZipArchive(path.join(libraryA, 'a.zip'), [{ name: 'a.png', content: TINY_PNG_BUFFER }]);
      const zipB = createTestZipArchive(path.join(libraryB, 'b.zip'), [{ name: 'b.png', content: TINY_PNG_BUFFER }]);
      expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
      expect(archivePaths()).toEqual([zipA, zipB]);

      // A reindex discards the library's records; only archives still present are recorded again.
      fs.rmSync(zipA);
      expect((await scanLibrary([libraryA], { reindexDirectories: [libraryA] })).status).toBe('completed');
      expect(archivePaths()).toEqual([zipB]);

      purgeLibraryIndexes([libraryB]);
      expect(archivePaths()).toEqual([]);
    });
  });

  describe('reindex', () => {
    let fileA: string;
    let goneA: string;
    let fileB: string;

    beforeEach(async () => {
      fileA = path.join(libraryA, 'hero.png');
      goneA = path.join(libraryA, 'old.png');
      fileB = path.join(libraryB, 'icon.png');
      writePng(fileA);
      writePng(goneA);
      writePng(fileB);
      expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
      addTagsToAssets([byPath(fileA)!.id, byPath(goneA)!.id, byPath(fileB)!.id], ['favorite']);
    });

    it('rebuilds one library from scratch and keeps user tags on assets that still exist', async () => {
      const before = { a: byPath(fileA)!, b: byPath(fileB)! };
      getDatabase().prepare('UPDATE assets SET metadata = ? WHERE id = ?')
        .run(JSON.stringify({ stale: true }), before.a.id);
      fs.rmSync(goneA);

      const status = await scanLibrary([libraryA], { reindexDirectories: [libraryA] });

      expect(status.status).toBe('completed');
      expect(status.reindexing).toBe(true);
      const after = byPath(fileA)!;
      expect(after.id).toBe(before.a.id);
      expect(after.thumbnail_path).not.toBe(before.a.thumbnail_path);
      expect(fs.existsSync(before.a.thumbnail_path!)).toBe(false);
      expect(JSON.parse(after.metadata!).stale).toBeUndefined();
      expect(byPath(goneA)).toBeUndefined();
      expect(byPath(fileB)).toEqual(before.b);
      expect(tags().map((row) => row.asset_id).sort()).toEqual([before.a.id, before.b.id].sort());
    });

    it('drops user tags when asked to', async () => {
      const idB = byPath(fileB)!.id;
      const status = await scanLibrary([libraryA], { reindexDirectories: [libraryA], keepUserTags: false });
      expect(status.status).toBe('completed');
      expect(byPath(fileA)).toBeDefined();
      expect(tags()).toEqual([{ asset_id: idB, tag: 'favorite' }]);
    });

    it('keeps the previous index when cancelled before commit', async () => {
      const snapshot = { rows: rows(), tags: tags() };
      const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
      vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (target, data, options) => {
        await originalWriteFile(target, data, options);
        if (String(target).includes('thumbnail-staging')) requestCancelScan();
      });

      const status = await scanLibrary([libraryA], { reindexDirectories: [libraryA], keepUserTags: false });

      expect(status.status).toBe('idle');
      expect({ rows: rows(), tags: tags() }).toEqual(snapshot);
    });

    it('refuses to reindex an unavailable library and leaves its index alone', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const snapshot = { rows: rows(), tags: tags() };
      fs.renameSync(libraryA, libraryA + '-offline');

      const status = await scanLibrary([libraryA, libraryB], { reindexDirectories: [libraryA] });

      expect(status.status).toBe('error');
      expect(status.error).toMatch(/Cannot reindex .*library is unavailable/);
      expect({ rows: rows(), tags: tags() }).toEqual(snapshot);
    });
  });
});
