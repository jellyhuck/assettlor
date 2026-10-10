import fs from 'node:fs';
import path from 'node:path';
import * as mm from 'music-metadata';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAssetByPath, initDatabase } from '../server/src/db/database.js';
import { processAudioBuffer, processAudioFile } from '../server/src/services/audio.js';
import { AUDIO_THUMBNAIL_SPEC } from '../server/src/services/processingFingerprint.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import { cleanupTempDir, createTempDir, createTestWavBuffer } from './helpers.js';

vi.mock('music-metadata', async (importOriginal) => {
  const actual = await importOriginal<typeof import('music-metadata')>();
  return {
    ...actual,
    parseFile: vi.fn(actual.parseFile),
    parseBuffer: vi.fn(actual.parseBuffer),
  };
});

describe('audio placeholder provenance', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('audio-placeholder-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('classifies malformed, truncated, partial, and complete metadata on disk and in memory', async () => {
    const wav = createTestWavBuffer(0.1, 8000);
    const cases = [
      { name: 'garbage.wav', bytes: Buffer.from('NOT A VALID AUDIO FILE'), status: 'failed' },
      { name: 'truncated.wav', bytes: wav.subarray(0, 30), status: 'failed' },
      { name: 'metadata-only.wav', bytes: wav.subarray(0, 36), status: 'partial' },
      { name: 'complete.wav', bytes: wav, status: 'complete' },
    ] as const;

    for (const fixture of cases) {
      const filePath = path.join(tempDir, fixture.name);
      fs.writeFileSync(filePath, fixture.bytes);
      const fromBuffer = await processAudioBuffer(fixture.bytes, fixture.name, '.wav');
      const fromDisk = await processAudioFile(filePath);

      for (const result of [fromBuffer, fromDisk]) {
        expect(result.metadata.audioThumbnailVersion).toBe(AUDIO_THUMBNAIL_SPEC.rendererVersion);
        expect(result.metadata.audioMetadataStatus).toBe(fixture.status);
        expect((await sharp(result.thumbnailBuffer).metadata()).format).toBe('webp');
        if (fixture.status === 'failed') {
          expect(result.metadata.audioMetadataError).toMatch(/.+/);
        } else {
          expect(result.metadata.audioMetadataError).toBeUndefined();
        }
      }
      expect(fromDisk.metadata).toEqual(fromBuffer.metadata);
      expect(fromDisk.thumbnailBuffer.equals(fromBuffer.thumbnailBuffer)).toBe(true);
    }
  });

  it('preserves a parser-reported zero duration as complete metadata', async () => {
    vi.mocked(mm.parseBuffer).mockResolvedValueOnce({
      format: { duration: 0, sampleRate: 8000, numberOfChannels: 1 },
      common: {},
    } as Awaited<ReturnType<typeof mm.parseBuffer>>);

    const result = await processAudioBuffer(Buffer.alloc(0), 'empty.wav', '.wav');
    expect(result.metadata).toMatchObject({
      duration: 0,
      sampleRate: 8000,
      audioMetadataStatus: 'complete',
      audioThumbnailVersion: AUDIO_THUMBNAIL_SPEC.rendererVersion,
    });
    expect(result.metadata.audioMetadataError).toBeUndefined();
  });

  it('retains parser errors while still generating a versioned placeholder', async () => {
    vi.mocked(mm.parseBuffer).mockRejectedValueOnce(new Error('truncated audio header'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = await processAudioBuffer(Buffer.alloc(0), 'broken.wav', '.wav');
      expect(result.metadata).toMatchObject({
        audioThumbnailVersion: AUDIO_THUMBNAIL_SPEC.rendererVersion,
        audioMetadataStatus: 'failed',
        audioMetadataError: 'truncated audio header',
      });
      expect(result.thumbnailBuffer.length).toBeGreaterThan(0);
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it('reuses a failed-metadata placeholder on an unchanged scan', async () => {
    initDatabase(tempDir);
    fs.writeFileSync(path.join(tempDir, 'broken.wav'), Buffer.from('NOT A VALID AUDIO FILE'));
    vi.mocked(mm.parseFile).mockClear();

    const first = await scanLibrary(tempDir);
    expect(first.status).toBe('completed');
    expect(first.indexedCount).toBe(1);
    expect(mm.parseFile).toHaveBeenCalledTimes(1);
    const indexed = getAssetByPath('broken.wav');
    expect(indexed?.metadata).toMatchObject({
      audioThumbnailVersion: AUDIO_THUMBNAIL_SPEC.rendererVersion,
      audioMetadataStatus: 'failed',
    });
    expect(indexed?.metadata.audioMetadataError).toMatch(/.+/);
    const thumbnailUrl = indexed?.thumbnailUrl;

    const second = await scanLibrary(tempDir);
    expect(second.status).toBe('completed');
    expect(second.indexedCount).toBe(0);
    expect(mm.parseFile).toHaveBeenCalledTimes(1);
    expect(getAssetByPath('broken.wav')?.thumbnailUrl).toBe(thumbnailUrl);
  });
});
