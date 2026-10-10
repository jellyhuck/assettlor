import path from 'path';

export type ValidatedClassifierScope =
  | { targetType: 'all'; targetValue?: undefined }
  | { targetType: 'asset'; targetValue: string | string[] }
  | { targetType: 'directory' | 'archive'; targetValue: string };

export class InvalidClassifierScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClassifierScopeError';
  }
}

export function normalizeClassifierPath(value: string): string {
  return path.posix.normalize(value.replace(/\\/g, '/'));
}

export function isAbsoluteClassifierPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function validateClassifierScope(scope: {
  targetType: unknown;
  targetValue?: unknown;
}): ValidatedClassifierScope {
  const { targetType, targetValue } = scope;
  if (targetType === 'all') {
    if (targetValue !== undefined) {
      throw new InvalidClassifierScopeError('An all-assets target must not include targetValue');
    }
    return { targetType: 'all' };
  }

  if (targetType === 'asset') {
    if (typeof targetValue === 'string' && targetValue.trim()) {
      return { targetType, targetValue: targetValue.trim() };
    }
    if (Array.isArray(targetValue) && targetValue.length > 0 &&
        targetValue.every((value) => typeof value === 'string' && value.trim())) {
      return { targetType, targetValue: [...new Set(targetValue.map((value: string) => value.trim()))] };
    }
    throw new InvalidClassifierScopeError('An asset target requires a nonempty asset ID or ID array');
  }

  if (targetType === 'directory' || targetType === 'archive') {
    if (typeof targetValue !== 'string' || !targetValue.trim()) {
      throw new InvalidClassifierScopeError(`A ${targetType} target requires a nonempty path`);
    }
    const normalized = normalizeClassifierPath(targetValue.trim());
    if (normalized === '.' || normalized === '/' || /^[A-Za-z]:\/$/.test(normalized) ||
        (targetType === 'archive' && targetValue.trim().endsWith('/'))) {
      throw new InvalidClassifierScopeError(`A ${targetType} target requires a nonempty path`);
    }
    return { targetType, targetValue: normalized };
  }

  throw new InvalidClassifierScopeError(
    `Invalid targetType: "${String(targetType)}". Must be one of: all, asset, directory, archive`,
  );
}
