import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { buildServer } from '../server/src/index.js';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  getDatabase,
  initDatabase,
  isDatabaseInitialized,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('server startup and filesystem errors', () => {
  let root: string;
  const apps: FastifyInstance[] = [];

  beforeEach(() => {
    root = createTempDir('runtime-startup-');
    resetConfigForTesting();
    closeDatabase();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const app of apps.splice(0).reverse()) await app.close();
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(root);
  });

  async function start(dataDir?: string) {
    const app = await buildServer({
      dataDir: dataDir || path.join(root, 'data'),
      clientDistPath: path.join(root, 'missing-dist'),
      logger: false,
    });
    apps.push(app);
    await app.ready();
    return app;
  }

  it('rejects startup if storage cannot be initialized', async () => {
    const blocker = path.join(root, 'blocked');
    fs.writeFileSync(blocker, 'file blocks database directory');

    await expect(start(blocker)).rejects.toThrow();
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('keeps the previous database if switching storage roots fails', () => {
    const existing = initDatabase(path.join(root, 'working-data'));
    const blocker = path.join(root, 'blocked');
    fs.writeFileSync(blocker, 'file blocks database directory');

    expect(() => initDatabase(blocker)).toThrow();
    expect(getDatabase()).toBe(existing);
  });

  it('keeps a shared database open until the last server closes, then reopens it', async () => {
    const first = await start();
    const second = await start();
    const database = getDatabase();

    await first.close();
    expect(getDatabase()).toBe(database);
    await second.close();
    expect(() => getDatabase()).toThrow('Database has not been initialized');

    const reopened = await start();
    expect(getDatabase()).not.toBe(database);
    await reopened.close();
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('does not close an externally initialized database', async () => {
    const dataDir = path.join(root, 'external-data');
    const external = initDatabase(dataDir);
    const app = await start(dataDir);
    await app.close();
    expect(getDatabase()).toBe(external);
  });

  it('ends an open progress stream before closing the database', async () => {
    const app = await start();
    const stream = app.inject({ method: 'GET', url: '/api/scan/progress' });
    await new Promise((resolve) => setTimeout(resolve, 10));

    await app.close();
    const response = await stream;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data:');
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('waits for an in-progress scan before releasing storage', async () => {
    const app = await start();
    const library = path.join(root, 'assets');
    fs.mkdirSync(library);
    let releaseRead: ((entries: fs.Dirent[]) => void) | undefined;
    vi.spyOn(fs.promises, 'readdir').mockImplementationOnce(
      () => new Promise<fs.Dirent[]>((resolve) => { releaseRead = resolve; }) as never
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/scan/start',
      payload: { libraryPath: library },
    });
    expect(response.statusCode).toBe(200);

    for (let attempt = 0; attempt < 50 && !releaseRead; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(releaseRead).toBeDefined();

    let closed = false;
    const closing = app.close().then(() => { closed = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(closed).toBe(false);
    releaseRead?.([]);
    await closing;
    expect(isDatabaseInitialized()).toBe(false);
  });

  it('does not close a replaced database handle at the same path', async () => {
    const app = await start();
    const original = getDatabase();
    closeDatabase();
    const replacement = initDatabase(path.join(root, 'data'));
    expect(replacement).not.toBe(original);

    await app.close();
    expect(getDatabase()).toBe(replacement);
  });

  it('rejects a second storage root while preserving a live server', async () => {
    await start();
    const firstDatabase = getDatabase();
    await expect(start(path.join(root, 'other-data'))).rejects.toThrow('already open');
    expect(getDatabase()).toBe(firstDatabase);
  });

  it('returns client errors for invalid browse and validation paths', async () => {
    const app = await start();
    const file = path.join(root, 'file.txt');
    fs.writeFileSync(file, 'hello');

    for (const url of [
      `/api/fs/browse?path=${encodeURIComponent(file)}`,
      `/api/fs/browse?path=${encodeURIComponent(path.join(file, 'child'))}`,
      '/api/fs/browse?path=',
      '/api/fs/browse?path=one&path=two',
    ]) {
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(400);
    }
    expect((await app.inject({
      method: 'GET',
      url: `/api/fs/browse?path=${encodeURIComponent(path.join(root, 'missing'))}`,
    })).statusCode).toBe(404);

    for (const payload of [{ path: file }, { path: path.join(file, 'child') }, { path: 42 }, { path: '' }, []]) {
      const response = await app.inject({ method: 'POST', url: '/api/fs/validate', payload });
      expect(response.statusCode).toBe(400);
    }
  });

  it('reports inaccessible directories without changing the requested path', async () => {
    const app = await start();
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(denied);
    const response = await app.inject({
      method: 'GET',
      url: `/api/fs/browse?path=${encodeURIComponent(root)}`,
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toContain('permission denied');
  });
});
