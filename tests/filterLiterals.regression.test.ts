import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { preprocessSearchQuery } from '../server/src/services/filterParser.js';
import { formatFilterToken, parseFiltersFromQuery, updateSearchFilter } from '../shared/filterSync.js';
import { cleanupTempDir, createTempDir, upsertTaggedAsset } from './helpers.js';

describe('literal search labels', () => {
  let tempDir: string;
  const labels = [
    'a  b',
    '100%_star*',
    'Bob\'s "hero"',
    String.raw`C:\Sprites`,
    'ext:.png dur:5m',
    'Retro (Pack)',
    'Étoile',
    '魔法素材',
    'OR',
    'none',
    'retro*',
    'retrosomething',
    'RetroPack',
    'RetroPack Deluxe',
    'foo_%*',
    'fooXYother',
  ];

  beforeEach(() => {
    tempDir = createTempDir('filter-literals-');
    initDatabase(tempDir);
    for (const [index, label] of labels.entries()) {
      for (const kind of ['tag', 'pack'] as const) {
        const id = `${kind}_${index}`;
        const isTag = kind === 'tag';
        upsertTaggedAsset({
          id,
          path: `${id}.${isTag ? 'png' : 'wav'}`,
          absolutePath: `${tempDir}/${id}.${isTag ? 'png' : 'wav'}`,
          name: `${id}.${isTag ? 'png' : 'wav'}`,
          extension: isTag ? '.png' : '.wav',
          category: isTag ? 'image' : 'audio',
          size: 1,
          mtime: 1,
          hash: id,
          isArchiveEntry: false,
          metadata: isTag ? {} : { pack: label },
          tags: isTag ? [label] : [],
        });
      }
    }
    upsertAsset({
      id: 'pack_missing', path: 'pack_missing.wav',
      absolutePath: `${tempDir}/pack_missing.wav`, name: 'pack_missing.wav',
      extension: '.wav', category: 'audio', size: 1, mtime: 1,
      hash: 'pack_missing', isArchiveEntry: false,
    });
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const ids = (params: Parameters<typeof queryAssets>[0]) =>
    queryAssets({ ...params, isStackedView: false }).items.map((item) => item.id).sort();

  it('round-trips quoted tag labels through edit, parse, and exact query', () => {
    for (const [index, label] of labels.entries()) {
      const token = formatFilterToken('tag', label)!;
      const edited = updateSearchFilter('width:[64 TO 512]', 'tag', label);
      expect(edited).toBe(`width:[64 TO 512] ${token}`);
      expect(parseFiltersFromQuery(edited).tag).toBe(token.includes('"') ? label : label.toLowerCase());
      expect(ids({ category: 'image', search: token })).toEqual([`tag_${index}`]);
      expect(ids({ category: 'image', tag: label })).toEqual([`tag_${index}`]);
    }
  });

  it('treats formatted pack labels as exact, including SQL wildcard characters', () => {
    for (const [index, label] of labels.entries()) {
      const token = formatFilterToken('pack', label)!;
      expect(ids({ category: 'audio', search: token })).toEqual([`pack_${index}`]);
      if (!label.includes('*') && label !== 'none') {
        expect(ids({ category: 'audio', pack: label })).toEqual([`pack_${index}`]);
      }
    }
  });

  it('reserves unquoted pack * for wildcard matching and escapes % and _', () => {
    const retroIds = ids({ category: 'audio', search: 'pack:retro*' });
    expect(retroIds).toEqual(labels.flatMap((label, index) =>
      label.toLowerCase().startsWith('retro') ? [`pack_${index}`] : []).sort());
    expect(ids({ category: 'audio', search: 'pack:foo_%*' }))
      .toEqual([`pack_${labels.indexOf('foo_%*')}`]);
    expect(ids({ category: 'audio', search: 'pack:none' })).toEqual(['pack_missing']);
    expect(ids({ category: 'audio', search: 'pack:"none"' }))
      .toEqual([`pack_${labels.indexOf('none')}`]);
  });

  it('preprocesses shorthand only outside quoted values', () => {
    expect(preprocessSearchQuery('tag:"ext:.png dur:5m a  b" dur:5m ext:.png'))
      .toBe('tag:"ext:.png dur:5m a  b" dur:300 ext:png');
    expect(preprocessSearchQuery('tag:"Bob\\"s #hero" #sprite:character'))
      .toBe('tag:"Bob\\"s #hero" tag:"sprite:character"');
  });
});
