import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { closeDatabase, initDatabase, upsertAsset } from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir, createTestZipArchive } from './helpers.js';

const bytes = Buffer.from('0123456789');

describe('file and stack availability responses', () => {
  let root: string;
  let diskPath: string;
  let zipPath: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = createTempDir('file-availability-');
    initDatabase(path.join(root, 'data'));
    diskPath = path.join(root, 'source.wav');
    zipPath = createTestZipArchive(path.join(root, 'pack.zip'), [
      { name: 'inner/source.wav', content: bytes },
    ]);
    fs.writeFileSync(diskPath, bytes);

    for (const [id, absolutePath, isArchiveEntry] of [
      ['disk', diskPath, false],
      ['zip', zipPath, true],
    ] as const) {
      upsertAsset({
        id,
        path: isArchiveEntry ? 'pack.zip#/inner/source.wav' : 'source.wav',
        absolutePath,
        name: 'source.wav',
        extension: '.wav',
        category: 'audio',
        size: bytes.length,
        mtime: 1,
        hash: id,
        isArchiveEntry,
        ...(isArchiveEntry ? { archivePath: zipPath, archiveEntryPath: 'inner/source.wav' } : {}),
      });
    }
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

  it('returns 404 for assets of an unknown stack', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/stacks/missing/assets' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Stack not found' });
  });

  it('returns 404 before range headers when a disk file disappears', async () => {
    fs.unlinkSync(diskPath);
    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/disk/file',
      headers: { range: 'bytes=0-3' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe('File missing on disk');
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  });

  it('keeps a complete response when the disk path is unlinked after opening', async () => {
    const realOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === diskPath) fs.unlinkSync(diskPath);
      return handle;
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/disk/file',
      headers: { range: 'bytes=3-6' },
    });
    expect(response.statusCode).toBe(206);
    expect(response.headers['content-range']).toBe('bytes 3-6/10');
    expect(response.headers['content-length']).toBe('4');
    expect(response.rawPayload).toEqual(Buffer.from('3456'));
  });

  it('returns 404 before range headers when an archive disappears', async () => {
    fs.unlinkSync(zipPath);
    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/zip/file',
      headers: { range: 'bytes=0-3' },
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  });

  it('returns a structured error before range headers for a corrupt archive', async () => {
    fs.writeFileSync(zipPath, 'not a ZIP archive');
    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/zip/file',
      headers: { range: 'bytes=0-3' },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toEqual({ error: 'Archive entry cannot be read' });
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  });

  it('reports an archive filesystem read failure as 500 before range headers', async () => {
    const originalStat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === zipPath) {
        throw Object.assign(new Error('read failed'), { code: 'EIO' });
      }
      return originalStat(candidate);
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/zip/file',
      headers: { range: 'bytes=0-3' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Archive cannot be read' });
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  });

  it('does not mistake an inaccessible archive for a missing entry', async () => {
    const existsSync = fs.existsSync.bind(fs);
    const stat = fs.promises.stat.bind(fs.promises);
    vi.spyOn(fs, 'existsSync').mockImplementation((candidate) =>
      String(candidate) === zipPath ? false : existsSync(candidate));
    vi.spyOn(fs.promises, 'stat').mockImplementation(async (candidate) => {
      if (String(candidate) === zipPath) {
        throw Object.assign(new Error('access denied'), { code: 'EACCES' });
      }
      return stat(candidate);
    });

    const response = await app.inject({
      method: 'GET',
      url: '/api/assets/zip/file',
      headers: { range: 'bytes=0-3' },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'Archive cannot be read' });
    expect(response.headers['content-range']).toBeUndefined();
    expect(response.headers['accept-ranges']).toBeUndefined();
  });
});
