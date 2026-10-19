import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  addAssetTags,
  closeDatabase,
  createStack,
  getDatabase,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('queryAssets page tag hydration', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('query-hydration-');
    initDatabase(tempDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const addAsset = (id: string, tags: { tag: string; source: string }[]) => {
    upsertAsset({
      id,
      path: `${id}.wav`,
      absolutePath: `/${id}.wav`,
      name: `${id}.wav`,
      extension: '.wav',
      category: 'audio',
      size: 1,
      mtime: 1,
      hash: id,
      isArchiveEntry: false,
    });
    addAssetTags(id, tags);
  };

  it('loads all flat page tags with a bounded number of statements', () => {
    for (let index = 0; index < 200; index++) {
      addAsset(`flat_${String(index).padStart(3, '0')}`, [
        { tag: `tag-${index}`, source: 'user' },
        { tag: `tag-${index}`, source: 'import' },
      ]);
    }

    const prepare = vi.spyOn(getDatabase(), 'prepare');
    const result = queryAssets({ isStackedView: false, limit: 200 });

    expect(result.items).toHaveLength(200);
    expect(prepare).toHaveBeenCalledTimes(5);
    for (let index = 0; index < 200; index++) {
      const id = `flat_${String(index).padStart(3, '0')}`;
      const asset = result.items.find((item) => item.id === id);
      expect(asset?.tags).toEqual([`tag-${index}`]);
    }
  });

  it('loads representative and union tags for 200 stacks in bounded statements', () => {
    for (let index = 0; index < 200; index++) {
      const repId = `stack_${String(index).padStart(3, '0')}_rep`;
      const memberId = `stack_${String(index).padStart(3, '0')}_member`;
      addAsset(repId, [
        { tag: `rep-${index}`, source: 'user' },
        { tag: `shared-${index}`, source: 'import' },
      ]);
      addAsset(memberId, [
        { tag: `member-${index}`, source: 'user' },
        { tag: `shared-${index}`, source: 'import' },
      ]);
      createStack({
        id: `stack_${String(index).padStart(3, '0')}`,
        name: `Stack ${index}`,
        type: 'audio_variation',
        itemCount: 2,
        representativeAssetId: repId,
        assetIdsWithIndex: [
          { assetId: repId, index: 0 },
          { assetId: memberId, index: 1 },
        ],
      });
    }

    const prepare = vi.spyOn(getDatabase(), 'prepare');
    const result = queryAssets({ isStackedView: true, limit: 200 });

    expect(result.items).toHaveLength(200);
    expect(prepare).toHaveBeenCalledTimes(6);
    for (let index = 0; index < 200; index++) {
      const stack = result.items.find((item) => item.id === `stack_${String(index).padStart(3, '0')}`);
      expect(stack?.tags).toEqual(expect.arrayContaining([
        `rep-${index}`, `member-${index}`, `shared-${index}`,
      ]));
      expect(stack?.tags).toHaveLength(3);
      expect('isStack' in (stack || {})).toBe(true);
      if (stack && 'isStack' in stack) {
        expect(stack.representativeAsset?.id).toBe(`stack_${String(index).padStart(3, '0')}_rep`);
        expect(stack.representativeAsset?.tags).toEqual(expect.arrayContaining([
          `rep-${index}`, `shared-${index}`,
        ]));
        expect(stack.representativeAsset?.tags).toHaveLength(2);
      }
    }
  });
});
