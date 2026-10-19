import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  initDatabase,
  queryAssets,
} from '../server/src/db/database.js';
import { compileFilterExpression } from '../server/src/services/filterParser.js';
import { formatFilterToken } from '../shared/filterSync.js';
import { cleanupTempDir, createTempDir, upsertTaggedAsset } from './helpers.js';

describe('search fallback semantics', () => {
  let tempDir: string;
  const quotedTag = 'Bob\'s "hero"';

  beforeEach(() => {
    tempDir = createTempDir('search-fallback-');
    initDatabase(tempDir);

    const add = (
      id: string,
      name: string,
      extension: '.png' | '.wav',
      tag?: string,
      size = 1,
      metadata: { bpm?: number; width?: number } = {}
    ) => upsertTaggedAsset({
      id,
      path: name,
      absolutePath: `${tempDir}/${name}`,
      name,
      extension,
      category: extension === '.png' ? 'image' : 'audio',
      size,
      mtime: 1,
      hash: id,
      isArchiveEntry: false,
      metadata,
      tags: tag ? [tag] : [],
    });

    add('coin_image', 'coin.png', '.png', 'coin', 1, { width: 64 });
    add('gem_image', 'gem.png', '.png', 'gem');
    add('coin_audio', 'coin.wav', '.wav', 'coin', 1, { bpm: 120 });
    add('quoted_tag', 'hero.png', '.png', quotedTag);
    add('unknown_name', 'mystery:foo.png', '.png');
    add('unsupported_name', 'is:bogus.png', '.png');
    add('width_literal', 'width:abc.png', '.png');
    add('size_literal', 'size:bogus.png', '.png');
    add('zero_size', 'zero.png', '.png', undefined, 0);
    add('percent_literal', 'foo:%.png', '.png');
    add('percent_other', 'foo:bar.png', '.png');
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const ids = (search: string, category?: 'image' | 'audio') =>
    queryAssets({ search, category, isStackedView: false, limit: 100 })
      .items.map((item) => item.id).sort();

  it('searches unknown and unsupported prefixes literally instead of dropping them', () => {
    expect(ids('mystery:foo')).toEqual(['unknown_name']);
    expect(ids('mystery:')).toEqual(['unknown_name']);
    expect(ids('is:bogus')).toEqual(['unsupported_name']);
    expect(ids('width:abc')).toEqual(['width_literal']);
    expect(ids('size:bogus')).toEqual(['size_literal']);
    expect(ids('is:bogus AND tag:coin')).toEqual([]);
    expect(ids('is:bogus OR tag:coin')).toEqual(['coin_audio', 'coin_image', 'unsupported_name']);
  });

  it('escapes SQL wildcard characters in literal free-text fallback', () => {
    const compiled = compileFilterExpression('foo:%', false);
    expect(compiled.sql).toContain("ESCAPE '!'");
    expect(ids('foo:%')).toEqual(['percent_literal']);
    expect(ids('foo:bar')).toEqual(['percent_other']);
  });

  it('keeps escaped labels and nested Boolean predicates scoped to their group', () => {
    const token = formatFilterToken('tag', quotedTag)!;
    expect(ids(`(tag:coin OR ${token}) AND ext:png`))
      .toEqual(['coin_image', 'quoted_tag']);
    expect(ids('(mystery:foo OR tag:coin) AND ext:png'))
      .toEqual(['coin_image', 'unknown_name']);
    expect(ids('NOT (tag:coin OR tag:gem) AND ext:png'))
      .not.toContain('coin_image');
  });

  it('repairs unfinished groups and trailing operators without losing complete filters', () => {
    expect(compileFilterExpression('tag:coin OR', false).isParsed).toBe(false);
    expect(ids('tag:coin OR')).toEqual(['coin_audio', 'coin_image']);
    expect(compileFilterExpression('(tag:coin OR tag:gem', false).isParsed).toBe(false);
    expect(ids('(tag:coin OR tag:gem', 'image')).toEqual(['coin_image', 'gem_image']);

    const typed = compileFilterExpression('bpm:120 unmatched(', false);
    expect(typed.isParsed).toBe(false);
    expect(typed.args).toContain(120);
    expect(ids('bpm:120 unmatched(')).toEqual([]);
  });

  it('treats a known empty field as neutral while typing, but not malformed literals', () => {
    expect(compileFilterExpression('tag:', false)).toMatchObject({ sql: '', isParsed: true });
    expect(ids('tag:', 'image')).toEqual(ids('', 'image'));
    expect(ids('tag:coin AND tag:')).toEqual(['coin_audio', 'coin_image']);

    for (const query of ['tag:"unfinished', 'width:[64 TO 512']) {
      const compiled = compileFilterExpression(query, false);
      expect(compiled.isParsed).toBe(false);
      expect(compiled.sql).not.toBe('');
      expect(ids(query)).toEqual([]);
    }
  });
});
