import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { buildServer } from '../server/src/index.js';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  closeDatabase,
  createStack,
  getAssetById,
  getDatabase,
  initDatabase,
  upsertAsset,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('asset and stack tag routes', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir('asset-tag-routes-');
    resetConfigForTesting();
    initDatabase(tempDir);
    for (const [id, name] of [['asset-one', 'one.png'], ['asset-two', 'two.png']]) {
      upsertAsset({
        id,
        path: name,
        absolutePath: path.join(tempDir, name),
        name,
        extension: '.png',
        category: 'image',
        size: 1,
        mtime: 1,
        hash: `hash-${id}`,
        isArchiveEntry: false,
      });
    }
    createStack({
      id: 'stack-one',
      name: 'One',
      type: 'animation',
      itemCount: 2,
      representativeAssetId: 'asset-one',
      assetIdsWithIndex: [
        { assetId: 'asset-one', index: 0 },
        { assetId: 'asset-two', index: 1 },
      ],
    });
    app = await buildServer({
      initDb: false,
      logger: false,
      clientDistPath: path.join(tempDir, 'missing-dist'),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(tempDir);
  });

  it('deletes special asset tag names after one route decoding pass', async () => {
    const tags = ['100%', '%20', 'a/b', 'naïve🐛', 'two words', 'kind:ui'];
    const add = await app.inject({
      method: 'POST',
      url: '/api/assets/asset-one/tags',
      payload: { tags },
    });
    expect(add.statusCode).toBe(200);
    expect(add.json().tags).toEqual(expect.arrayContaining(tags));

    for (const tag of tags) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/assets/asset-one/tags/${encodeURIComponent(tag)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().tags).not.toContain(tag);
      if (tag === '%20') expect(response.json().tags).toContain('two words');
    }
    expect(getAssetById('asset-one')?.tags).toEqual([]);
  });

  it('deletes special stack tag names without targeting a different tag', async () => {
    const tags = ['100%', '%20', 'a/b', '日本語', 'two words', 'kind:ui'];
    const add = await app.inject({
      method: 'POST',
      url: '/api/stacks/stack-one/tags',
      payload: { tags },
    });
    expect(add.statusCode).toBe(200);

    for (const tag of tags) {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/stacks/stack-one/tags/${encodeURIComponent(tag)}`,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().tags).not.toContain(tag);
      if (tag === '%20') expect(response.json().tags).toContain('two words');
    }
    expect(getAssetById('asset-one')?.tags).toEqual([]);
    expect(getAssetById('asset-two')?.tags).toEqual([]);
  });

  it('rejects invalid mutation bodies and normalized-empty tags', async () => {
    const cases = [
      { method: 'POST' as const, url: '/api/assets/asset-one/tags', payload: { tags: [null] } },
      { method: 'POST' as const, url: '/api/assets/asset-one/tags', payload: { tag: '#' } },
      { method: 'POST' as const, url: '/api/assets/asset-one/tags', payload: { tag: 'ok', source: null } },
      { method: 'DELETE' as const, url: '/api/assets/asset-one/tags', payload: { tags: [42] } },
      { method: 'DELETE' as const, url: '/api/assets/asset-one/tags', payload: { tags: ['   '] } },
      { method: 'PUT' as const, url: '/api/assets/asset-one/tags', payload: { tags: ['#'] } },
      { method: 'PUT' as const, url: '/api/assets/asset-one/tags', payload: { tags: null } },
      { method: 'POST' as const, url: '/api/stacks/stack-one/tags', payload: { tags: [null] } },
      { method: 'DELETE' as const, url: '/api/stacks/stack-one/tags', payload: { tags: ['#'] } },
      { method: 'POST' as const, url: '/api/assets/tags', payload: { assetIds: ['asset-one'], tags: ['#'] } },
      { method: 'POST' as const, url: '/api/assets/tags', payload: { assetIds: ['asset-one', null], tags: ['ok'] } },
      { method: 'POST' as const, url: '/api/assets/tags', payload: { assetIds: ['asset-one'], tags: [null] } },
      { method: 'POST' as const, url: '/api/assets/tags', payload: { assetIds: ['asset-one'], tags: ['ok'], action: 'replace' } },
      { method: 'POST' as const, url: '/api/assets/tags', payload: { assetIds: ['asset-one'], tags: ['ok'], source: 12 } },
    ];
    for (const request of cases) {
      const response = await app.inject(request);
      expect(response.statusCode, `${request.method} ${request.url} ${JSON.stringify(request.payload)}`).toBe(400);
    }
    expect(getAssetById('asset-one')?.tags).toEqual([]);
    expect(getAssetById('asset-two')?.tags).toEqual([]);
  });

  it('allows an explicit empty replacement to clear existing tags', async () => {
    await app.inject({
      method: 'POST', url: '/api/assets/asset-one/tags', payload: { tag: 'old' },
    });
    const response = await app.inject({
      method: 'PUT', url: '/api/assets/asset-one/tags', payload: { tags: [] },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().tags).toEqual([]);
  });

  it('uses canonical IDs and reports missing IDs in mixed batches', async () => {
    getDatabase().prepare('INSERT INTO asset_id_aliases (old_id, asset_id) VALUES (?, ?)')
      .run('legacy-one', 'asset-one');

    const single = await app.inject({
      method: 'POST', url: '/api/assets/legacy-one/tags', payload: { tag: 'single' },
    });
    expect(single.statusCode).toBe(200);
    expect(getAssetById('asset-one')?.tags).toContain('single');

    const batch = await app.inject({
      method: 'POST',
      url: '/api/assets/tags',
      payload: {
        assetIds: ['asset-one', 'missing-one', 'legacy-one'],
        tags: ['shared'],
        action: 'add',
      },
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json()).toMatchObject({
      affectedCount: 1,
      missingAssetIds: ['missing-one'],
      assets: [{ assetId: 'asset-one' }],
    });
    expect(getAssetById('asset-one')?.tags).toContain('shared');
    const orphanCount = getDatabase().prepare(
      'SELECT COUNT(*) AS count FROM tags WHERE asset_id IN (?, ?)'
    ).get('missing-one', 'legacy-one') as { count: number };
    expect(orphanCount.count).toBe(0);

    const remove = await app.inject({
      method: 'POST',
      url: '/api/assets/tags',
      payload: { assetIds: ['legacy-one', 'missing-one'], tags: ['shared'], action: 'remove' },
    });
    expect(remove.statusCode).toBe(200);
    expect(remove.json().missingAssetIds).toEqual(['missing-one']);
    expect(getAssetById('asset-one')?.tags).not.toContain('shared');

    const none = await app.inject({
      method: 'POST',
      url: '/api/assets/tags',
      payload: { assetIds: ['missing-one'], tags: ['unwritten'] },
    });
    expect(none.statusCode).toBe(404);
    expect(none.json().missingAssetIds).toEqual(['missing-one']);
  });

  it('rejects malformed copy bodies before creating a destination', async () => {
    const invalidBodies: { overrides: Record<string, unknown>; error: string }[] = [
      ...(['assetId', 'stackId', 'targetPath', 'targetSubfolder'] as const).flatMap((field) =>
        [null, 4, '', '   '].map((value) => ({
          overrides: { [field]: value },
          error: `${field} must be a non-empty string`,
        }))
      ),
      { overrides: { copyStackAll: null }, error: 'copyStackAll must be a boolean' },
      { overrides: { copyStackAll: 'true' }, error: 'copyStackAll must be a boolean' },
      { overrides: { stackId: 'stack-one' }, error: 'Provide either assetId or stackId, not both' },
      { overrides: { assetId: undefined, stackId: 'stack-one' }, error: 'copyStackAll must be true when copying a stack' },
      { overrides: { assetId: undefined, stackId: 'stack-one', copyStackAll: false }, error: 'copyStackAll must be true when copying a stack' },
      { overrides: { copyStackAll: true }, error: 'copyStackAll requires stackId' },
      { overrides: { assetId: undefined }, error: 'Either assetId or stackId must be provided' },
    ];

    for (const [index, { overrides, error }] of invalidBodies.entries()) {
      const destination = path.join(tempDir, `uncreated-${index}`);
      const response = await app.inject({
        method: 'POST',
        url: '/api/assets/copy',
        payload: { assetId: 'asset-one', targetPath: destination, ...overrides },
      });
      expect(response.statusCode, JSON.stringify(overrides)).toBe(400);
      expect(response.json().error, JSON.stringify(overrides)).toBe(error);
      expect(fs.existsSync(destination), JSON.stringify(overrides)).toBe(false);
    }
  });
});
