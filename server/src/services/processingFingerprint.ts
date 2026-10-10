import crypto from 'crypto';
import type { AppSettings } from '../../../shared/types.js';

export const DEFAULT_THUMBNAIL_QUALITY = 85;

// Bump rendererVersion when output or extracted metadata changes in a way that
// cannot be described by the dimensions, encoder, resize policy, or quality.
export const IMAGE_THUMBNAIL_SPEC = Object.freeze({
  rendererVersion: 4,
  width: 400,
  height: 400,
  encoder: 'webp',
  fit: 'inside',
  withoutEnlargement: true,
});

export const AUDIO_THUMBNAIL_SPEC = Object.freeze({
  rendererVersion: 4,
  width: 400,
  height: 240,
  encoder: 'webp',
  fit: 'none',
  withoutEnlargement: false,
});

export type ThumbnailCategory = 'image' | 'audio';

export interface ThumbnailProcessingSpec {
  category: ThumbnailCategory;
  rendererVersion: number;
  width: number;
  height: number;
  encoder: string;
  fit: string;
  withoutEnlargement: boolean;
  quality: number;
}

export function normalizeThumbnailQuality(quality = DEFAULT_THUMBNAIL_QUALITY): number {
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new RangeError('Thumbnail quality must be an integer from 1 to 100');
  }
  return quality;
}

/** Stable fingerprint of every thumbnail option and the renderer version. */
export function fingerprintThumbnailProcessing(spec: ThumbnailProcessingSpec): string {
  const quality = normalizeThumbnailQuality(spec.quality);
  const serialized = JSON.stringify([
    spec.category,
    spec.rendererVersion,
    spec.width,
    spec.height,
    spec.encoder,
    spec.fit,
    spec.withoutEnlargement,
    quality,
  ]);
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/** Use the effective settings read for this scan, not the YAML default. */
export function getProcessingFingerprint(
  category: ThumbnailCategory,
  settings: Pick<AppSettings, 'thumbnailQuality'>
): string {
  const base = category === 'image' ? IMAGE_THUMBNAIL_SPEC : AUDIO_THUMBNAIL_SPEC;
  return fingerprintThumbnailProcessing({
    category,
    ...base,
    quality: settings.thumbnailQuality,
  });
}

/** Decoder/metadata revision without thumbnail-only quality settings. */
export function getMetadataProcessingVersion(category: ThumbnailCategory): string {
  const spec = category === 'image' ? IMAGE_THUMBNAIL_SPEC : AUDIO_THUMBNAIL_SPEC;
  return `${category}:${spec.rendererVersion}`;
}
