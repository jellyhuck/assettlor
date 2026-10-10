import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { closeDatabase, initDatabase, upsertAsset } from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir, createTestZipArchive } from './helpers.js';

const TEN_BYTES = Buffer.from('0123456789');

describe('asset file HTTP ranges', () => {
  let app: FastifyInstance;
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = createTempDir('asset-http-');
    initDatabase(path.join(tempRoot, 'data'));

    for (const [kind, content] of [
      ['disk', TEN_BYTES],
      ['empty-disk', Buffer.alloc(0)],
    ] as const) {
      const diskPath = path.join(tempRoot, `${kind}.wav`);
      fs.writeFileSync(diskPath, content);
      upsertAsset({
        id: kind,
        path: `${kind}.wav`,
        absolutePath: diskPath,
        name: `${kind}.wav`,
        extension: '.wav',
        category: 'audio',
        size: content.length,
        mtime: 1,
        hash: kind,
        isArchiveEntry: false,
      });
    }

    const archivePath = path.join(tempRoot, 'pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'ten.wav', content: TEN_BYTES },
      { name: 'empty.wav', content: Buffer.alloc(0) },
    ]);
    for (const [kind, entryPath, content] of [
      ['zip', 'ten.wav', TEN_BYTES],
      ['empty-zip', 'empty.wav', Buffer.alloc(0)],
    ] as const) {
      upsertAsset({
        id: kind,
        path: `pack.zip#/${entryPath}`,
        absolutePath: archivePath,
        name: entryPath,
        extension: '.wav',
        category: 'audio',
        size: content.length,
        mtime: 1,
        hash: kind,
        isArchiveEntry: true,
        archivePath,
        archiveEntryPath: entryPath,
      });
    }

    app = await buildServer({
      logger: false,
      initDb: false,
      clientDistPath: path.join(tempRoot, 'missing-client-dist'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    cleanupTempDir(tempRoot);
  });

  const tenByteCases: {
    name: string;
    method?: 'GET' | 'HEAD';
    range?: string;
    status: number;
    contentRange?: string;
    bytes: string;
  }[] = [
    { name: 'full response', status: 200, bytes: '0123456789' },
    { name: 'HEAD response', method: 'HEAD', status: 200, bytes: '' },
    { name: 'first byte', range: 'bytes=0-0', status: 206, contentRange: 'bytes 0-0/10', bytes: '0' },
    { name: 'open ended range', range: 'bytes=8-', status: 206, contentRange: 'bytes 8-9/10', bytes: '89' },
    { name: 'suffix range', range: 'bytes=-3', status: 206, contentRange: 'bytes 7-9/10', bytes: '789' },
    { name: 'suffix larger than file', range: 'bytes=-20', status: 206, contentRange: 'bytes 0-9/10', bytes: '0123456789' },
    { name: 'end beyond EOF', range: 'bytes=0-999', status: 206, contentRange: 'bytes 0-9/10', bytes: '0123456789' },
    { name: 'range HEAD response', method: 'HEAD', range: 'bytes=8-', status: 206, contentRange: 'bytes 8-9/10', bytes: '' },
    { name: 'start at EOF', range: 'bytes=10-', status: 416, contentRange: 'bytes */10', bytes: '' },
    { name: 'start beyond EOF', range: 'bytes=11-12', status: 416, contentRange: 'bytes */10', bytes: '' },
    { name: 'reversed range', range: 'bytes=8-3', status: 416, contentRange: 'bytes */10', bytes: '' },
    { name: 'zero suffix', range: 'bytes=-0', status: 416, contentRange: 'bytes */10', bytes: '' },
    { name: 'negative value', range: 'bytes=-1-3', status: 200, bytes: '0123456789' },
    { name: 'non-numeric value', range: 'bytes=abc-def', status: 200, bytes: '0123456789' },
    { name: 'multi-range request', range: 'bytes=0-1,3-4', status: 200, bytes: '0123456789' },
    { name: 'unknown unit', range: 'items=0-1', status: 200, bytes: '0123456789' },
    { name: 'unsafe integer', range: 'bytes=9007199254740992-', status: 200, bytes: '0123456789' },
  ];

  for (const source of ['disk', 'zip'] as const) {
    for (const sample of tenByteCases) {
      it(`${source}: ${sample.name}`, async () => {
        const response = await app.inject({
          method: sample.method ?? 'GET',
          url: `/api/assets/${source}/file`,
          headers: sample.range ? { range: sample.range } : undefined,
        });

        expect(response.statusCode).toBe(sample.status);
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.headers['content-range']).toBe(sample.contentRange);
        const expectedLength = sample.method === 'HEAD'
          ? sample.status === 206 ? 2 : 10
          : Buffer.byteLength(sample.bytes);
        expect(response.headers['content-length']).toBe(String(expectedLength));
        expect(response.rawPayload).toEqual(Buffer.from(sample.bytes));
      });
    }

    for (const [name, method, range, status, contentRange] of [
      ['full empty response', 'GET', undefined, 200, undefined],
      ['empty HEAD response', 'HEAD', undefined, 200, undefined],
      ['empty closed range', 'GET', 'bytes=0-0', 416, 'bytes */0'],
      ['empty suffix range', 'GET', 'bytes=-3', 416, 'bytes */0'],
    ] as const) {
      it(`${source}: ${name}`, async () => {
        const response = await app.inject({
          method,
          url: `/api/assets/empty-${source}/file`,
          headers: range ? { range } : undefined,
        });

        expect(response.statusCode).toBe(status);
        expect(response.headers['accept-ranges']).toBe('bytes');
        expect(response.headers['content-range']).toBe(contentRange);
        expect(response.headers['content-length']).toBe('0');
        expect(response.rawPayload).toEqual(Buffer.alloc(0));
      });
    }
  }
});
