import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { scanRoutes } from '../server/src/routes/scan.js';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  getAppSettings,
  initDatabase,
  updateAppSettings,
} from '../server/src/db/database.js';
import {
  getCurrentScanStatus,
  getScanListenerCountForTesting,
} from '../server/src/services/scanner.js';
import type { ScanProgressEvent } from '../shared/types.js';
import { cleanupTempDir, createTempDir, TINY_PNG_BUFFER } from './helpers.js';

class FakeRawResponse extends EventEmitter {
  frames: string[] = [];
  writableEnded = false;
  destroyed = false;
  acceptWrites = true;

  setHeader(_name: string, _value: string): this { return this; }
  flushHeaders(): void {}
  write(frame: string): boolean {
    this.frames.push(frame);
    return this.acceptWrites;
  }
  end(): this {
    this.writableEnded = true;
    this.emit('close');
    return this;
  }
}

interface FakeSseReply {
  raw: FakeRawResponse;
  hijack(): void;
}

async function captureSseRoute(): Promise<{
  connect: (raw: FakeRawResponse, request?: object) => void;
  closeServer: () => Promise<void>;
}> {
  let progressHandler: ((request: object, reply: FakeSseReply) => void) | undefined;
  let preClose: (() => Promise<void>) | undefined;
  const fakeFastify = {
    addHook: (_name: string, hook: () => Promise<void>) => { preClose = hook; },
    get: (url: string, handler: (request: object, reply: FakeSseReply) => void) => {
      if (url === '/api/scan/progress') progressHandler = handler;
    },
    post: () => {},
    log: { debug: vi.fn(), error: vi.fn() },
  } as unknown as FastifyInstance;
  await scanRoutes(fakeFastify);
  if (!progressHandler || !preClose) throw new Error('SSE route did not register');
  return {
    connect: (raw, request = {}) => progressHandler(request, { raw, hijack: () => {} }),
    closeServer: preClose,
  };
}

function dataEvents(raw: FakeRawResponse): ScanProgressEvent[] {
  return raw.frames
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice(6)) as ScanProgressEvent);
}

