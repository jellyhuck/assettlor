import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { initDatabase, getDatabase, getStackById, getStackAssets, upsertAsset } from '../server/src/db/database.js';
import { runStackingEngine } from '../server/src/services/stacker.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

describe('Stacker Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('stacker-test-');
    initDatabase(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should detect and group animation sequences of images', () => {
    // 3 frames for knight_run
    upsertAsset({
      id: 'k_01',
      path: 'chars/knight_run_01.png',
      absolutePath: '/chars/knight_run_01.png',
      name: 'knight_run_01.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'h1',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'k_03',
      path: 'chars/knight_run_03.png',
      absolutePath: '/chars/knight_run_03.png',
      name: 'knight_run_03.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'h3',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'k_02',
      path: 'chars/knight_run_02.png',
      absolutePath: '/chars/knight_run_02.png',
      name: 'knight_run_02.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'h2',
      isArchiveEntry: false,
    });
    // Single standalone image (should not be stacked)
    upsertAsset({
      id: 'tree',
      path: 'chars/tree.png',
      absolutePath: '/chars/tree.png',
      name: 'tree.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'ht',
      isArchiveEntry: false,
    });

    const result = runStackingEngine();
    expect(result.animationStacksCreated).toBe(1);
    expect(result.audioStacksCreated).toBe(0);

    const db = getDatabase();
    const stacks = db.prepare('SELECT * FROM stacks').all() as any[];
    expect(stacks).toHaveLength(1);
    expect(stacks[0].name).toBe('Knight Run');
    expect(stacks[0].type).toBe('animation');
    expect(stacks[0].item_count).toBe(3);

    // Verify frames are in correct sorted order (1, 2, 3)
    const stackAssets = getStackAssets(stacks[0].id);
    expect(stackAssets).toHaveLength(3);
    expect(stackAssets[0].id).toBe('k_01');
    expect(stackAssets[1].id).toBe('k_02');
    expect(stackAssets[2].id).toBe('k_03');
  });

  it('should detect audio variations with numbers and letters', () => {
    // Numbered audio variations
    upsertAsset({
      id: 'laser_1',
      path: 'sfx/laser_01.wav',
      absolutePath: '/sfx/laser_01.wav',
      name: 'laser_01.wav',
      extension: '.wav',
      category: 'audio',
      size: 200,
      mtime: 200,
      hash: 'hl1',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'laser_2',
      path: 'sfx/laser_02.wav',
      absolutePath: '/sfx/laser_02.wav',
      name: 'laser_02.wav',
      extension: '.wav',
      category: 'audio',
      size: 200,
      mtime: 200,
      hash: 'hl2',
      isArchiveEntry: false,
    });

    // Lettered audio variations
    upsertAsset({
      id: 'step_b',
      path: 'sfx/footstep_b.wav',
      absolutePath: '/sfx/footstep_b.wav',
      name: 'footstep_b.wav',
      extension: '.wav',
      category: 'audio',
      size: 150,
      mtime: 150,
      hash: 'hsb',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'step_a',
      path: 'sfx/footstep_a.wav',
      absolutePath: '/sfx/footstep_a.wav',
      name: 'footstep_a.wav',
      extension: '.wav',
      category: 'audio',
      size: 150,
      mtime: 150,
      hash: 'hsa',
      isArchiveEntry: false,
    });

    const result = runStackingEngine();
    expect(result.animationStacksCreated).toBe(0);
    expect(result.audioStacksCreated).toBe(2);

    const db = getDatabase();
    const stacks = db.prepare('SELECT * FROM stacks ORDER BY name ASC').all() as any[];
    expect(stacks).toHaveLength(2);

    const footstep = stacks.find((s) => s.name === 'Footstep');
    expect(footstep).toBeDefined();
    const footstepAssets = getStackAssets(footstep.id);
    expect(footstepAssets[0].id).toBe('step_a');
    expect(footstepAssets[1].id).toBe('step_b');
  });

  it('should not group assets across different directories', () => {
    upsertAsset({
      id: 'dir1_walk_01',
      path: 'dirA/walk_01.png',
      absolutePath: '/dirA/walk_01.png',
      name: 'walk_01.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'h1',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'dir2_walk_02',
      path: 'dirB/walk_02.png',
      absolutePath: '/dirB/walk_02.png',
      name: 'walk_02.png',
      extension: '.png',
      category: 'image',
      size: 100,
      mtime: 100,
      hash: 'h2',
      isArchiveEntry: false,
    });

    const result = runStackingEngine();
    expect(result.animationStacksCreated).toBe(0);
  });
});
