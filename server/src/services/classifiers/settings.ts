import type { Classifier } from './types.js';

export class ClassifierSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClassifierSettingsError';
  }
}

const booleanKeys: Record<string, string[]> = {
  bpm: ['enabled', 'applyBpmTag', 'applyTempoTag'],
  sprite: ['enabled', 'applySpriteTag', 'enableVisualAnalysis', 'enablePathAnalysis', 'enableStackAnalysis'],
  pack: ['enabled', 'inferFromArchive', 'inferFromDirectory', 'cleanSeparators',
    'stripVersionSuffix', 'stripAffixes', 'applyTag'],
};

const numberKeys: Record<string, string[]> = {
  bpm: ['minBpm', 'maxBpm', 'minDurationSeconds', 'maxAnalysisSeconds'],
  sprite: ['minConfidence'],
  pack: ['directoryDepth'],
};

const stringKeys: Record<string, string[]> = {
  bpm: ['tempoTagPrefix'],
  sprite: ['spriteTagPrefix'],
  pack: ['tagPrefix', 'directoryStrategy', 'caseConvention'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Validate a patch against the complete effective settings before saving or running. */
export function validateClassifierSettings(
  classifier: Classifier,
  current: Record<string, unknown>,
  patch: unknown
): Record<string, unknown> {
  if (!isRecord(patch)) {
    throw new ClassifierSettingsError('Settings must be a JSON object');
  }
  const id = classifier.id;
  if (!booleanKeys[id]) {
    // Third-party classifiers retain their own settings contract.
    return { ...current, ...patch };
  }
  const allowed = new Set([
    ...booleanKeys[id], ...numberKeys[id], ...stringKeys[id],
    ...(id === 'pack' ? ['targetArchives', 'targetDirectories'] : []),
  ]);
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.has(key)) {
      throw new ClassifierSettingsError(`Unknown ${id} setting: ${key}`);
    }
    if (booleanKeys[id].includes(key) && typeof value !== 'boolean') {
      throw new ClassifierSettingsError(`${key} must be a boolean`);
    }
    if (numberKeys[id].includes(key) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ClassifierSettingsError(`${key} must be a finite number`);
    }
    if (stringKeys[id].includes(key) && (typeof value !== 'string' || value.length > 200 || /[\x00-\x1f\x7f]/.test(value))) {
      throw new ClassifierSettingsError(`${key} must be a literal string of at most 200 characters`);
    }
    if (key === 'targetArchives' || key === 'targetDirectories') {
      if (!Array.isArray(value) || value.some((entry) =>
        typeof entry !== 'string' || !entry.trim() || entry.length > 4096 || /[\x00-\x1f\x7f]/.test(entry))) {
        throw new ClassifierSettingsError(`${key} must be an array of nonempty literal paths`);
      }
    }
  }
  const settings = { ...current, ...patch };
  if (id === 'bpm') {
    for (const key of numberKeys.bpm) {
      if (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] <= 0) {
        throw new ClassifierSettingsError(`${key} must be a positive finite number`);
      }
    }
    if ((settings.minBpm as number) > (settings.maxBpm as number)) {
      throw new ClassifierSettingsError('minBpm must not exceed maxBpm');
    }
  } else if (id === 'sprite') {
    if (typeof settings.minConfidence !== 'number' || !Number.isFinite(settings.minConfidence) ||
        settings.minConfidence < 0 || settings.minConfidence > 1) {
      throw new ClassifierSettingsError('minConfidence must be between 0 and 1');
    }
  } else if (id === 'pack') {
    if (!Number.isInteger(settings.directoryDepth) ||
        (settings.directoryDepth as number) < 1 || (settings.directoryDepth as number) > 64) {
      throw new ClassifierSettingsError('directoryDepth must be an integer between 1 and 64');
    }
    if (!['top', 'enclosing', 'pattern'].includes(settings.directoryStrategy as string)) {
      throw new ClassifierSettingsError('directoryStrategy must be top, enclosing, or pattern');
    }
    if (!['as-is', 'title', 'lower', 'upper'].includes(settings.caseConvention as string)) {
      throw new ClassifierSettingsError('caseConvention must be as-is, title, lower, or upper');
    }
  }
  return settings;
}