describe('scan route admission and SSE lifecycle', () => {
  let app: FastifyInstance;
  let libraryDir: string;
  let dataDir: string;

  beforeEach(async () => {
    libraryDir = createTempDir('scan-route-library-');
    dataDir = createTempDir('scan-route-data-');
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryDir],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
        folder: { enabled: false },
      },
    });
    initDatabase(dataDir);
    updateAppSettings({ libraryPaths: [libraryDir] });
    app = await buildServer({ initDb: false, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(libraryDir);
    cleanupTempDir(dataDir);
  });

  it('rejects invalid roots without changing configured libraries', async () => {
    const before = getAppSettings().libraryPaths;
    const statusBefore = getCurrentScanStatus();
    const missing = path.join(libraryDir, 'missing');
    const file = path.join(libraryDir, 'not-a-directory.txt');
    fs.writeFileSync(file, 'x');

    for (const payload of [
      { libraryPaths: [missing] },
      { libraryPaths: [file] },
      { libraryPaths: [libraryDir, ''] },
      { libraryPaths: 'invalid' },
      { libraryPath: 42 },
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/scan/start',
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(getAppSettings().libraryPaths).toEqual(before);
      expect(getCurrentScanStatus()).toEqual(statusBefore);
    }

    const reindex = await app.inject({
      method: 'POST',
      url: '/api/scan/library',
      payload: { libraryPath: missing, reindex: true },
    });
    expect(reindex.statusCode).toBe(400);
    expect(getAppSettings().libraryPaths).toEqual(before);
    expect(getCurrentScanStatus()).toEqual(statusBefore);

    const fileScan = await app.inject({
      method: 'POST',
      url: '/api/scan/library',
      payload: { libraryPath: file },
    });
    expect(fileScan.statusCode).toBe(400);
    expect(getAppSettings().libraryPaths).toEqual(before);
    expect(getCurrentScanStatus()).toEqual(statusBefore);
  });

  it('deduplicates roots before admission and keeps offline roots for a partial scan', async () => {
    const missing = path.join(libraryDir, 'offline');
    const response = await app.inject({
      method: 'POST',
      url: '/api/scan/start',
      payload: { libraryPaths: [libraryDir, path.join(libraryDir, '.'), missing, missing] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().libraryPaths).toEqual([libraryDir, missing]);
    expect(getAppSettings().libraryPaths).toEqual([libraryDir, missing]);
  });

  it('returns a conflict for a reserved scan without saving the rejected roots', async () => {
    fs.writeFileSync(path.join(libraryDir, 'sprite.png'), TINY_PNG_BUFFER);
    const alternate = createTempDir('scan-route-alternate-');
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, options) => {
      if (String(directory) === libraryDir) await gate;
      return originalReaddir(directory, options);
    });

    try {
      const first = await app.inject({
        method: 'POST',
        url: '/api/scan/start',
        payload: { libraryPath: libraryDir },
      });
      expect(first.statusCode).toBe(200);
      expect(getCurrentScanStatus().status).toBe('scanning');

      const rejected = await app.inject({
        method: 'POST',
        url: '/api/scan/start',
        payload: { libraryPath: alternate },
      });
      expect(rejected.statusCode).toBe(409);
      expect(getAppSettings().libraryPaths).toEqual([libraryDir]);
    } finally {
      release();
      cleanupTempDir(alternate);
    }
  });

  it('sends immediate status, cleans up disconnects, and gives reconnects current status', async () => {
    const sse = await captureSseRoute();
    const initialCount = getScanListenerCountForTesting();
    const first = new FakeRawResponse();
    const request = new EventEmitter();
    sse.connect(first, request);
    expect(dataEvents(first)[0]).toEqual(getCurrentScanStatus());
    expect(getScanListenerCountForTesting()).toBe(initialCount + 1);
    request.emit('close');
    expect(getScanListenerCountForTesting()).toBe(initialCount + 1);

    first.emit('close');
    expect(getScanListenerCountForTesting()).toBe(initialCount);

    const second = new FakeRawResponse();
    sse.connect(second);
    expect(dataEvents(second)[0]).toEqual(getCurrentScanStatus());
    expect(getScanListenerCountForTesting()).toBe(initialCount + 1);
    await sse.closeServer();
    expect(second.writableEnded).toBe(true);
    expect(getScanListenerCountForTesting()).toBe(initialCount);
  });

  it('streams one start-to-terminal lifecycle and coalesces backpressured updates', async () => {
    fs.writeFileSync(path.join(libraryDir, 'sprite.png'), TINY_PNG_BUFFER);
    const sse = await captureSseRoute();
    const initialCount = getScanListenerCountForTesting();
    const raw = new FakeRawResponse();
    raw.acceptWrites = false;
    sse.connect(raw);
    expect(dataEvents(raw)).toHaveLength(1);
    const normal = new FakeRawResponse();
    sse.connect(normal);

    const start = await app.inject({
      method: 'POST',
      url: '/api/scan/start',
      payload: { libraryPath: libraryDir },
    });
    expect(start.statusCode).toBe(200);
    await vi.waitFor(() => {
      expect(getCurrentScanStatus().status).toBe('completed');
    }, { timeout: 10_000 });
    expect(dataEvents(normal).some((event) => event.status === 'scanning')).toBe(true);
    expect(dataEvents(normal).filter((event) => event.status === 'completed')).toHaveLength(1);
    expect(dataEvents(raw)).toHaveLength(1);

    raw.acceptWrites = true;
    raw.emit('drain');
    expect(dataEvents(raw).map((event) => event.status)).toEqual([
      dataEvents(raw)[0].status,
      'completed',
    ]);
    await sse.closeServer();
    expect(raw.writableEnded).toBe(true);
    expect(normal.writableEnded).toBe(true);
    expect(getScanListenerCountForTesting()).toBe(initialCount);
  });

  it('ends an injected SSE response when Fastify closes', async () => {
    const initialCount = getScanListenerCountForTesting();
    const pendingResponse = app.inject({ method: 'GET', url: '/api/scan/progress' });
    await vi.waitFor(() => expect(getScanListenerCountForTesting()).toBe(initialCount + 1));

    await app.close();
    const response = await pendingResponse;
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('data: ');
    expect(getScanListenerCountForTesting()).toBe(initialCount);
  });
});
