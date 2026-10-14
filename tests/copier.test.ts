import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  upsertAsset,
  createStack,
  updateAppSettings,
} from '../server/src/db/database.js';
import { copyAssetToProject } from '../server/src/services/copier.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

describe('Copier Service', () => {
  let libraryDir: string;
  let projectDir: string;

  beforeEach(() => {
    libraryDir = createTempDir('lib-copier-');
    projectDir = createTempDir('proj-copier-');
    initDatabase(libraryDir);
    updateAppSettings({ activeProjectPath: projectDir });
  });

  afterEach(() => {
    cleanupTempDir(libraryDir);
    cleanupTempDir(projectDir);
  });

  it('should copy a regular disk asset to the target project directory', async () => {
    const srcFile = path.join(libraryDir, 'icon.png');
    fs.writeFileSync(srcFile, TINY_PNG_BUFFER);

    upsertAsset({
      id: 'icon_asset',
      path: 'icon.png',
      absolutePath: srcFile,
      name: 'icon.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: 'h_icon',
      isArchiveEntry: false,
    });

    const res = await copyAssetToProject({
      assetId: 'icon_asset',
      targetPath: projectDir,
    });

    expect(res.success).toBe(true);
    expect(res.copiedFiles).toHaveLength(1);
    expect(fs.existsSync(res.copiedFiles[0])).toBe(true);
    expect(path.basename(res.copiedFiles[0])).toBe('icon.png');
  });

  it('should copy regular asset into a custom subfolder', async () => {
    const srcFile = path.join(libraryDir, 'sprite.png');
    fs.writeFileSync(srcFile, TINY_PNG_BUFFER);

    upsertAsset({
      id: 'sub_asset',
      path: 'sprite.png',
      absolutePath: srcFile,
      name: 'sprite.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: 'h_sub',
      isArchiveEntry: false,
    });

    const res = await copyAssetToProject({
      assetId: 'sub_asset',
      targetPath: projectDir,
      targetSubfolder: 'textures/ui',
    });

    expect(res.success).toBe(true);
    const destFile = path.join(projectDir, 'textures/ui', 'sprite.png');
    expect(fs.existsSync(destFile)).toBe(true);
  });

  it('should extract and copy an archive virtual entry on the fly', async () => {
    const zipPath = path.join(libraryDir, 'pack.zip');
    createTestZipArchive(zipPath, [
      { name: 'inner/hero.png', content: TINY_PNG_BUFFER },
    ]);

    upsertAsset({
      id: 'zip_entry_hero',
      path: 'pack.zip#/inner/hero.png',
      absolutePath: zipPath,
      name: 'hero.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: 'h_zip_hero',
      isArchiveEntry: true,
      archivePath: zipPath,
      archiveEntryPath: 'inner/hero.png',
    });

    const res = await copyAssetToProject({
      assetId: 'zip_entry_hero',
      targetPath: projectDir,
    });

    expect(res.success).toBe(true);
    const dest = path.join(projectDir, 'hero.png');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.readFileSync(dest).equals(TINY_PNG_BUFFER)).toBe(true);
  });

  it('should copy an entire animation stack with all frames', async () => {
    const f1 = path.join(libraryDir, 'run_1.png');
    const f2 = path.join(libraryDir, 'run_2.png');
    fs.writeFileSync(f1, TINY_PNG_BUFFER);
    fs.writeFileSync(f2, TINY_PNG_BUFFER);

    upsertAsset({
      id: 'run_1',
      path: 'run_1.png',
      absolutePath: f1,
      name: 'run_1.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: 'h1',
      isArchiveEntry: false,
    });
    upsertAsset({
      id: 'run_2',
      path: 'run_2.png',
      absolutePath: f2,
      name: 'run_2.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: 'h2',
      isArchiveEntry: false,
    });

    createStack({
      id: 'stack_run',
      name: 'Hero Run',
      type: 'animation',
      itemCount: 2,
      representativeAssetId: 'run_1',
      assetIdsWithIndex: [
        { assetId: 'run_1', index: 0 },
        { assetId: 'run_2', index: 1 },
      ],
    });

    const res = await copyAssetToProject({
      stackId: 'stack_run',
      copyStackAll: true,
      targetPath: projectDir,
    });

    expect(res.success).toBe(true);
    expect(res.copiedFiles).toHaveLength(2);

    const stackDir = path.join(projectDir, 'Hero_Run');
    expect(fs.existsSync(stackDir)).toBe(true);
    expect(fs.readdirSync(stackDir)).toContain('run_1.png');
    expect(fs.readdirSync(stackDir)).toContain('run_2.png');
  });

  it('should throw when no active project and no targetPath configured', async () => {
    updateAppSettings({ activeProjectPath: '' });
    await expect(copyAssetToProject({ assetId: 'any' })).rejects.toThrow(
      /Active project path is not configured/
    );
  });

  it('should throw when asset is not found', async () => {
    await expect(
      copyAssetToProject({ assetId: 'missing_id', targetPath: projectDir })
    ).rejects.toThrow(/Asset not found: missing_id/);
  });

  it('should throw when stack is not found', async () => {
    await expect(
      copyAssetToProject({ stackId: 'missing_stack', copyStackAll: true, targetPath: projectDir })
    ).rejects.toThrow(/Stack not found: missing_stack/);
  });

  it('should throw when neither assetId nor stackId provided', async () => {
    await expect(copyAssetToProject({ targetPath: projectDir })).rejects.toThrow(
      /Either assetId or stackId must be provided/
    );
  });
});
