import { describe, expect, it } from 'vitest';
import type { ClassifierInfo } from '../shared/types.js';
import {
  parseClassifiers,
  parseRunResult,
  parseTargetInventory,
  resolveTargetSelection,
} from '../client/src/components/classifierModalData.js';
import { readJson } from '../client/src/lib/requestLifecycle.js';

const audioClassifier: ClassifierInfo = {
  id: 'bpm',
  name: 'BPM',
  description: 'Detects music tempo',
  category: 'audio',
  steps: [{ id: 'decode', name: 'Decode', description: 'Read audio' }],
  settings: {},
};

describe('classifier modal target data', () => {
  it('keeps every catalog target and distinct archive identities', () => {
    const inventory = parseTargetInventory({
      directories: [
        { value: 'Library A/music', label: 'Library A/music' },
        { value: 'Library A/music/deep', label: 'Library A/music/deep' },
        { value: 'Library B/music', label: 'Library B/music' },
      ],
      archives: [
        { value: '/Library A/pack.zip', label: 'Library A/pack.zip' },
        { value: '/Library B/pack.zip', label: 'Library B/pack.zip' },
      ],
      assets: Array.from({ length: 251 }, (_, index) => ({
        value: `asset-${index}`,
        label: `Library A/music/deep/track-${index}.wav`,
        category: 'audio',
      })),
    });

    expect(inventory.assets).toHaveLength(251);
    expect(resolveTargetSelection(audioClassifier, 'asset', 'asset-250', inventory, 'ready').canRun).toBe(true);
    expect(resolveTargetSelection(audioClassifier, 'directory', 'Library A/music/deep', inventory, 'ready').canRun).toBe(true);
    expect(resolveTargetSelection(audioClassifier, 'archive', '/Library B/pack.zip', inventory, 'ready').choice)
      .toEqual({ value: '/Library B/pack.zip', label: 'Library B/pack.zip' });
  });

  it('requires an indexed target and a compatible asset category', () => {
    const inventory = parseTargetInventory({
      directories: [],
      archives: [],
      assets: [{ value: 'sprite-1', label: 'sprites/hero.png', category: 'image' }],
    });

    expect(resolveTargetSelection(audioClassifier, 'asset', 'sprite-1', inventory, 'ready'))
      .toMatchObject({ compatible: false, canRun: false });
    expect(resolveTargetSelection(audioClassifier, 'asset', 'missing', inventory, 'ready').canRun).toBe(false);
    expect(resolveTargetSelection(audioClassifier, 'asset', 'sprite-1', inventory, 'loading').canRun).toBe(false);
    expect(resolveTargetSelection(audioClassifier, 'directory', '', inventory, 'ready').canRun).toBe(false);
    expect(resolveTargetSelection(audioClassifier, 'all', '', null, 'loading').canRun).toBe(true);
    expect(resolveTargetSelection({ ...audioClassifier, category: 'general' }, 'asset', 'sprite-1', inventory, 'ready').canRun)
      .toBe(true);
  });

  it('rejects malformed inventory, classifier, and run responses', () => {
    expect(() => parseTargetInventory({ directories: [], archives: [], assets: [{ value: 'x', label: 'X' }] }))
      .toThrow('target response was invalid');
    expect(() => parseClassifiers([{ ...audioClassifier, steps: 'decode' }]))
      .toThrow('list response was invalid');
    expect(() => parseRunResult({ classifierId: 'bpm', details: 'not an array' }))
      .toThrow('run response was invalid');
    expect(() => parseRunResult({
      classifierId: 'bpm', targetType: 'all', totalTargeted: 1, processedCount: 1,
      classifiedCount: 0, failedCount: 1, noResultCount: 0, errorCount: 'one',
      elapsedMs: 12, details: [{ assetId: 'x', assetPath: 'x.wav', success: false }],
    })).toThrow('run response was invalid');
  });

  it('surfaces HTTP and invalid JSON responses', async () => {
    await expect(readJson(Response.json({ error: 'Catalog unavailable' }, { status: 503 })))
      .rejects.toThrow('Catalog unavailable');
    await expect(readJson(new Response('not json', { status: 200 })))
      .rejects.toThrow('invalid JSON response');
    await expect(readJson(new Response('not json', { status: 502 })))
      .rejects.toThrow('HTTP 502');
  });
});
