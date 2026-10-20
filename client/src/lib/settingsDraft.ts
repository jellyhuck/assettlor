import type { AppSettings, BpmClassifierSettings, PackClassifierSettings,
  SpriteClassifierSettings } from '../../../shared/types.js';

/** Compare user-entered paths without changing the spelling sent to the server. */
export function directoryKey(value: string): string {
  const slashPath = value.trim().replace(/\\/g, '/');
  const drive = /^[A-Za-z]:/.exec(slashPath)?.[0].toLowerCase() ?? '';
  const absolute = slashPath.startsWith('/') || Boolean(drive);
  const parts: string[] = [];
  for (const part of slashPath.replace(/^[A-Za-z]:/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `${drive}${absolute ? '/' : ''}${parts.join('/')}`.replace(/\/$/, '') || '/';
}

/** Reads library names by path from a settings response; absent means none. */
export function parseLibraryNames(value: unknown): Record<string, string[]> {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || !Object.values(value).every((names) => Array.isArray(names)
      && names.every((name) => typeof name === 'string'))) {
    throw new Error('The settings response has invalid library names');
  }
  return value as Record<string, string[]>;
}

function validPathList(paths: string[], label: string): string[] {
  const errors: string[] = [];
  const keys = new Set<string>();
  for (const path of paths) {
    if (!path.trim()) {
      errors.push(`${label} paths cannot be empty`);
      continue;
    }
    const key = directoryKey(path);
    if (keys.has(key)) errors.push(`${label} contains the same directory more than once`);
    keys.add(key);
  }
  return errors;
}

export function validateSettingsDraft(
  app: AppSettings,
  bpm: BpmClassifierSettings,
  sprite: SpriteClassifierSettings,
  pack: PackClassifierSettings,
): string[] {
  const errors = [
    ...validPathList(app.libraryPaths, 'Libraries'),
    ...validPathList(app.projectPaths, 'Projects'),
  ];
  if (!Number.isInteger(app.thumbnailQuality) || app.thumbnailQuality < 1 || app.thumbnailQuality > 100) {
    errors.push('Thumbnail quality must be an integer from 1 to 100');
  }
  if (!Number.isInteger(app.defaultFps) || app.defaultFps < 1 || app.defaultFps > 60) {
    errors.push('Default FPS must be an integer from 1 to 60');
  }
  for (const [label, value] of [
    ['Minimum BPM', bpm.minBpm], ['Maximum BPM', bpm.maxBpm],
    ['Minimum duration', bpm.minDurationSeconds], ['Maximum analysis window', bpm.maxAnalysisSeconds],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) errors.push(`${label} must be a positive finite number`);
  }
  if (Number.isFinite(bpm.minBpm) && Number.isFinite(bpm.maxBpm) && bpm.minBpm > bpm.maxBpm) {
    errors.push('Minimum BPM cannot exceed maximum BPM');
  }
  if (!Number.isFinite(sprite.minConfidence) || sprite.minConfidence < 0 || sprite.minConfidence > 1) {
    errors.push('Sprite confidence must be between 0 and 1');
  }
  if (!Number.isInteger(pack.directoryDepth) || pack.directoryDepth < 1 || pack.directoryDepth > 64) {
    errors.push('Directory depth must be an integer from 1 to 64');
  }
  return errors;
}
