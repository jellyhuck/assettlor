import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import path from 'path';
import { buildServer } from '../server/src/index.js';
import { resetConfigForTesting } from '../server/src/config.js';
import { closeDatabase, initDatabase } from '../server/src/db/database.js';
import {
  AssetQueryValidationError,
  normalizeAssetQuery,
  requireAssetQuery,
} from '../server/src/services/assetQueryValidation.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('asset query normalization', () => {
  it('defaults paging, accepts HTTP strings and direct numbers, and caps limits at 200', () => {
    expect(normalizeAssetQuery({})).toEqual({
      ok: true,
      value: { page: 1, limit: 60 },
    });
    expect(normalizeAssetQuery({ page: '2', limit: '201', isStackedView: 'false' })).toEqual({
      ok: true,
      value: { page: 2, limit: 200, isStackedView: false },
    });
    expect(normalizeAssetQuery({ page: 3, limit: 4, isStackedView: true })).toEqual({
      ok: true,
      value: { page: 3, limit: 4, isStackedView: true },
    });
  });

  it.each([
    ['page', '1.5'],
    ['page', 'Infinity'],
    ['page', ''],
    ['page', '0'],
    ['page', -1],
    ['page', Number.POSITIVE_INFINITY],
    ['page', Number.MAX_SAFE_INTEGER + 1],
    ['limit', '2.5'],
    ['limit', 'NaN'],
    ['limit', 0],
    ['limit', Number.NaN],
    ['limit', ['2', '3']],
  ])('rejects invalid %s value %j', (field, value) => {
    const result = normalizeAssetQuery({ [field]: value });
    expect(result).toMatchObject({
      ok: false,
      details: { field },
    });
    expect(() => requireAssetQuery({ [field]: value })).toThrow(AssetQueryValidationError);
  });

  it.each([
    ['category', ['image', 'audio']],
    ['tag', { value: 'hero' }],
    ['format', 1],
    ['resolution', ['64x64']],
    ['bpm', true],
    ['sprite', null],
    ['pack', {}],
    ['width', 64],
    ['height', ['64']],
    ['duration', false],
    ['search', ['hero', 'coin']],
    ['stackType', 42],
    ['sortBy', ['name', 'size']],
    ['sortOrder', 'up'],
    ['isStackedView', 'yes'],
  ])('rejects a non-scalar or unsupported %s value', (field, value) => {
    expect(normalizeAssetQuery({ [field]: value })).toMatchObject({
      ok: false,
      details: { field },
    });
  });

  it('rejects an unsafe page offset and an invalid top-level shape', () => {
    expect(normalizeAssetQuery({ page: Number.MAX_SAFE_INTEGER, limit: 200 }))
      .toMatchObject({ ok: false, details: { field: 'page' } });
    expect(normalizeAssetQuery([]))
      .toMatchObject({ ok: false, details: { field: 'query' } });
  });
});

describe('GET /api/assets query validation', () => {
  let app: FastifyInstance;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = createTempDir('asset-query-validation-');
    resetConfigForTesting();
    initDatabase(tempDir);
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

  it.each([
    ['/api/assets?page=1.5', 'page'],
    ['/api/assets?page=Infinity', 'page'],
    ['/api/assets?limit=2.5', 'limit'],
    ['/api/assets?limit=0', 'limit'],
    ['/api/assets?format=.png&format=.jpg', 'format'],
    ['/api/assets?resolution=64x64&resolution=128x128', 'resolution'],
    ['/api/assets?search=hero&search=coin', 'search'],
    ['/api/assets?isStackedView=true&isStackedView=false', 'isStackedView'],
  ])('returns a structured 400 for %s', async (url, field) => {
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: expect.any(String),
      details: { field, reason: expect.any(String) },
    });
  });

  it('uses the normalized page and capped limit in the response', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/assets?page=2&limit=201&isStackedView=false',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ page: 2, limit: 200, total: 0 });
  });
});
