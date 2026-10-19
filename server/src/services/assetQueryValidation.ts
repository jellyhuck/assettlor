import type { AssetQueryParams } from '../../../shared/types.js';

export interface AssetQueryValidationDetails {
  field: string;
  reason: string;
}

export type NormalizedAssetQuery = AssetQueryParams & { page: number; limit: number };

type ValidationResult =
  | { ok: true; value: NormalizedAssetQuery }
  | { ok: false; error: string; details: AssetQueryValidationDetails };

export class AssetQueryValidationError extends Error {
  readonly details: AssetQueryValidationDetails;

  constructor(error: string, details: AssetQueryValidationDetails) {
    super(error);
    this.name = 'AssetQueryValidationError';
    this.details = details;
  }
}

const STRING_FILTERS = [
  'category', 'tag', 'format', 'resolution', 'bpm', 'sprite', 'pack', 'folder',
  'width', 'height', 'duration', 'search', 'stackType',
] as const;

const SORT_FIELDS = new Set([
  'name', 'size', 'mtime', 'resolution', 'duration', 'bpm', 'width', 'height',
]);

function invalid(field: string, reason: string): ValidationResult {
  return {
    ok: false,
    error: `Invalid asset query: ${field} ${reason}`,
    details: { field, reason },
  };
}

function parsePositiveInteger(value: unknown, field: string, fallback: number): number | ValidationResult {
  if (value === undefined) return fallback;

  // HTTP query values are strings; direct database callers may pass numbers.
  // Reject numeric coercions such as Infinity, decimals, blank strings, arrays,
  // and objects before they reach SQLite's LIMIT/OFFSET bindings.
  const parsed = typeof value === 'string' && /^\d+$/u.test(value.trim())
    ? Number(value.trim())
    : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed) || parsed < 1) {
    return invalid(field, 'must be a finite positive integer');
  }
  return parsed;
}

/**
 * Normalize HTTP and direct query inputs with the same paging policy.
 * `isStackedView` accepts booleans or the HTTP strings `true` and `false`.
 * Valid integer limits above 200 are capped at 200.
 */
export function normalizeAssetQuery(value: unknown): ValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid('query', 'must be an object');
  }

  const input = value as Record<string, unknown>;
  const normalized: AssetQueryParams = {};

  for (const field of STRING_FILTERS) {
    const fieldValue = input[field];
    if (fieldValue === undefined) continue;
    if (typeof fieldValue !== 'string') {
      return invalid(field, 'must be a single string');
    }
    normalized[field] = fieldValue;
  }

  if (input.sortBy !== undefined) {
    if (typeof input.sortBy !== 'string' || !SORT_FIELDS.has(input.sortBy)) {
      return invalid('sortBy', 'must be a supported sort field');
    }
    normalized.sortBy = input.sortBy as AssetQueryParams['sortBy'];
  }

  if (input.sortOrder !== undefined) {
    if (input.sortOrder !== 'asc' && input.sortOrder !== 'desc') {
      return invalid('sortOrder', 'must be asc or desc');
    }
    normalized.sortOrder = input.sortOrder;
  }

  if (input.isStackedView !== undefined) {
    const stacked = input.isStackedView;
    if (stacked !== true && stacked !== false && stacked !== 'true' && stacked !== 'false') {
      return invalid('isStackedView', 'must be true or false');
    }
    normalized.isStackedView = stacked === true || stacked === 'true';
  }

  const page = parsePositiveInteger(input.page, 'page', 1);
  if (typeof page !== 'number') return page;
  const requestedLimit = parsePositiveInteger(input.limit, 'limit', 60);
  if (typeof requestedLimit !== 'number') return requestedLimit;
  const limit = Math.min(requestedLimit, 200);
  if ((page - 1) * limit > Number.MAX_SAFE_INTEGER) {
    return invalid('page', 'is too large for the selected limit');
  }

  return { ok: true, value: { ...normalized, page, limit } };
}

export function requireAssetQuery(value: unknown): NormalizedAssetQuery {
  const result = normalizeAssetQuery(value);
  if (!result.ok) {
    throw new AssetQueryValidationError(result.error, result.details);
  }
  return result.value;
}
