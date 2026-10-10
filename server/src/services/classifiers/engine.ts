import fs from 'fs';
import path from 'path';
import type {
  Asset,
  ClassifierRunResult,
  ClassifierAssetResult,
} from '../../../../shared/types.js';
import {
  Classifier,
  RunClassifierOptions,
} from './types.js';
import {
  findAssetsByScope,
  getCurrentLibraryPath,
} from '../../db/database.js';
import { getZipEntryBuffer } from '../archive.js';
import { getEffectiveClassifierSettings } from './registry.js';
import { validateClassifierSettings } from './settings.js';
import { validateClassifierScope } from './scope.js';

export class ClassifierCancelledError extends Error {
  constructor() {
    super('Classifier run cancelled');
    this.name = 'ClassifierCancelledError';
  }
}

export async function loadAssetBuffer(asset: Asset): Promise<Buffer | null> {
  const libraryPath = getCurrentLibraryPath();

  if (asset.isArchiveEntry && asset.archiveEntryPath) {
    let archiveDisk = asset.archivePath || asset.absolutePath;
    if (archiveDisk && !path.isAbsolute(archiveDisk) && libraryPath) {
      archiveDisk = path.resolve(libraryPath, archiveDisk);
    }
    if (archiveDisk && fs.existsSync(archiveDisk)) {
      return getZipEntryBuffer(archiveDisk, asset.archiveEntryPath);
    }
    return null;
  }

  let filePath = asset.absolutePath;
  if (!path.isAbsolute(filePath) && libraryPath) {
    filePath = path.resolve(libraryPath, filePath);
  }

  if (filePath && fs.existsSync(filePath)) {
    try {
      return await fs.promises.readFile(filePath);
    } catch {
      return null;
    }
  }

  return null;
}

export async function runClassifier(
  classifier: Classifier,
  options: RunClassifierOptions
): Promise<ClassifierRunResult> {
  const throwIfCancelled = (): void => {
    if (options.shouldCancel?.()) throw new ClassifierCancelledError();
  };

  throwIfCancelled();
  const startTime = Date.now();
  const target = validateClassifierScope(options);
  const effectiveSettings = validateClassifierSettings(
    classifier,
    getEffectiveClassifierSettings(classifier),
    options.settingsOverride || {}
  );

  // Find target assets based on scope
  const targetCategory = classifier.category === 'general' ? undefined : classifier.category;
  const assets = findAssetsByScope({
    ...target,
    category: targetCategory,
  });
  throwIfCancelled();

  const totalTargeted = assets.length;
  const results: ClassifierAssetResult[] = [];

  for (let i = 0; i < assets.length; i++) {
    throwIfCancelled();
    const asset = assets[i];
    const intermediate = classifier.createIntermediateState(asset, effectiveSettings);

    try {
      const buffer = classifier.requiresBuffer === false ? null : await loadAssetBuffer(asset);
      throwIfCancelled();
      if (classifier.requiresBuffer === true && !buffer) {
        throw new Error('Asset data could not be loaded');
      }
      const context = {
        asset,
        buffer,
        settings: effectiveSettings,
        intermediate,
      };

      for (let s = 0; s < classifier.steps.length; s++) {
        throwIfCancelled();
        const step = classifier.steps[s];

        if (options.onProgress) {
          options.onProgress({
            processedCount: i,
            totalTargeted,
            currentAsset: asset.path,
            stepIndex: s + 1,
            totalSteps: classifier.steps.length,
            stepName: step.name,
          });
        }
        throwIfCancelled();

        const continueExecution = await step.execute(context);
        throwIfCancelled();
        if (continueExecution === false || (intermediate as any).skipped) {
          break;
        }
      }

      throwIfCancelled();
      if ((intermediate as { error?: string }).error) {
        throw new Error((intermediate as { error: string }).error);
      }
      const assetResult = classifier.createAssetResult(asset, intermediate, effectiveSettings);
      assetResult.outcome ??= assetResult.success ? 'classified' : 'no-result';
      if (classifier.finalizeAsset && !classifier.finalizeAsset(asset, intermediate, effectiveSettings, assetResult)) {
        throw new Error('Asset changed while classification was running');
      }
      results.push(assetResult);
    } catch (err: unknown) {
      if (err instanceof ClassifierCancelledError) throw err;
      results.push({
        assetId: asset.id,
        assetPath: asset.path,
        success: false,
        error: err instanceof Error ? err.message : 'Unexpected classifier error',
        retryable: true,
        outcome: 'error',
        stale: true,
      });
    }
  }

  throwIfCancelled();
  const classifiedCount = results.filter((r) => r.outcome === 'classified').length;
  const failedCount = results.length - classifiedCount;
  const noResultCount = results.filter((r) => r.outcome === 'no-result').length;
  const errorCount = results.filter((r) => r.outcome === 'error').length;

  return {
    classifierId: classifier.id,
    targetType: target.targetType,
    targetValue: target.targetValue,
    totalTargeted,
    processedCount: results.length,
    classifiedCount,
    failedCount,
    noResultCount,
    errorCount,
    details: results,
    elapsedMs: Date.now() - startTime,
  };
}
