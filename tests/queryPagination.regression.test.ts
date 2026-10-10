import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createStack,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { AssetQueryValidationError } from '../server/src/services/assetQueryValidation.js';
import type { AssetQueryParams } from '../shared/types.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('asset query pagination', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('query-pagination-');
    initDatabase(tempDir);

    for (let index = 0; index < 12; index++) {
      const id = `asset_${String(index).padStart(2, '0')}`;
      upsertAsset({
        id,
        path: `${id}.wav`,
        absolutePath: `${tempDir}/${id}.wav`,
        name: 'same.wav',
        extension: '.wav',
        category: 'audio',
        size: 10,
        mtime: 10,
        hash: id,
        isArchiveEntry: false,
        metadata: { bpm: 120, duration: 5 },
      });
    }

    createStack({
      id: 'stack_a', name: 'same.wav', type: 'audio_variation', itemCount: 2,
      representativeAssetId: 'asset_02',
      assetIdsWithIndex: [
        { assetId: 'asset_02', index: 0 },
        { assetId: 'asset_03', index: 1 },
      ],
    });
    createStack({
      id: 'stack_b', name: 'same.wav', type: 'audio_variation', itemCount: 2,
      representativeAssetId: 'asset_10',
      assetIdsWithIndex: [
        { assetId: 'asset_10', index: 0 },
        { assetId: 'asset_11', index: 1 },
      ],
    });
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  function traverse(params: AssetQueryParams): string[] {
    const first = queryAssets({ ...params, page: 1, limit: 5 });
    const ids = first.items.map((item) => item.id);
    for (let page = 2; page <= first.totalPages; page++) {
      ids.push(...queryAssets({ ...params, page, limit: 5 }).items.map((item) => item.id));
    }
    expect(ids).toHaveLength(first.total);
    expect(new Set(ids).size).toBe(first.total);
    return ids;
  }

  it.each(['name', 'size', 'mtime', 'bpm', 'duration'] as const)(
    'uses asset IDs to break %s ties in flat and stacked traversal',
    (sortBy) => {
      const flat = Array.from({ length: 12 }, (_, index) => `asset_${String(index).padStart(2, '0')}`);
      const stacked = flat.filter((id) => id !== 'asset_03' && id !== 'asset_11')
        .map((id) => id === 'asset_02' ? 'stack_a' : id === 'asset_10' ? 'stack_b' : id);

      expect(traverse({ sortBy, isStackedView: false })).toEqual(flat);
      expect(traverse({ sortBy, isStackedView: true })).toEqual(stacked);
      expect(traverse({ sortBy, sortOrder: 'desc', isStackedView: false })).toEqual(flat);
    }
  );

  it('validates paging and filter shapes for direct database callers', () => {
    for (const invalid of [
      { page: 1.5 },
      { page: Number.POSITIVE_INFINITY },
      { limit: 2.5 },
      { page: Number.MAX_SAFE_INTEGER, limit: 200 },
      { tag: ['hero', 'coin'] },
    ]) {
      expect(() => queryAssets(invalid as AssetQueryParams)).toThrow(AssetQueryValidationError);
    }
  });
});
