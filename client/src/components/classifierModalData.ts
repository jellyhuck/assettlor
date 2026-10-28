import type {
  ClassifierInfo,
  ClassifierRunResult,
  ClassifierTargetInventory,
  ClassifierTargetType,
} from '../types';

export type TargetChoice = ClassifierTargetInventory['directories'][number];
export type AssetTargetChoice = ClassifierTargetInventory['assets'][number];
export type { ClassifierTargetInventory } from '../types';

export type LoadState = 'loading' | 'ready' | 'error';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isTargetChoice(value: unknown): value is TargetChoice {
  return isRecord(value) && typeof value.value === 'string' && value.value.length > 0
    && typeof value.label === 'string' && value.label.length > 0;
}

function isAssetTargetChoice(value: unknown): value is AssetTargetChoice {
  return isTargetChoice(value) && isRecord(value) && typeof value.category === 'string'
    && ['image', 'audio', 'model', 'archive', 'other'].includes(value.category);
}

export function parseTargetInventory(value: unknown): ClassifierTargetInventory {
  if (!isRecord(value) || !Array.isArray(value.directories)
    || !Array.isArray(value.archives) || !Array.isArray(value.assets)
    || !value.directories.every(isTargetChoice)
    || !value.archives.every(isTargetChoice)
    || !value.assets.every(isAssetTargetChoice)) {
    throw new Error('The classifier target response was invalid');
  }
  return {
    directories: value.directories,
    archives: value.archives,
    assets: value.assets,
  };
}

export function parseClassifiers(value: unknown): ClassifierInfo[] {
  if (!Array.isArray(value) || !value.every((item) => isRecord(item)
    && typeof item.id === 'string' && item.id.length > 0
    && typeof item.name === 'string' && typeof item.description === 'string'
    && ['audio', 'image', 'archive', 'general'].includes(String(item.category))
    && Array.isArray(item.steps) && item.steps.every((step: unknown) => isRecord(step)
      && typeof step.id === 'string' && typeof step.name === 'string'
      && typeof step.description === 'string')
    && isRecord(item.settings))) {
    throw new Error('The classifier list response was invalid');
  }
  return value as ClassifierInfo[];
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function parseRunResult(value: unknown): ClassifierRunResult {
  if (!isRecord(value) || typeof value.classifierId !== 'string'
    || !['all', 'asset', 'directory', 'archive'].includes(String(value.targetType))
    || !isCount(value.totalTargeted) || !isCount(value.processedCount)
    || !isCount(value.classifiedCount) || !isCount(value.failedCount)
    || (value.noResultCount !== undefined && !isCount(value.noResultCount))
    || (value.errorCount !== undefined && !isCount(value.errorCount))
    || typeof value.elapsedMs !== 'number' || !Number.isFinite(value.elapsedMs)
    || value.elapsedMs < 0 || !Array.isArray(value.details)
    || !value.details.every((item: unknown) => isRecord(item)
      && typeof item.assetId === 'string' && typeof item.assetPath === 'string'
      && typeof item.success === 'boolean'
      && (item.result === undefined || isRecord(item.result))
      && (item.error === undefined || typeof item.error === 'string'))) {
    throw new Error('The classifier run response was invalid');
  }
  return value as unknown as ClassifierRunResult;
}

export function resolveTargetSelection(
  classifier: ClassifierInfo | undefined,
  targetType: ClassifierTargetType,
  targetValue: string,
  inventory: ClassifierTargetInventory | null,
  inventoryLoadState: LoadState,
) {
  if (targetType === 'all') {
    return { options: undefined, choice: undefined, compatible: true, canRun: Boolean(classifier) };
  }
  const options = targetType === 'directory' ? inventory?.directories
    : targetType === 'archive' ? inventory?.archives : inventory?.assets;
  const choice = options?.find((item) => item.value === targetValue);
  const compatible = targetType !== 'asset' || !classifier || !choice
    || classifier.category === 'general'
    || classifier.category === (choice as AssetTargetChoice).category;
  return {
    options,
    choice,
    compatible,
    canRun: Boolean(classifier) && inventoryLoadState === 'ready'
      && Boolean(targetValue && choice) && compatible,
  };
}
