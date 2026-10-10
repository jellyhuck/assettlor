import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  createStack,
  initDatabase,
  queryAssets,
  upsertAsset,
} from '../server/src/db/database.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('BPM query semantics', () => {
  let tempDir: string;

  const addAudio = (id: string, metadata: { bpm?: number; tempoDescription?: string }) => {
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
      metadata,
    });
  };

  beforeEach(() => {
    tempDir = createTempDir('bpm-query-');
    initDatabase(tempDir);
    for (const bpm of [79, 80, 89, 90, 119, 120, 149, 150, 160, 161]) {
      addAudio(`bpm_${bpm}`, {
        bpm,
        ...(bpm === 79 ? { tempoDescription: 'fast-tempo' } : {}),
        ...(bpm === 150 ? { tempoDescription: 'slow-tempo' } : {}),
      });
    }
    addAudio('bpm_null', {});
    addAudio('bpm_zero', { bpm: 0, tempoDescription: 'fast-tempo' });
    addAudio('bpm_legacy_fast', { tempoDescription: 'fast-tempo' });
    addAudio('bpm_decimal', { bpm: 120.4 });
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  const directIds = (bpm: string, isStackedView = false) =>
    queryAssets({ bpm, isStackedView }).items.map((item) => item.id).sort();
  const searchIds = (bpm: string, isStackedView = false) =>
    queryAssets({ search: `bpm:${bpm}`, isStackedView }).items.map((item) => item.id).sort();

  it.each([
    ['slow', ['bpm_79']],
    ['moderate', ['bpm_80', 'bpm_89', 'bpm_90', 'bpm_119']],
    ['fast', ['bpm_120', 'bpm_149', 'bpm_legacy_fast', 'bpm_decimal']],
    ['high', ['bpm_150', 'bpm_160', 'bpm_161']],
    ['high-tempo', ['bpm_150', 'bpm_160', 'bpm_161']],
    ['very-fast', ['bpm_150', 'bpm_160', 'bpm_161']],
    ['uptempo', ['bpm_150', 'bpm_160', 'bpm_161']],
  ] as [string, string[]][])('uses classifier boundaries for %s', (bucket, expected) => {
    expect(directIds(bucket)).toEqual(expected.sort());
    expect(searchIds(bucket)).toEqual(expected);
  });

  it.each([
    ['<80', ['bpm_79', 'bpm_zero']],
    ['<90', ['bpm_79', 'bpm_80', 'bpm_89', 'bpm_zero']],
    ['>150', ['bpm_160', 'bpm_161']],
    ['>160', ['bpm_161']],
    ['80-120', ['bpm_80', 'bpm_89', 'bpm_90', 'bpm_119', 'bpm_120']],
    ['120-160', ['bpm_120', 'bpm_149', 'bpm_150', 'bpm_160', 'bpm_decimal']],
    ['120', ['bpm_120']],
    ['120.4', ['bpm_decimal']],
  ] as [string, string[]][])('keeps numeric BPM %s literal', (expression, expected) => {
    expect(directIds(expression)).toEqual(expected.sort());
    expect(searchIds(expression)).toEqual(expected);
  });

  it('treats null and zero BPM as lacking a numeric classification', () => {
    expect(directIds('none')).toEqual(['bpm_legacy_fast', 'bpm_null', 'bpm_zero']);
    expect(searchIds('none')).toEqual(directIds('none'));
    expect(directIds('any')).not.toContain('bpm_null');
    expect(directIds('any')).not.toContain('bpm_zero');
    expect(directIds('fast')).toContain('bpm_legacy_fast');
    expect(directIds('fast')).not.toContain('bpm_zero');
  });

  it('uses the same member boundary rules for direct and search filters', () => {
    addAudio('stack_80_rep', { bpm: 79 });
    addAudio('stack_80_member', { bpm: 80 });
    addAudio('stack_150_rep', { bpm: 149 });
    addAudio('stack_150_member', { bpm: 150 });
    for (const boundary of [80, 150]) {
      createStack({
        id: `stack_${boundary}`,
        name: `Stack ${boundary}`,
        type: 'audio_variation',
        itemCount: 2,
        representativeAssetId: `stack_${boundary}_rep`,
        assetIdsWithIndex: [
          { assetId: `stack_${boundary}_rep`, index: 0 },
          { assetId: `stack_${boundary}_member`, index: 1 },
        ],
      });
    }

    for (const expression of ['slow', 'moderate', 'fast', 'high', '<80', '>150']) {
      expect(searchIds(expression, true)).toEqual(directIds(expression, true));
    }
    expect(directIds('moderate', true)).toContain('stack_80');
    expect(directIds('high', true)).toContain('stack_150');
    expect(directIds('>150', true)).not.toContain('stack_150');
  });
});
