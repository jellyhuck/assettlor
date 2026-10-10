import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import { closeDatabase, initDatabase, upsertAsset } from '../server/src/db/database.js';
import { copyAssetToProject } from '../server/src/services/copier.js';
import { cleanupTempDir, createTempDir, createTestZipArchive } from './helpers.js';

const svg = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" onload="fetch(\'/api/settings\')">' +
  '<script>fetch("/api/settings")</script>' +
  '<image href="https://example.invalid/tracker.png" width="20" height="20"/>' +
  '<circle cx="10" cy="10" r="8" fill="red"/></svg>'
);

describe('SVG file isolation', () => {
  let root: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    root = createTempDir('svg-isolation-');
    initDatabase(path.join(root, 'data'));

    const diskPath = path.join(root, 'source.svg');
    fs.writeFileSync(diskPath, svg);
    const zipPath = createTestZipArchive(path.join(root, 'pack.zip'), [
      { name: 'inner/source.svg', content: svg },
    ]);

    for (const [id, absolutePath, isArchiveEntry] of [
      ['disk-svg', diskPath, false],
      ['zip-svg', zipPath, true],
    ] as const) {
      upsertAsset({
        id,
        path: isArchiveEntry ? 'pack.zip#/inner/source.svg' : 'source.svg',
        absolutePath,
        name: 'source.svg',
        extension: '.svg',
        category: 'image',
        size: svg.length,
        mtime: 1,
        hash: id,
        isArchiveEntry,
        ...(isArchiveEntry ? { archivePath: zipPath, archiveEntryPath: 'inner/source.svg' } : {}),
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
    await app.close();
    closeDatabase();
    cleanupTempDir(root);
  });

  it.each(['disk-svg', 'zip-svg'])('sandboxes direct %s responses while preserving image bytes', async (id) => {
    const response = await app.inject({ method: 'GET', url: `/api/assets/${id}/file` });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('image/svg+xml');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['content-disposition']).toBe('inline');
    const policy = String(response.headers['content-security-policy']);
    expect(policy).toMatch(/(?:^|; )sandbox(?:;|$)/u);
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain('img-src data:');
    expect(policy).not.toMatch(/allow-same-origin|allow-scripts/u);
    expect(response.rawPayload.equals(svg)).toBe(true);
  });

  it.each(['disk-svg', 'zip-svg'])('keeps isolation headers on %s partial and HEAD responses', async (id) => {
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({
        method,
        url: `/api/assets/${id}/file`,
        headers: { range: 'bytes=0-9' },
      });

      expect(response.statusCode).toBe(206);
      expect(response.headers['content-security-policy']).toContain('sandbox');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-disposition']).toBe('inline');
      expect(response.rawPayload).toEqual(method === 'HEAD' ? Buffer.alloc(0) : svg.subarray(0, 10));
    }
  });

  it('copies the original SVG bytes into the selected project', async () => {
    const project = path.join(root, 'project');
    const result = await copyAssetToProject({
      assetId: 'disk-svg',
      targetPath: project,
    });

    expect(result.success).toBe(true);
    expect(fs.readFileSync(result.copiedFiles[0]).equals(svg)).toBe(true);
  });
});
