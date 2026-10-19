import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createStack,
  initDatabase,
  queryAssets,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir, upsertTaggedAsset } from './helpers.js';

describe('stack query semantics', () => {
  let tempDir: string;

  const addAudio = (id: string, metadata: { bpm?: number }, tag?: string) => {
    upsertTaggedAsset({
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
      metadata,
      tags: tag ? [tag] : [],
    });
  };

  const addStack = (id: string, members: string[]) => {
    createStack({
      id,
      name: id,
      type: 'audio_variation',
      itemCount: members.length,
      representativeAssetId: members[0],
      assetIdsWithIndex: members.map((assetId, index) => ({ assetId, index })),
    });
  };

  beforeEach(() => {
    tempDir = createTempDir('stack-query-semantics-');
    initDatabase(tempDir);

    // Neither the representative nor a single member satisfies both filters.
    addAudio('combined_rep', { bpm: 70 }, 'other');
    addAudio('combined_tag', { bpm: 75 }, 'target');
    addAudio('combined_bpm', { bpm: 130 }, 'other');
    addStack('combined', ['combined_rep', 'combined_tag', 'combined_bpm']);

    addAudio('tag_only_rep', { bpm: 70 }, 'target');
    addAudio('tag_only_member', { bpm: 75 }, 'other');
    addStack('tag_only', ['tag_only_rep', 'tag_only_member']);

    addAudio('bpm_only_rep', { bpm: 130 }, 'other');
    addAudio('bpm_only_member', { bpm: 135 }, 'other');
    addStack('bpm_only', ['bpm_only_rep', 'bpm_only_member']);

    addAudio('missing_bpm', {}, 'other');
    addAudio('zero_bpm', { bpm: 0 }, 'other');
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const ids = (params: Parameters<typeof queryAssets>[0]) =>
    queryAssets(params).items.map((item) => item.id).sort();

  it('allows separate conjuncts to match different members of one stack', () => {
    expect(ids({ tag: 'target', bpm: 'fast', isStackedView: true }))
      .toEqual(['combined']);
    expect(ids({ search: 'tag:target AND bpm:fast', isStackedView: true }))
      .toEqual(['combined']);
    expect(ids({ tag: 'target', bpm: 'fast', isStackedView: false }))
      .toEqual([]);
    expect(ids({ search: 'tag:target AND bpm:fast', isStackedView: false }))
      .toEqual([]);
  });

  it('keeps each member match within its own stack', () => {
    expect(ids({ search: 'tag:target', isStackedView: true }))
      .toEqual(['combined', 'tag_only']);
    expect(ids({ search: 'bpm:fast', isStackedView: true }))
      .toEqual(['bpm_only', 'combined']);
  });

  it('distinguishes an exact zero from missing BPM metadata', () => {
    expect(ids({ bpm: '0', isStackedView: false })).toEqual(['zero_bpm']);
    expect(ids({ search: 'bpm:0', isStackedView: false })).toEqual(['zero_bpm']);
    expect(ids({ bpm: 'none', isStackedView: false })).toEqual(['missing_bpm', 'zero_bpm']);
    expect(ids({ search: 'bpm:none', isStackedView: false })).toEqual(['missing_bpm', 'zero_bpm']);
  });
});
