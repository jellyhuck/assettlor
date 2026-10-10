import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './helpers.js';

describe('Copy conflicts and interrupted copies', () => {
  let root: string;
  let libraryDir: string;
  let projectDir: string;

  beforeEach(() => {
    root = createTempDir('copy-conflicts-');
    libraryDir = path.join(root, 'library');
    projectDir = path.join(root, 'project');
    fs.mkdirSync(libraryDir);
    initDatabase(path.join(root, 'database'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cleanupTempDir(root);
  });

  function addSource(
    kind: 'disk' | 'zip',
    id: string,
    name: string,
    content: string,
  ): string {
    const sourcePath = path.join(libraryDir, kind === 'disk' ? `${id}.png` : `${id}.zip`);
    const archiveEntryPath = `inner/${id}.png`;
    if (kind === 'disk') {
      fs.writeFileSync(sourcePath, content);
    } else {
      createTestZipArchive(sourcePath, [{ name: archiveEntryPath, content }]);
    }

    upsertAsset({
      id,
      path: kind === 'disk' ? `${id}.png` : `${id}.zip#/${archiveEntryPath}`,
      absolutePath: sourcePath,
      name,
      extension: '.png',
      category: 'image',
      size: Buffer.byteLength(content),
      mtime: 100,
      hash: `copy-conflicts-${id}`,
      isArchiveEntry: kind === 'zip',
      archivePath: kind === 'zip' ? sourcePath : null,
      archiveEntryPath: kind === 'zip' ? archiveEntryPath : null,
    });
    return sourcePath;
  }

  function addStack(id: string, name: string, assetIds: string[]): void {
    createStack({
      id,
      name,
      type: 'animation',
      itemCount: assetIds.length,
      representativeAssetId: assetIds[0],
      assetIdsWithIndex: assetIds.map((assetId, index) => ({ assetId, index })),
    });
  }

  for (const kind of ['disk', 'zip'] as const) {
    it(`keeps an existing ${kind} copy destination unchanged`, async () => {
      addSource(kind, 'source', 'icon.png', 'new asset bytes');
      fs.mkdirSync(projectDir);
      const destination = path.join(projectDir, 'icon.png');
      fs.writeFileSync(destination, 'existing project bytes');

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
      })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

      expect(fs.readFileSync(destination, 'utf8')).toBe('existing project bytes');
      expect(fs.readdirSync(projectDir)).toEqual(['icon.png']);
    });

    it(`rejects an existing destination symlink for a ${kind} source`, async () => {
      addSource(kind, 'source', 'icon.png', 'new asset bytes');
      fs.mkdirSync(projectDir);
      const outsideFile = path.join(root, 'outside.png');
      fs.writeFileSync(outsideFile, 'outside bytes');
      fs.symlinkSync(outsideFile, path.join(projectDir, 'icon.png'));

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
      })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

      expect(fs.readFileSync(outsideFile, 'utf8')).toBe('outside bytes');
      expect(fs.lstatSync(path.join(projectDir, 'icon.png')).isSymbolicLink()).toBe(true);
    });

    it(`preserves a ${kind} destination created after preflight`, async () => {
      addSource(kind, 'source', 'icon.png', 'new asset bytes');
      const destination = path.join(projectDir, 'icon.png');
      const originalLink = fs.promises.link.bind(fs.promises);
      vi.spyOn(fs.promises, 'link').mockImplementation(async (stagedPath, finalPath) => {
        expect(String(finalPath)).toBe(destination);
        fs.writeFileSync(finalPath, 'concurrent project bytes');
        return originalLink(stagedPath, finalPath);
      });

      await expect(copyAssetToProject({
        assetId: 'source',
        targetPath: projectDir,
      })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

      expect(fs.readFileSync(destination, 'utf8')).toBe('concurrent project bytes');
      expect(fs.readdirSync(projectDir)).toEqual(['icon.png']);
    });
  }

  it('rejects two stack members with the same destination basename', async () => {
    addSource('disk', 'first', 'shared.png', 'first bytes');
    addSource('zip', 'second', 'shared.png', 'second bytes');
    addStack('duplicate_names', 'Duplicate names', ['first', 'second']);

    await expect(copyAssetToProject({
      stackId: 'duplicate_names',
      copyStackAll: true,
      targetPath: projectDir,
    })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('keeps the first stack copy when two names sanitize to one folder', async () => {
    addSource('disk', 'first', 'frame.png', 'first stack bytes');
    addSource('zip', 'second', 'frame.png', 'second stack bytes');
    addStack('first_stack', 'Idle frame', ['first']);
    addStack('second_stack', 'Idle?frame', ['second']);

    await copyAssetToProject({
      stackId: 'first_stack',
      copyStackAll: true,
      targetPath: projectDir,
    });
    const destination = path.join(projectDir, 'Idle_frame', 'frame.png');

    await expect(copyAssetToProject({
      stackId: 'second_stack',
      copyStackAll: true,
      targetPath: projectDir,
    })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

    expect(fs.readFileSync(destination, 'utf8')).toBe('first stack bytes');
    expect(fs.readdirSync(path.dirname(destination))).toEqual(['frame.png']);
  });

  it('checks a later missing stack member before creating directories', async () => {
    addSource('disk', 'first', 'first.png', 'first bytes');
    const missingArchive = addSource('zip', 'second', 'second.png', 'second bytes');
    addStack('missing_second', 'Missing second', ['first', 'second']);
    fs.unlinkSync(missingArchive);

    await expect(copyAssetToProject({
      stackId: 'missing_second',
      copyStackAll: true,
      targetPath: projectDir,
    })).rejects.toMatchObject({ status: 404, code: 'COPY_SOURCE_MISSING' });

    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('rejects copying a disk file onto itself without changing it', async () => {
    fs.mkdirSync(projectDir);
    const sourcePath = path.join(projectDir, 'self.png');
    fs.writeFileSync(sourcePath, 'original bytes');
    upsertAsset({
      id: 'self',
      path: 'self.png',
      absolutePath: sourcePath,
      name: 'self.png',
      extension: '.png',
      category: 'image',
      size: Buffer.byteLength('original bytes'),
      mtime: 100,
      hash: 'copy-conflicts-self',
      isArchiveEntry: false,
    });

    await expect(copyAssetToProject({
      assetId: 'self',
      targetPath: projectDir,
    })).rejects.toMatchObject({ status: 409, code: 'COPY_CONFLICT' });

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe('original bytes');
  });

  it('reports destination disappearance as I/O failure rather than missing source', async () => {
    addSource('disk', 'source', 'icon.png', 'asset bytes');
    const originalCopyFile = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (source, destination, mode) => {
      fs.rmSync(projectDir, { recursive: true, force: true });
      return originalCopyFile(source, destination, mode);
    });

    await expect(copyAssetToProject({
      assetId: 'source',
      targetPath: projectDir,
    })).rejects.toMatchObject({
      status: 500,
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [],
        rolledBackFiles: [],
        remainingFiles: [],
        failedFile: path.join(projectDir, 'icon.png'),
      },
    });
  });

  it('rolls back only files published by an interrupted stack copy', async () => {
    addSource('disk', 'first', 'first.png', 'first bytes');
    addSource('zip', 'second', 'second.png', 'second bytes');
    addStack('interrupted', 'Interrupted stack', ['first', 'second']);
    const destinationDir = path.join(projectDir, 'output');
    fs.mkdirSync(destinationDir, { recursive: true });
    const unrelatedFile = path.join(destinationDir, 'keep.txt');
    fs.writeFileSync(unrelatedFile, 'pre-existing project bytes');
    const firstDestination = path.join(destinationDir, 'first.png');
    const secondDestination = path.join(destinationDir, 'second.png');
    const originalLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (stagedPath, finalPath) => {
      if (String(finalPath) === secondDestination) {
        throw Object.assign(new Error('simulated publish failure'), { code: 'EIO' });
      }
      return originalLink(stagedPath, finalPath);
    });

    await expect(copyAssetToProject({
      stackId: 'interrupted',
      copyStackAll: true,
      targetPath: projectDir,
      targetSubfolder: 'output',
    })).rejects.toMatchObject({
      status: 500,
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [firstDestination],
        rolledBackFiles: [firstDestination],
        remainingFiles: [],
        failedFile: secondDestination,
        targetDirectory: destinationDir,
      },
    });

    expect(fs.readFileSync(unrelatedFile, 'utf8')).toBe('pre-existing project bytes');
    expect(fs.readdirSync(destinationDir)).toEqual(['keep.txt']);
  });

  it('reports the exact partial result when rollback cannot remove a new file', async () => {
    addSource('disk', 'first', 'first.png', 'first bytes');
    addSource('zip', 'second', 'second.png', 'second bytes');
    addStack('partial', 'Partial stack', ['first', 'second']);
    const destinationDir = path.join(projectDir, 'output');
    fs.mkdirSync(destinationDir, { recursive: true });
    const unrelatedFile = path.join(destinationDir, 'keep.txt');
    fs.writeFileSync(unrelatedFile, 'pre-existing project bytes');
    const firstDestination = path.join(destinationDir, 'first.png');
    const secondDestination = path.join(destinationDir, 'second.png');
    const originalLink = fs.promises.link.bind(fs.promises);
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (stagedPath, finalPath) => {
      if (String(finalPath) === secondDestination) {
        throw Object.assign(new Error('simulated publish failure'), { code: 'EIO' });
      }
      return originalLink(stagedPath, finalPath);
    });
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (filePath) => {
      if (String(filePath) === firstDestination) {
        throw Object.assign(new Error('simulated rollback failure'), { code: 'EACCES' });
      }
      return originalUnlink(filePath);
    });

    await expect(copyAssetToProject({
      stackId: 'partial',
      copyStackAll: true,
      targetPath: projectDir,
      targetSubfolder: 'output',
    })).rejects.toMatchObject({
      status: 500,
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [firstDestination],
        rolledBackFiles: [],
        remainingFiles: [firstDestination],
        failedFile: secondDestination,
        targetDirectory: destinationDir,
      },
    });

    expect(fs.readFileSync(firstDestination, 'utf8')).toBe('first bytes');
    expect(fs.readFileSync(unrelatedFile, 'utf8')).toBe('pre-existing project bytes');
    expect(fs.readdirSync(destinationDir)).toEqual(['first.png', 'keep.txt']);
  });

  it('reports a staged file that survives cleanup after publication', async () => {
    addSource('disk', 'source', 'icon.png', 'new asset bytes');
    fs.mkdirSync(projectDir);
    const unrelatedFile = path.join(projectDir, 'keep.txt');
    fs.writeFileSync(unrelatedFile, 'pre-existing project bytes');
    const destination = path.join(projectDir, 'icon.png');
    const stagePaths = new Set<string>();
    const originalUnlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, 'unlink').mockImplementation(async (filePath) => {
      const candidate = String(filePath);
      if (path.basename(candidate).startsWith('.assettlor-copy-') && candidate.endsWith('.tmp')) {
        stagePaths.add(candidate);
        throw Object.assign(new Error('simulated stage cleanup failure'), { code: 'EACCES' });
      }
      return originalUnlink(filePath);
    });

    const error: unknown = await copyAssetToProject({
      assetId: 'source',
      targetPath: projectDir,
    }).then(
      () => { throw new Error('Expected stage cleanup to fail'); },
      (rejection: unknown) => rejection,
    );

    expect(stagePaths.size).toBe(1);
    const [stagePath] = [...stagePaths];
    expect(error).toMatchObject({
      status: 500,
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [destination],
        rolledBackFiles: [destination],
        remainingFiles: [stagePath],
        failedFile: destination,
        targetDirectory: projectDir,
      },
    });
    expect(fs.existsSync(destination)).toBe(false);
    expect(fs.readFileSync(stagePath, 'utf8')).toBe('new asset bytes');
    expect(fs.readFileSync(unrelatedFile, 'utf8')).toBe('pre-existing project bytes');
    expect(fs.readdirSync(projectDir).sort()).toEqual([path.basename(stagePath), 'keep.txt'].sort());
  });

  it('does not remove a replacement file at a rolled-back destination', async () => {
    addSource('disk', 'first', 'first.png', 'first bytes');
    addSource('zip', 'second', 'second.png', 'second bytes');
    addStack('replaced', 'Replaced stack', ['first', 'second']);
    const destinationDir = path.join(projectDir, 'output');
    fs.mkdirSync(destinationDir, { recursive: true });
    const unrelatedFile = path.join(destinationDir, 'keep.txt');
    fs.writeFileSync(unrelatedFile, 'pre-existing project bytes');
    const replacementFile = path.join(destinationDir, 'replacement.tmp');
    fs.writeFileSync(replacementFile, 'replacement bytes');
    const firstDestination = path.join(destinationDir, 'first.png');
    const secondDestination = path.join(destinationDir, 'second.png');
    const originalLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (stagedPath, finalPath) => {
      if (String(finalPath) === secondDestination) {
        fs.unlinkSync(firstDestination);
        fs.renameSync(replacementFile, firstDestination);
        throw Object.assign(new Error('simulated publish failure'), { code: 'EIO' });
      }
      return originalLink(stagedPath, finalPath);
    });

    await expect(copyAssetToProject({
      stackId: 'replaced',
      copyStackAll: true,
      targetPath: projectDir,
      targetSubfolder: 'output',
    })).rejects.toMatchObject({
      status: 500,
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [firstDestination],
        rolledBackFiles: [],
        remainingFiles: [],
        failedFile: secondDestination,
        targetDirectory: destinationDir,
      },
    });

    expect(fs.readFileSync(firstDestination, 'utf8')).toBe('replacement bytes');
    expect(fs.readFileSync(unrelatedFile, 'utf8')).toBe('pre-existing project bytes');
    expect(fs.readdirSync(destinationDir)).toEqual(['first.png', 'keep.txt']);
  });
});
