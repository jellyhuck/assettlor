import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  getAssetById,
  getDatabase,
  initDatabase,
  addAssetTags,
  getAllTags,
  removeAssetTagsBySource,
  upsertAsset,
} from '../server/src/db/database.js';
import { canonicalAssetId } from '../server/src/services/assetIdentity.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { cleanupTempDir, createTempDir, createTestZipArchive, TINY_PNG_BUFFER } from './helpers.js';

describe('Index identity and curation', () => {
  let fixture: string;
  let dataDir: string;

  beforeEach(() => {
    fixture = createTempDir('index-integrity-');
    dataDir = path.join(fixture, 'data');
    resetConfigForTesting({ data_dir: dataDir, classifiers: {} });
    initDatabase(dataDir);
  });

  afterEach(() => {
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(fixture);
  });

  it('keeps bounded IDs through root reorder and long filenames', async () => {
    const first = path.join(fixture, 'one', 'assets');
    const second = path.join(fixture, 'two', 'assets');
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    const longName = `${'x'.repeat(190)}.png`;
    fs.writeFileSync(path.join(first, longName), TINY_PNG_BUFFER);
    fs.writeFileSync(path.join(second, 'icon.png'), TINY_PNG_BUFFER);

    resetConfigForTesting({ data_dir: dataDir, libraries: [first, second], classifiers: {} });
    expect((await scanLibrary([first, second])).status).toBe('completed');
    const initial = getDatabase().prepare('SELECT id, absolute_path, path, thumbnail_path FROM assets ORDER BY absolute_path').all() as
      { id: string; absolute_path: string; path: string; thumbnail_path: string }[];
    expect(initial).toHaveLength(2);
    for (const asset of initial) {
      expect(asset.id).toBe(canonicalAssetId(asset.absolute_path));
      expect(asset.id.length).toBeLessThan(72);
      expect(fs.existsSync(asset.thumbnail_path)).toBe(true);
    }

    resetConfigForTesting({ data_dir: dataDir, libraries: [second, first], classifiers: {} });
    expect((await scanLibrary([second, first])).status).toBe('completed');
    const reordered = getDatabase().prepare('SELECT id, absolute_path, path FROM assets ORDER BY absolute_path').all() as
      { id: string; absolute_path: string; path: string }[];
    expect(reordered.map((row) => row.id)).toEqual(initial.map((row) => row.id));
    expect(reordered.map((row) => row.path)).toEqual(initial.map((row) => row.path));
  });

  it('migrates legacy IDs with tags and stack references intact', () => {
    const file = path.join(fixture, 'legacy.png');
    fs.writeFileSync(file, TINY_PNG_BUFFER);
    const oldId = `file_${Buffer.from('legacy.png').toString('base64url')}`;
    const db = getDatabase();
    db.prepare(`
      INSERT INTO assets (id, path, absolute_path, name, extension, category, size,
        mtime, hash, is_archive_entry, thumbnail_path, metadata, stack_id,
        stack_index, created_at, updated_at)
      VALUES (?, 'legacy.png', ?, 'legacy.png', '.png', 'image', 5,
        1, 'old', 0, NULL, '{}', 'old_stack', 0, 10, 11)
    `).run(oldId, file);
    db.prepare("INSERT INTO tags (asset_id, tag, source) VALUES (?, 'favorite', 'user')").run(oldId);
    db.prepare(`
      INSERT INTO stacks (id, name, type, item_count, representative_asset_id,
        metadata, created_at)
      VALUES ('old_stack', 'Legacy', 'animation', 1, ?, '{}', 10)
    `).run(oldId);
    closeDatabase();

    initDatabase(dataDir);
    const nextId = canonicalAssetId(file);
    const migrated = getAssetById(nextId);
    expect(migrated?.tags).toContain('favorite');
    expect(migrated?.createdAt).toBe(10);
    expect(getAssetById(oldId)?.id).toBe(nextId);
    const stack = getDatabase().prepare('SELECT representative_asset_id FROM stacks WHERE id = ?').get('old_stack') as
      { representative_asset_id: string };
    expect(stack.representative_asset_id).toBe(nextId);
  });

  it('keeps explicit tags when scanner and classifier ownership changes', () => {
    const file = path.join(fixture, 'curated.png');
    const id = canonicalAssetId(file);
    const base = {
      id,
      path: 'curated.png',
      absolutePath: file,
      name: 'curated.png',
      extension: '.png',
      category: 'image',
      size: 10,
      mtime: 1,
      isArchiveEntry: false,
    };
    upsertAsset({ ...base, hash: 'one', metadata: { width: 32 }, tags: [
      { tag: 'Favorite', source: 'auto' },
      { tag: 'Animated', source: 'auto' },
    ] });
    addAssetTags(id, ['FAVORITE', { tag: 'Classified', source: 'classifier:sprite' }]);
    upsertAsset({ ...base, hash: 'one', metadata: { height: 32 }, tags: [
      { tag: 'favorite', source: 'auto' },
    ] });
    expect(getAssetById(id)?.tags.map((tag) => tag.toLowerCase())).toEqual(
      expect.arrayContaining(['favorite', 'classified'])
    );
    expect(getAssetById(id)?.tags.map((tag) => tag.toLowerCase())).not.toContain('animated');
    expect(getAssetById(id)?.metadata).toMatchObject({ width: 32, height: 32 });
    expect(getAllTags().find((tag) => tag.name.toLowerCase() === 'favorite')?.count).toBe(1);

    removeAssetTagsBySource(id, 'auto');
    expect(getAssetById(id)?.tags.map((tag) => tag.toLowerCase())).toContain('favorite');
    upsertAsset({ ...base, hash: 'two', metadata: { width: 64 }, tags: [] });
    expect(getAssetById(id)?.tags.map((tag) => tag.toLowerCase())).toEqual(['favorite']);
    expect(getAssetById(id)?.metadata).toEqual({ width: 64 });
  });

  it('migrates legacy tag rows to independent case-insensitive sources', () => {
    const id = 'old_asset';
    const db = getDatabase();
    db.prepare(`
      INSERT INTO assets (id, path, absolute_path, name, extension, category, size,
        mtime, hash, is_archive_entry, created_at, updated_at)
      VALUES (?, 'old.png', ?, 'old.png', '.png', 'image', 1, 1, 'x', 0, 1, 1)
    `).run(id, path.join(fixture, 'old.png'));
    db.exec(`
      DROP TABLE tags;
      CREATE TABLE tags (
        asset_id TEXT NOT NULL, tag TEXT NOT NULL, source TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag)
      );
    `);
    db.prepare("INSERT INTO tags (asset_id, tag, source) VALUES (?, 'Favorite', 'user')").run(id);
    closeDatabase();
    initDatabase(dataDir);
    expect(getAssetById(id)?.tags).toEqual(['Favorite']);
    addAssetTags(id, [{ tag: 'favorite', source: 'classifier:sprite' }]);
    removeAssetTagsBySource(id, 'classifier:sprite');
    expect(getAssetById(id)?.tags).toEqual(['Favorite']);
  });

  it('preserves disk and ZIP curation through a full rescan', async () => {
    const library = path.join(fixture, 'library');
    fs.mkdirSync(library);
    const diskFile = path.join(library, 'icon.png');
    const archiveFile = path.join(library, 'pack.zip');
    fs.writeFileSync(diskFile, TINY_PNG_BUFFER);
    createTestZipArchive(archiveFile, [{ name: 'inner/art.png', content: TINY_PNG_BUFFER }]);
    resetConfigForTesting({ data_dir: dataDir, libraries: [library], classifiers: {} });
    expect((await scanLibrary(library)).status).toBe('completed');
    const diskId = canonicalAssetId(diskFile);
    const zipId = canonicalAssetId(archiveFile, 'inner/art.png');
    addAssetTags(diskId, ['favorite']);
    addAssetTags(zipId, ['favorite']);
    const before = [getAssetById(diskId), getAssetById(zipId)];

    expect((await scanLibrary(library, { fullRescan: true })).status).toBe('completed');
    for (const [index, id] of [diskId, zipId].entries()) {
      expect(getAssetById(id)?.tags).toContain('favorite');
      expect(getAssetById(id)?.createdAt).toBe(before[index]?.createdAt);
    }
  });
});
