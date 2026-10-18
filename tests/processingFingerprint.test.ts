import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { openZipArchive } from '../server/src/services/archive.js';
import { processAudioBuffer } from '../server/src/services/audio.js';
import { processImageBuffer } from '../server/src/services/image.js';
import {
  AUDIO_THUMBNAIL_SPEC,
  DEFAULT_THUMBNAIL_QUALITY,
  fingerprintThumbnailProcessing,
  getProcessingFingerprint,
  IMAGE_THUMBNAIL_SPEC,
  normalizeThumbnailQuality,
} from '../server/src/services/processingFingerprint.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestWavBuffer,
  createTestZipArchive,
} from './helpers.js';
import path from 'path';

async function createDetailedPng(): Promise<Buffer> {
  const pixels = Buffer.alloc(64 * 64 * 3);
  for (let i = 0; i < pixels.length; i++) {
    pixels[i] = (i * 37 + Math.floor(i / 11) * 17) % 256;
  }
  return sharp(pixels, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
}

describe('processing fingerprint', () => {
  it('uses the effective thumbnail quality and distinguishes media pipelines', () => {
    const image80 = getProcessingFingerprint('image', { thumbnailQuality: 80 });
    expect(image80).toBe(getProcessingFingerprint('image', { thumbnailQuality: 80 }));
    expect(image80).not.toBe(getProcessingFingerprint('image', { thumbnailQuality: 90 }));
    expect(image80).not.toBe(getProcessingFingerprint('audio', { thumbnailQuality: 80 }));
    expect(image80).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes for renderer versions and every output option', () => {
    const base = { category: 'image' as const, ...IMAGE_THUMBNAIL_SPEC, quality: 80 };
    const current = fingerprintThumbnailProcessing(base);
    const changes = [
      { rendererVersion: base.rendererVersion + 1 },
      { width: base.width + 1 },
      { height: base.height + 1 },
      { encoder: 'png' },
      { fit: 'fill' },
      { withoutEnlargement: false },
      { quality: 81 },
    ];
    for (const change of changes) {
      expect(fingerprintThumbnailProcessing({ ...base, ...change })).not.toBe(current);
    }
    expect(AUDIO_THUMBNAIL_SPEC.rendererVersion).toBe(5);
  });

  it('validates quality at the fingerprint and media boundaries', async () => {
    expect(normalizeThumbnailQuality()).toBe(DEFAULT_THUMBNAIL_QUALITY);
    expect(() => getProcessingFingerprint('image', { thumbnailQuality: 0 })).toThrow(RangeError);
    expect(() => getProcessingFingerprint('audio', { thumbnailQuality: 101 })).toThrow(RangeError);
    await expect(processImageBuffer(await createDetailedPng(), '.png', 400, 400, 0))
      .rejects.toThrow(RangeError);
  });

  it('passes optional quality into image, audio, and archive thumbnails', async () => {
    const png = await createDetailedPng();
    const lowImage = await processImageBuffer(png, '.png', 400, 400, 15);
    const highImage = await processImageBuffer(png, '.png', 400, 400, 95);
    const defaultImage = await processImageBuffer(png, '.png');
    const explicitDefaultImage = await processImageBuffer(png, '.png', 400, 400, DEFAULT_THUMBNAIL_QUALITY);
    expect(lowImage.thumbnailBuffer.equals(highImage.thumbnailBuffer)).toBe(false);
    expect(defaultImage.thumbnailBuffer.equals(explicitDefaultImage.thumbnailBuffer)).toBe(true);

    const wav = createTestWavBuffer(0.1, 8000);
    const lowAudio = await processAudioBuffer(wav, 'clip.wav', '.wav', 15);
    const highAudio = await processAudioBuffer(wav, 'clip.wav', '.wav', 95);
    expect(lowAudio.thumbnailBuffer.equals(highAudio.thumbnailBuffer)).toBe(false);
    expect(lowAudio.metadata.audioThumbnailVersion).toBe(AUDIO_THUMBNAIL_SPEC.rendererVersion);

    const tempDir = createTempDir('processing-quality-');
    try {
      const zipPath = path.join(tempDir, 'Pack.zip');
      createTestZipArchive(zipPath, [{ name: 'detailed.png', content: png }]);
      const inventory = await openZipArchive(zipPath, 'Pack.zip', 'hash');
      const entry = inventory.entries[0];
      const lowArchive = await inventory.processEntry(entry, { quality: 15 });
      const highArchive = await inventory.processEntry(entry, { quality: 95 });
      expect(lowArchive.thumbnailBuffer.equals(highArchive.thumbnailBuffer)).toBe(false);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
