import type { CopyAssetRequest } from '../../../shared/types.js';

type ValidationResult =
  | { ok: true; value: CopyAssetRequest }
  | { ok: false; error: string };

export function parseCopyRequest(value: unknown): ValidationResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'Body must be an object' };
  }

  const body = value as Record<string, unknown>;
  for (const field of ['assetId', 'stackId', 'targetPath', 'targetSubfolder']) {
    const fieldValue = body[field];
    if (fieldValue !== undefined &&
        (typeof fieldValue !== 'string' || fieldValue.trim().length === 0)) {
      return { ok: false, error: `${field} must be a non-empty string` };
    }
  }
  if (body.copyStackAll !== undefined && typeof body.copyStackAll !== 'boolean') {
    return { ok: false, error: 'copyStackAll must be a boolean' };
  }

  const assetId = body.assetId as string | undefined;
  const stackId = body.stackId as string | undefined;
  if (assetId && stackId) {
    return { ok: false, error: 'Provide either assetId or stackId, not both' };
  }
  if (!assetId && !stackId) {
    return { ok: false, error: 'Either assetId or stackId must be provided' };
  }
  if (stackId && body.copyStackAll !== true) {
    return { ok: false, error: 'copyStackAll must be true when copying a stack' };
  }
  if (assetId && body.copyStackAll === true) {
    return { ok: false, error: 'copyStackAll requires stackId' };
  }

  return {
    ok: true,
    value: {
      assetId,
      stackId,
      targetPath: body.targetPath as string | undefined,
      targetSubfolder: body.targetSubfolder as string | undefined,
      copyStackAll: body.copyStackAll as boolean | undefined,
    },
  };
}
