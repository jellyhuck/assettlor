import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { closeDatabase, createStack, initDatabase, upsertAsset } from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir, createTestZipArchive } from './helpers.js';

describe('copy HTTP responses', () => {
  let root: string;
  let projectDir: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = createTempDir('copy-http-');
    projectDir = path.join(root, 'project');
    initDatabase(path.join(root, 'data'));

    for (const [id, name] of [['first', 'first.png'], ['second', 'second.png']]) {
      const source = path.join(root, name);
      fs.writeFileSync(source, `${id} bytes`);
      upsertAsset({
        id,
        path: name,
        absolutePath: source,
        name,
        extension: '.png',
        category: 'image',
        size: fs.statSync(source).size,
        mtime: 1,
        hash: id,
        isArchiveEntry: false,
      });
    }
    createStack({
      id: 'two-frames',
      name: 'Two frames',
      type: 'animation',
      itemCount: 2,
      representativeAssetId: 'first',
      assetIdsWithIndex: [
        { assetId: 'first', index: 0 },
        { assetId: 'second', index: 1 },
      ],
    });

    app = await buildServer({
      logger: false,
      initDb: false,
      clientDistPath: path.join(root, 'missing-client-dist'),
    });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeDatabase();
    cleanupTempDir(root);
  });

  it('reports the containing directory and distinguishes one asset from a full stack', async () => {
    const representative = await app.inject({
      method: 'POST',
      url: '/api/assets/copy',
      payload: { assetId: 'first', targetPath: projectDir, targetSubfolder: 'textures/ui' },
    });
    expect(representative.statusCode).toBe(200);
    expect(representative.json()).toMatchObject({
      success: true,
      copyMode: 'asset',
      copiedCount: 1,
      targetDirectory: path.join(projectDir, 'textures/ui'),
      copiedFiles: [path.join(projectDir, 'textures/ui', 'first.png')],
    });

    const fullStack = await app.inject({
      method: 'POST',
      url: '/api/assets/copy',
      payload: { stackId: 'two-frames', copyStackAll: true, targetPath: projectDir },
    });
    expect(fullStack.statusCode).toBe(200);
    expect(fullStack.json()).toMatchObject({
      success: true,
      copyMode: 'stack',
      copiedCount: 2,
      targetDirectory: path.join(projectDir, 'Two_frames'),
    });
    expect(fullStack.json().copiedFiles).toHaveLength(2);
  });

  it('returns distinct validation, missing-source, and conflict errors', async () => {
    const invalid = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { stackId: 'two-frames', targetPath: projectDir },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().code).toBe('INVALID_COPY_REQUEST');
    expect(fs.existsSync(projectDir)).toBe(false);

    const missing = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { assetId: 'missing', targetPath: projectDir },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('COPY_SOURCE_MISSING');
    expect(fs.existsSync(projectDir)).toBe(false);

    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'first.png'), 'keep me');
    const conflict = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { assetId: 'first', targetPath: projectDir },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().code).toBe('COPY_CONFLICT');
    expect(fs.readFileSync(path.join(projectDir, 'first.png'), 'utf8')).toBe('keep me');
  });

  it('exposes exact rollback outcomes after an I/O failure', async () => {
    const destination = path.join(projectDir, 'output');
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, 'keep.txt'), 'project data');
    const secondFinal = path.join(destination, 'second.png');
    const originalLink = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, 'link').mockImplementation(async (staged, final) => {
      if (String(final) === secondFinal) {
        throw Object.assign(new Error('simulated disk failure'), { code: 'EIO' });
      }
      return originalLink(staged, final);
    });

    const response = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { stackId: 'two-frames', copyStackAll: true, targetPath: projectDir, targetSubfolder: 'output' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: 'COPY_IO_ERROR',
      details: {
        copiedFiles: [path.join(destination, 'first.png')],
        rolledBackFiles: [path.join(destination, 'first.png')],
        remainingFiles: [],
        failedFile: secondFinal,
        targetDirectory: destination,
      },
    });
    expect(fs.readdirSync(destination)).toEqual(['keep.txt']);
  });

  it('reports corrupt archive sources as I/O errors without creating a project', async () => {
    const archive = createTestZipArchive(path.join(root, 'pack.zip'), [
      { name: 'entry.png', content: 'original bytes' },
    ]);
    upsertAsset({
      id: 'archive-asset',
      path: 'pack.zip#/entry.png',
      absolutePath: archive,
      name: 'entry.png',
      extension: '.png',
      category: 'image',
      size: 14,
      mtime: 1,
      hash: 'archive-asset',
      isArchiveEntry: true,
      archivePath: archive,
      archiveEntryPath: 'entry.png',
    });
    fs.writeFileSync(archive, 'invalid ZIP');

    const response = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { assetId: 'archive-asset', targetPath: projectDir },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('COPY_IO_ERROR');
    expect(fs.existsSync(projectDir)).toBe(false);
  });

  it('reports a disk source removed after preflight as missing', async () => {
    const source = path.join(root, 'first.png');
    const copyFile = fs.promises.copyFile.bind(fs.promises);
    vi.spyOn(fs.promises, 'copyFile').mockImplementation(async (from, to, mode) => {
      if (String(from) === source) fs.unlinkSync(source);
      return copyFile(from, to, mode);
    });

    const response = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { assetId: 'first', targetPath: projectDir },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      code: 'COPY_SOURCE_MISSING',
      details: { copiedFiles: [], rolledBackFiles: [], remainingFiles: [] },
    });
    expect(fs.readdirSync(projectDir)).toEqual([]);
  });

  it('reports an inaccessible archive as I/O failure before creating a project', async () => {
    const archive = createTestZipArchive(path.join(root, 'restricted.zip'), [
      { name: 'entry.png', content: 'archive bytes' },
    ]);
    upsertAsset({
      id: 'restricted-archive',
      path: 'restricted.zip#/entry.png',
      absolutePath: archive,
      name: 'entry.png',
      extension: '.png',
      category: 'image',
      size: 13,
      mtime: 1,
      hash: 'restricted-archive',
      isArchiveEntry: true,
      archivePath: archive,
      archiveEntryPath: 'entry.png',
    });
    const existsSync = fs.existsSync.bind(fs);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      String(candidate) === archive ? false : existsSync(candidate));
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === archive) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return stat(candidate);
    });

    const response = await app.inject({
      method: 'POST', url: '/api/assets/copy',
      payload: { assetId: 'restricted-archive', targetPath: projectDir },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().code).toBe('COPY_IO_ERROR');
    expect(fs.existsSync(projectDir)).toBe(false);
  });
});
