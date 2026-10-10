import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  createStack,
  initDatabase,
  upsertAsset,
} from '../server/src/db/database.js';
import { copyAssetToProject } from '../server/src/services/copier.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

describe('Copy destination safety', () => {
  let root: string;
  let libraryDir: string;
  let projectDir: string;

  beforeEach(() => {
    root = createTempDir('copy-safety-');
    libraryDir = path.join(root, 'library');
    projectDir = path.join(root, 'project');
    fs.mkdirSync(libraryDir);
    initDatabase(path.join(root, 'database'));
  });

  afterEach(() => {
    cleanupTempDir(root);
  });

  function addSource(kind: 'disk' | 'zip', id: string, name = 'icon.png'): string {
    const sourcePath = path.join(libraryDir, kind === 'disk' ? `${id}.png` : `${id}.zip`);
    if (kind === 'disk') {
      fs.writeFileSync(sourcePath, TINY_PNG_BUFFER);
    } else {
      createTestZipArchive(sourcePath, [
        { name: 'inner/icon.png', content: TINY_PNG_BUFFER },
      ]);
    }
    upsertAsset({
      id,
      path: kind === 'disk' ? `${id}.png` : `${id}.zip#/inner/icon.png`,
      absolutePath: sourcePath,
      name,
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: 100,
      hash: `${kind}-${id}`,
      isArchiveEntry: kind === 'zip',
      archivePath: kind === 'zip' ? sourcePath : null,
      archiveEntryPath: kind === 'zip' ? 'inner/icon.png' : null,
    });
    return sourcePath;
  }

  for (const kind of ['disk', 'zip'] as const) {
    it.each([
      ['parent traversal', '../escaped'],
      ['absolute path', '/outside'],
      ['Windows separator traversal', '..\\escaped'],
      ['Windows drive path', 'C:\\escaped'],
      ['Windows alternate stream', 'assets:stream'],
    ])(`rejects %s subfolders for ${kind} sources before creating a project`, async (_case, subfolder) => {
      addSource(kind, 'source');

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
        targetSubfolder: subfolder,
      })).rejects.toThrow(/Target subfolder/);

      expect(fs.existsSync(projectDir)).toBe(false);
      expect(fs.existsSync(path.join(root, 'escaped', 'icon.png'))).toBe(false);
    });

    it.each([
      '../outside.png',
      '/outside.png',
      '..\\outside.png',
      'C:\\outside.png',
      'icon.png:stream',
    ])(`rejects stored filename %s for ${kind} sources`, async (name) => {
      addSource(kind, 'source', name);

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
      })).rejects.toThrow(/Invalid asset filename/);

      expect(fs.existsSync(projectDir)).toBe(false);
    });

    it(`rejects a destination directory symlink for ${kind} sources`, async () => {
      addSource(kind, 'source');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(outsideDir);
      fs.mkdirSync(projectDir);
      fs.symlinkSync(outsideDir, path.join(projectDir, 'linked'));

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
        targetSubfolder: 'linked/nested',
      })).rejects.toThrow(/symbolic link/);

      expect(fs.existsSync(path.join(outsideDir, 'nested'))).toBe(false);
    });

    it(`rejects a symlink parent of a missing project for ${kind} sources`, async () => {
      addSource(kind, 'source');
      const outsideDir = path.join(root, 'outside');
      fs.mkdirSync(outsideDir);
      fs.symlinkSync(outsideDir, path.join(root, 'linked'));

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: path.join(root, 'linked', 'project'),
      })).rejects.toThrow(/symbolic link/);

      expect(fs.existsSync(path.join(outsideDir, 'project'))).toBe(false);
    });

    it(`rejects a destination file symlink for ${kind} sources`, async () => {
      addSource(kind, 'source');
      const outsideFile = path.join(root, 'outside.png');
      fs.writeFileSync(outsideFile, 'keep this content');
      fs.mkdirSync(projectDir);
      fs.symlinkSync(outsideFile, path.join(projectDir, 'icon.png'));

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
      })).rejects.toThrow(/symbolic link/);

      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('keep this content');
    });
  }

  it('does not create a project directory for a missing disk source', async () => {
    const sourcePath = addSource('disk', 'missing');
    fs.unlinkSync(sourcePath);

    await expect(copyAssetToProject({
      assetId: 'missing',
      targetPath: projectDir,
    })).rejects.toThrow();

    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('does not create a project directory for a missing ZIP entry', async () => {
    const sourcePath = addSource('zip', 'missing');
    createTestZipArchive(sourcePath, [
      { name: 'inner/other.png', content: TINY_PNG_BUFFER },
    ]);

    await expect(copyAssetToProject({
      assetId: 'missing',
      targetPath: projectDir,
    })).rejects.toThrow(/Failed to extract entry/);

    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('validates every stack source before creating its destination', async () => {
    addSource('disk', 'first', 'first.png');
    const missingSource = addSource('disk', 'second', 'second.png');
    fs.unlinkSync(missingSource);
    createStack({
      id: 'two_files',
      name: 'Two files',
      type: 'animation',
      itemCount: 2,
      representativeAssetId: 'first',
      assetIdsWithIndex: [
        { assetId: 'first', index: 0 },
        { assetId: 'second', index: 1 },
      ],
    });

    await expect(copyAssetToProject({
      stackId: 'two_files',
      copyStackAll: true,
      targetPath: projectDir,
    })).rejects.toThrow();

    expect(fs.existsSync(projectDir)).toBe(false);
  });
});
