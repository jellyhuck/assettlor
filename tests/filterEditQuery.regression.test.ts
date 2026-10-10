import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { parseFiltersFromQuery, updateSearchFilter } from '../shared/filterSync.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('sidebar edits through real asset queries', () => {
  let tempDir: string;

  const addImage = (id: string, extension: string, width: number, tags: string[]) => {
    upsertAsset({
      id,
      path: `coin_${id}${extension}`,
      absolutePath: `/coin_${id}${extension}`,
      name: `coin_${id}${extension}`,
      extension,
      category: 'image',
      size: 1,
      mtime: 1,
      hash: id,
      isArchiveEntry: false,
      metadata: { width, height: 128 },
      tags: tags.map((tag) => ({ tag, source: 'user' })),
    });
  };

  beforeEach(() => {
    tempDir = createTempDir('filter-edit-query-');
    initDatabase(tempDir);
    addImage('png_small', '.png', 128, ['coin', 'rarity']);
    addImage('png_large', '.png', 600, ['coin']);
    addImage('jpg_small', '.jpg', 128, ['coin']);
    addImage('webp_small', '.webp', 128, ['coin', 'rarity']);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const ids = (search: string) => queryAssets({ search, isStackedView: false })
    .items.map((item) => item.id).sort();

  it('removes a complete range without changing the remaining search', () => {
    const original = 'width:[64 TO 512] tag:coin';
    expect(parseFiltersFromQuery(original).width).toBe('[64 to 512]');
    expect(ids(original)).toEqual(['jpg_small', 'png_small', 'webp_small']);

    const edited = updateSearchFilter(original, 'width', null);
    expect(edited).toBe('tag:coin');
    expect(ids(edited)).toEqual(['jpg_small', 'png_large', 'png_small', 'webp_small']);
  });

  it('keeps an OR group intact while adding a conjunctive sidebar choice', () => {
    const original = '(ext:png OR ext:jpg) coin';
    expect(parseFiltersFromQuery(original).format).toBeNull();
    expect(ids(original)).toEqual(['jpg_small', 'png_large', 'png_small']);
    expect(updateSearchFilter(original, 'format', null)).toBe(original);

    const edited = updateSearchFilter(original, 'tag', 'rarity');
    expect(edited).toBe('((ext:png OR ext:jpg) coin) AND tag:rarity');
    expect(ids(edited)).toEqual(['png_small']);
  });
});
