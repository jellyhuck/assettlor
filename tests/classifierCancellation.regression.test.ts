import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Asset } from '../shared/types.js';
import { initDatabase, upsertAsset } from '../server/src/db/database.js';
import {
  ClassifierCancelledError,
  runClassifier,
} from '../server/src/services/classifiers/engine.js';
import type { Classifier, ClassifierStep } from '../server/src/services/classifiers/types.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('classifier cancellation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('classifier-cancellation-');
    initDatabase(path.join(tempDir, 'data'));
    for (const name of ['alpha', 'beta']) {
      upsertAsset({
        id: name,
        path: `${name}.png`,
        absolutePath: path.join(tempDir, `${name}.png`),
        name: `${name}.png`,
        extension: '.png',
        category: 'image',
        size: 1,
        mtime: 1,
        hash: name,
        isArchiveEntry: false,
      });
    }
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  function classifier(
    steps: ClassifierStep[],
    onResult: (asset: Asset) => void = () => {}
  ): Classifier {
    return {
      id: 'cancellation-test',
      name: 'Cancellation test',
      description: 'Exercises the classifier run lifecycle.',
      category: 'general',
      defaultSettings: {},
      steps,
      createIntermediateState: () => ({}),
      createAssetResult: (asset) => {
        onResult(asset);
        return { assetId: asset.id, assetPath: asset.path, success: true };
      },
    };
  }

  it('stops before an asset step when progress requests cancellation', async () => {
    let cancelled = false;
    const executed: string[] = [];
    const finalized: string[] = [];
    const testClassifier = classifier([{ id: 'one', name: 'One', description: '', execute: ({ asset }) => {
      executed.push(asset.id);
    } }], (asset) => finalized.push(asset.id));

    await expect(runClassifier(testClassifier, {
      targetType: 'all',
      shouldCancel: () => cancelled,
      onProgress: () => { cancelled = true; },
    })).rejects.toBeInstanceOf(ClassifierCancelledError);
    expect(executed).toEqual([]);
    expect(finalized).toEqual([]);
  });

  it('stops between steps without finalizing the current asset', async () => {
    let cancelled = false;
    const executed: string[] = [];
    const finalized: string[] = [];
    const testClassifier = classifier([
      { id: 'one', name: 'One', description: '', execute: () => {
        executed.push('one');
        cancelled = true;
      } },
      { id: 'two', name: 'Two', description: '', execute: () => { executed.push('two'); } },
    ], (asset) => finalized.push(asset.id));

    await expect(runClassifier(testClassifier, {
      targetType: 'all',
      shouldCancel: () => cancelled,
    })).rejects.toBeInstanceOf(ClassifierCancelledError);
    expect(executed).toEqual(['one']);
    expect(finalized).toEqual([]);
  });

  it('stops between assets after completing the first asset', async () => {
    let cancelled = false;
    const executed: string[] = [];
    const finalized: string[] = [];
    const testClassifier = classifier([{ id: 'one', name: 'One', description: '', execute: ({ asset }) => {
      executed.push(asset.id);
    } }], (asset) => {
      finalized.push(asset.id);
      cancelled = true;
    });

    await expect(runClassifier(testClassifier, {
      targetType: 'all',
      shouldCancel: () => cancelled,
    })).rejects.toBeInstanceOf(ClassifierCancelledError);
    expect(executed).toEqual(['alpha']);
    expect(finalized).toEqual(['alpha']);
  });

  it('keeps the existing result contract without a cancellation predicate', async () => {
    const testClassifier = classifier([{ id: 'one', name: 'One', description: '', execute: () => {} }]);

    const result = await runClassifier(testClassifier, { targetType: 'all' });
    expect(result.totalTargeted).toBe(2);
    expect(result.processedCount).toBe(2);
    expect(result.classifiedCount).toBe(2);
  });
});
