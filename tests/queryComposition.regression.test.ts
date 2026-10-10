import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createStack,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('query predicate composition', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('query-composition-');
    initDatabase(tempDir);

    const addAsset = (
      id: string,
      category: 'audio' | 'image',
      metadata: { bpm?: number; tempoDescription?: string },
      tag: string
    ) => upsertAsset({
      id,
      path: `${id}.${category === 'audio' ? 'wav' : 'png'}`,
      absolutePath: `/${id}.${category === 'audio' ? 'wav' : 'png'}`,
      name: `${id}.${category === 'audio' ? 'wav' : 'png'}`,
      extension: category === 'audio' ? '.wav' : '.png',
      category,
      size: 1,
      mtime: 1,
      hash: id,
      isArchiveEntry: false,
      metadata,
      tags: [{ tag, source: 'folder' }],
    });

    addAsset('image_fast', 'image', { tempoDescription: 'fast-tempo' }, 'target');
    addAsset('audio_slow', 'audio', { bpm: 70, tempoDescription: 'slow-tempo' }, 'target');
    addAsset('audio_fast', 'audio', { tempoDescription: 'fast-tempo' }, 'other');
    addAsset('stack_a_rep', 'audio', { bpm: 70, tempoDescription: 'slow-tempo' }, 'target');
    addAsset('stack_a_member', 'audio', { bpm: 75, tempoDescription: 'slow-tempo' }, 'target');
    addAsset('stack_b_rep', 'audio', { bpm: 70, tempoDescription: 'slow-tempo' }, 'other');
    addAsset('stack_b_member', 'audio', { tempoDescription: 'fast-tempo' }, 'other');

    for (const letter of ['a', 'b']) {
      createStack({
        id: `stack_${letter}`,
        name: `Stack ${letter}`,
        type: 'audio_variation',
        itemCount: 2,
        representativeAssetId: `stack_${letter}_rep`,
        assetIdsWithIndex: [
          { assetId: `stack_${letter}_rep`, index: 0 },
          { assetId: `stack_${letter}_member`, index: 1 },
        ],
      });
    }
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const ids = (params: Parameters<typeof queryAssets>[0]) =>
    queryAssets(params).items.map((item) => item.id).sort();

  it('keeps tempo-label OR branches inside category and tag filters in flat view', () => {
    expect(ids({ category: 'audio', bpm: 'fast', isStackedView: false }))
      .toEqual(['audio_fast', 'stack_b_member']);
    expect(ids({ category: 'audio', tag: 'target', bpm: 'fast', isStackedView: false }))
      .toEqual([]);
    expect(ids({ category: 'audio', search: 'bpm:fast AND tag:target', isStackedView: false }))
      .toEqual([]);
  });

  it('keeps member matches correlated to their own stack', () => {
    expect(ids({ category: 'audio', bpm: 'fast', isStackedView: true }))
      .toEqual(['audio_fast', 'stack_b']);
    expect(ids({ category: 'audio', tag: 'target', bpm: 'fast', isStackedView: true }))
      .toEqual([]);
    expect(ids({ search: 'cat:audio AND bpm:fast', isStackedView: true }))
      .toEqual(['audio_fast', 'stack_b']);
  });

  it('respects negation and grouped Boolean search around member predicates', () => {
    expect(ids({ search: 'cat:audio AND NOT bpm:fast', isStackedView: true }))
      .toEqual(['audio_slow', 'stack_a']);
    expect(ids({ search: 'cat:audio AND (bpm:fast OR tag:target)', isStackedView: true }))
      .toEqual(['audio_fast', 'audio_slow', 'stack_a', 'stack_b']);
  });
});
