import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfigFile, resetConfigForTesting } from '../server/src/config.js';
import {
  getDatabase,
  getStackAssets,
  initDatabase,
  updateAppSettings,
  upsertAsset,
} from '../server/src/db/database.js';
import { runStackingEngine } from '../server/src/services/stacker.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

interface StackRecord {
  id: string;
  name: string;
  type: string;
  item_count: number;
  representative_asset_id: string;
  metadata: string;
}

describe('stack rebuild regressions', () => {
  let tempDir: string;
  let libraryDir: string;

  beforeEach(() => {
    tempDir = createTempDir('stacker-regression-');
    libraryDir = path.join(tempDir, 'library');
    loadConfigFile(path.join(tempDir, 'config.yaml'));
    initDatabase(path.join(tempDir, 'data'));
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    resetConfigForTesting();
  });

  function addAsset(
    id: string,
    relativePath: string,
    options: {
      archivePath?: string;
      archiveEntryPath?: string;
      sourceDirectory?: string;
      metadata?: { width?: number; height?: number; sampleRate?: number; numberOfChannels?: number };
    } = {}
  ): void {
    const isArchiveEntry = options.archivePath !== undefined;
    const name = path.posix.basename(relativePath);
    const extension = path.extname(name);
    upsertAsset({
      id,
      path: relativePath,
      absolutePath: isArchiveEntry
        ? `${options.archivePath}#/${options.archiveEntryPath}`
        : path.join(libraryDir, relativePath),
      name,
      extension,
      category: ['.wav', '.mp3', '.ogg'].includes(extension) ? 'audio' : 'image',
      size: 100,
      mtime: 100,
      hash: id,
      isArchiveEntry,
      archivePath: options.archivePath,
      archiveEntryPath: options.archiveEntryPath,
      sourceDirectory: options.sourceDirectory ?? libraryDir,
      metadata: options.metadata,
    });
  }

  function stacks(): StackRecord[] {
    return getDatabase().prepare('SELECT * FROM stacks ORDER BY name, id').all() as StackRecord[];
  }

  it('uses the whole identity for sequences under a long common directory', () => {
    const directory = 'very-long-directory-for-assets';
    for (const base of ['walk', 'run']) {
      for (const frame of [1, 2]) {
        addAsset(`${base}_${frame}`, `${directory}/${base}_0${frame}.png`);
      }
    }

    expect(runStackingEngine()).toEqual({ animationStacksCreated: 2, audioStacksCreated: 0 });
    const result = stacks();
    expect(result).toHaveLength(2);
    expect(new Set(result.map((stack) => stack.id)).size).toBe(2);
    expect(result.map((stack) => stack.name)).toEqual(['Run', 'Walk']);
    for (const stack of result) {
      expect(getStackAssets(stack.id)).toHaveLength(2);
      expect(stack.item_count).toBe(2);
    }
  });

  it('keeps same-named archives in separate source contexts', () => {
    const roots = [path.join(tempDir, 'root-a'), path.join(tempDir, 'root-b')];
    roots.forEach((root, rootIndex) => {
      const archivePath = path.join(root, 'Pack.zip');
      for (const frame of [1, 2]) {
        addAsset(
          `archive_${rootIndex}_${frame}`,
          `root-${rootIndex}/Pack.zip#/sprites/walk_0${frame}.png`,
          { archivePath, archiveEntryPath: `sprites/walk_0${frame}.png`, sourceDirectory: root }
        );
      }
    });

    expect(runStackingEngine().animationStacksCreated).toBe(2);
    const firstIds = stacks().map((stack) => stack.id);
    expect(new Set(firstIds).size).toBe(2);
    const members = stacks()
      .map((stack) => getStackAssets(stack.id).map((asset) => asset.id))
      .sort((left, right) => left[0].localeCompare(right[0]));
    expect(members).toEqual([
      ['archive_0_1', 'archive_0_2'],
      ['archive_1_1', 'archive_1_2'],
    ]);

    // A display-prefix change does not alter a stack's source identity.
    getDatabase().prepare("UPDATE assets SET path = REPLACE(path, 'root-0/', 'renamed-root/') WHERE id LIKE 'archive_0_%'").run();
    runStackingEngine();
    expect(stacks().map((stack) => stack.id)).toEqual(firstIds);
  });

  it('honors both stacking switches and the configured animation FPS', () => {
    for (const frame of [1, 2]) {
      addAsset(`walk_${frame}`, `sprites/walk_0${frame}.png`);
      addAsset(`laser_${frame}`, `sfx/laser_0${frame}.wav`);
    }

    updateAppSettings({ autoStackAnimations: false, autoStackAudio: false, defaultFps: 24 });
    expect(runStackingEngine()).toEqual({ animationStacksCreated: 0, audioStacksCreated: 0 });
    expect(stacks()).toEqual([]);

    updateAppSettings({ autoStackAnimations: true });
    expect(runStackingEngine()).toEqual({ animationStacksCreated: 1, audioStacksCreated: 0 });
    expect(stacks().map((stack) => stack.type)).toEqual(['animation']);
    expect(JSON.parse(stacks()[0].metadata).fps).toBe(24);

    updateAppSettings({ autoStackAnimations: false, autoStackAudio: true });
    expect(runStackingEngine()).toEqual({ animationStacksCreated: 0, audioStacksCreated: 1 });
    expect(stacks().map((stack) => stack.type)).toEqual(['audio_variation']);
  });

  it('separates incompatible renditions and permits sparse sequences', () => {
    for (const frame of [1, 3]) {
      addAsset(`png_${frame}`, `sprites/walk_0${frame}.png`, { metadata: { width: 32, height: 32 } });
      addAsset(`jpg_${frame}`, `sprites/walk_0${frame}.jpg`, { metadata: { width: 32, height: 32 } });
    }
    addAsset('wide_1', 'sprites/jump_01.png', { metadata: { width: 32, height: 32 } });
    addAsset('wide_2', 'sprites/jump_02.png', { metadata: { width: 64, height: 32 } });

    expect(runStackingEngine().animationStacksCreated).toBe(2);
    const result = stacks();
    expect(result).toHaveLength(2);
    const members = result
      .map((stack) => getStackAssets(stack.id).map((asset) => asset.id))
      .sort((left, right) => left[0].localeCompare(right[0]));
    expect(members).toEqual([
      ['jpg_1', 'jpg_3'],
      ['png_1', 'png_3'],
    ]);
    expect(result.map((stack) => JSON.parse(stack.metadata).frameRange)).toEqual([[1, 3], [1, 3]]);
  });

  it('leaves duplicate numbered frames unstacked', () => {
    addAsset('walk_upper_1', 'sprites/Walk_01.png');
    addAsset('walk_lower_1', 'sprites/walk_01.png');
    addAsset('walk_2', 'sprites/walk_02.png');

    expect(runStackingEngine().animationStacksCreated).toBe(0);
    expect(stacks()).toEqual([]);
  });

  it('rolls back the entire rebuild when a stack write fails', () => {
    addAsset('walk_1', 'sprites/walk_01.png');
    addAsset('walk_2', 'sprites/walk_02.png');
    runStackingEngine();
    const db = getDatabase();
    const beforeStacks = stacks();
    const beforeMembers = db.prepare('SELECT id, stack_id, stack_index FROM assets ORDER BY id').all();

    addAsset('run_1', 'sprites/run_01.png');
    addAsset('run_2', 'sprites/run_02.png');
    db.exec(`
      CREATE TRIGGER reject_run_stack BEFORE INSERT ON stacks
      WHEN NEW.name = 'Run'
      BEGIN SELECT RAISE(ABORT, 'injected stack write failure'); END;
    `);

    expect(() => runStackingEngine()).toThrow('injected stack write failure');
    expect(stacks()).toEqual(beforeStacks);
    expect(getStackAssets(beforeStacks[0].id).map((asset) => [asset.id, asset.stackIndex]))
      .toEqual([['walk_1', 0], ['walk_2', 1]]);
    expect(db.prepare('SELECT id, stack_id, stack_index FROM assets WHERE id LIKE \'walk_%\' ORDER BY id').all())
      .toEqual(beforeMembers);
    expect(db.prepare('SELECT id, stack_id, stack_index FROM assets WHERE id LIKE \'run_%\' ORDER BY id').all())
      .toEqual([
        { id: 'run_1', stack_id: null, stack_index: null },
        { id: 'run_2', stack_id: null, stack_index: null },
      ]);
  });
});
