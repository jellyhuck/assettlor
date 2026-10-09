import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  getAssetById,
  getDatabase,
  initDatabase,
} from '../server/src/db/database.js';
import { canonicalAssetId } from '../server/src/services/assetIdentity.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { cleanupTempDir, createTempDir, TINY_PNG_BUFFER } from './helpers.js';

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
});
