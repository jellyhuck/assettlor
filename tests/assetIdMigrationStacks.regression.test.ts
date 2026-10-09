import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  getAssetById,
  getDatabase,
  initDatabase,
} from '../server/src/db/database.js';
import { canonicalAssetId } from '../server/src/services/assetIdentity.js';
import { cleanupTempDir, createTempDir, TINY_PNG_BUFFER } from './helpers.js';

interface StackRow {
  id: string;
  item_count: number;
  representative_asset_id: string;
}

interface MemberRow {
  id: string;
  stack_index: number;
}

describe('legacy asset ID migration with stacks', () => {
  let fixture: string;
  let dataDir: string;
  let outerRoot: string;
  let innerRoot: string;

  beforeEach(() => {
    fixture = createTempDir('asset-id-migration-stacks-');
    dataDir = path.join(fixture, 'data');
    outerRoot = path.join(fixture, 'library');
    innerRoot = path.join(outerRoot, 'nested');
    fs.mkdirSync(innerRoot, { recursive: true });
    resetConfigForTesting({ data_dir: dataDir, classifiers: {} });
    initDatabase(dataDir);
  });

  afterEach(() => {
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(fixture);
  });

  function addFile(name: string): string {
    const absolutePath = path.join(innerRoot, name);
    fs.writeFileSync(absolutePath, TINY_PNG_BUFFER);
    return absolutePath;
  }

  function insertAsset(
    id: string,
    absolutePath: string,
    displayPath: string,
    sourceDirectory: string,
    stackId: string | null,
    stackIndex: number | null
  ): void {
    getDatabase().prepare(`
      INSERT INTO assets (
        id, path, absolute_path, name, extension, category, size, mtime,
        hash, is_archive_entry, source_directory, stack_id, stack_index,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, '.png', 'image', 1, 1, 'old', 0, ?, ?, ?, 10, 11)
    `).run(
      id,
      displayPath,
      absolutePath,
      path.basename(absolutePath),
      sourceDirectory,
      stackId,
      stackIndex
    );
  }

  function insertStack(id: string, representativeId: string, itemCount: number): void {
    getDatabase().prepare(`
      INSERT INTO stacks (
        id, name, type, item_count, representative_asset_id, metadata,
        created_at
      ) VALUES (?, ?, 'animation', ?, ?, '{}', 10)
    `).run(id, id, itemCount, representativeId);
  }

  function assertStackIntegrity(expectedStackIds: string[]): void {
    const db = getDatabase();
    const stacks = db.prepare('SELECT id, item_count, representative_asset_id FROM stacks ORDER BY id')
      .all() as StackRow[];
    expect(stacks.map((stack) => stack.id)).toEqual(expectedStackIds);
    for (const stack of stacks) {
      const members = db.prepare(`
        SELECT id, stack_index FROM assets WHERE stack_id = ?
        ORDER BY stack_index, id
      `).all(stack.id) as MemberRow[];
      expect(members.length).toBeGreaterThanOrEqual(2);
      expect(stack.item_count).toBe(members.length);
      expect(members.map((member) => member.stack_index))
        .toEqual(members.map((_, index) => index));
      expect(members.map((member) => member.id)).toContain(stack.representative_asset_id);
    }
  }

  it('repairs both stacks when overlapping roots indexed one file twice', () => {
    const sharedFile = addFile('walk_01.png');
    const canonicalId = canonicalAssetId(sharedFile);
    const outerId = 'file_legacy_outer_walk_01';
    const innerId = 'file_legacy_inner_walk_01';
    const outerSibling = addFile('walk_02.png');
    const innerSiblingA = addFile('walk_03.png');
    const innerSiblingB = addFile('walk_04.png');

    insertAsset(outerId, sharedFile, 'nested/walk_01.png', outerRoot, 'outer_stack', 0);
    insertAsset(canonicalAssetId(outerSibling), outerSibling, 'nested/walk_02.png', outerRoot, 'outer_stack', 1);
    insertAsset(innerId, sharedFile, 'walk_01.png', innerRoot, 'inner_stack', 0);
    insertAsset(canonicalAssetId(innerSiblingA), innerSiblingA, 'walk_03.png', innerRoot, 'inner_stack', 1);
    insertAsset(canonicalAssetId(innerSiblingB), innerSiblingB, 'walk_04.png', innerRoot, 'inner_stack', 2);
    insertStack('outer_stack', outerId, 2);
    insertStack('inner_stack', innerId, 3);
    getDatabase().prepare("INSERT INTO tags (asset_id, tag, source) VALUES (?, ?, 'user')")
      .run(outerId, 'Favorite');
    getDatabase().prepare("INSERT INTO tags (asset_id, tag, source) VALUES (?, ?, 'user')")
      .run(innerId, 'Reviewed');
    closeDatabase();

    initDatabase(dataDir);

    const db = getDatabase();
    const sharedRows = db.prepare('SELECT id FROM assets WHERE absolute_path = ?')
      .all(sharedFile) as { id: string }[];
    expect(sharedRows).toEqual([{ id: canonicalId }]);
    expect(getAssetById(canonicalId)?.tags).toEqual(expect.arrayContaining(['Favorite', 'Reviewed']));
    expect(getAssetById(outerId)?.id).toBe(canonicalId);
    expect(getAssetById(innerId)?.id).toBe(canonicalId);
    assertStackIntegrity(['inner_stack', 'outer_stack']);
  });

  it('transfers stack membership from a duplicate to an unstacked canonical row', () => {
    const sharedFile = addFile('run_01.png');
    const canonicalId = canonicalAssetId(sharedFile);
    const legacyId = 'file_legacy_nested_run_01';
    const sibling = addFile('run_02.png');

    insertAsset(canonicalId, sharedFile, 'nested/run_01.png', outerRoot, null, null);
    insertAsset(legacyId, sharedFile, 'run_01.png', innerRoot, 'run_stack', 0);
    insertAsset(canonicalAssetId(sibling), sibling, 'run_02.png', innerRoot, 'run_stack', 1);
    insertStack('run_stack', legacyId, 2);
    closeDatabase();

    initDatabase(dataDir);

    const db = getDatabase();
    expect(db.prepare('SELECT id FROM assets WHERE absolute_path = ?').all(sharedFile))
      .toEqual([{ id: canonicalId }]);
    expect(getAssetById(legacyId)?.id).toBe(canonicalId);
    expect(db.prepare('SELECT stack_id, stack_index FROM assets WHERE id = ?').get(canonicalId))
      .toEqual({ stack_id: 'run_stack', stack_index: 0 });
    assertStackIntegrity(['run_stack']);
  });

  it('dissolves a stack left with one member after a duplicate merge', () => {
    const sharedFile = addFile('jump_01.png');
    const canonicalId = canonicalAssetId(sharedFile);
    const retainedSibling = addFile('jump_02.png');
    const removedSibling = addFile('jump_03.png');
    const duplicateId = 'file_legacy_nested_jump_01';

    insertAsset(canonicalId, sharedFile, 'nested/jump_01.png', outerRoot, 'retained_stack', 0);
    insertAsset(canonicalAssetId(retainedSibling), retainedSibling, 'nested/jump_02.png', outerRoot, 'retained_stack', 1);
    insertAsset(duplicateId, sharedFile, 'jump_01.png', innerRoot, 'orphan_stack', 0);
    insertAsset(canonicalAssetId(removedSibling), removedSibling, 'jump_03.png', innerRoot, 'orphan_stack', 1);
    insertStack('retained_stack', canonicalId, 2);
    insertStack('orphan_stack', duplicateId, 2);
    closeDatabase();

    initDatabase(dataDir);

    assertStackIntegrity(['retained_stack']);
    expect(getDatabase().prepare('SELECT stack_id, stack_index FROM assets WHERE absolute_path = ?')
      .get(removedSibling)).toEqual({ stack_id: null, stack_index: null });
  });
});
