import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  closeDatabase,
  getAssetById,
  initDatabase,
  upsertAsset,
} from '../server/src/db/database.js';
import { bpmClassifier } from '../server/src/services/classifiers/bpmClassifier.js';
import { runClassifier } from '../server/src/services/classifiers/engine.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestBpmWavBuffer,
  createTestZipArchive,
} from './helpers.js';

/** Interleave a mono PCM WAV into several channels, placing beats in the last one. */
function wavWithLastChannelOnly(monoWav: Buffer, channelCount: number): Buffer {
  const samples = (monoWav.length - 44) / 2;
  const frameSize = channelCount * 2;
  const wav = Buffer.alloc(44 + samples * frameSize);
  monoWav.copy(wav, 0, 0, 44);
  wav.writeUInt32LE(36 + samples * frameSize, 4);
  wav.writeUInt16LE(channelCount, 22);
  wav.writeUInt32LE(monoWav.readUInt32LE(24) * frameSize, 28);
  wav.writeUInt16LE(frameSize, 32);
  wav.writeUInt32LE(samples * frameSize, 40);
  for (let sample = 0; sample < samples; sample++) {
    wav.writeInt16LE(
      monoWav.readInt16LE(44 + sample * 2),
      44 + sample * frameSize + (channelCount - 1) * 2,
    );
  }
  return wav;
}

describe('BPM classifier accuracy', () => {
  let libraryDir: string;

  beforeEach(() => {
    libraryDir = createTempDir('classifier-accuracy-');
    initDatabase(libraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(libraryDir);
  });

  function addWav(id: string, wav: Buffer, options: { archive?: boolean; duration?: number } = {}): void {
    const name = `${id}.wav`;
    const archivePath = options.archive ? path.join(libraryDir, `${id}.zip`) : undefined;
    const diskPath = archivePath ?? path.join(libraryDir, name);
    if (archivePath) {
      createTestZipArchive(archivePath, [{ name: `audio/${name}`, content: wav }]);
    } else {
      fs.writeFileSync(diskPath, wav);
    }
    upsertAsset({
      id,
      path: archivePath ? `${id}.zip#/audio/${name}` : name,
      absolutePath: diskPath,
      name,
      extension: '.wav',
      category: 'audio',
      size: wav.length,
      mtime: Date.now(),
      hash: id,
      isArchiveEntry: Boolean(archivePath),
      archivePath,
      archiveEntryPath: archivePath ? `audio/${name}` : undefined,
      metadata: options.duration === undefined ? {} : { duration: options.duration },
    });
  }

  async function classify(id: string, settingsOverride: Record<string, number> = {}) {
    return runClassifier(bpmClassifier, {
      targetType: 'asset',
      targetValue: id,
      settingsOverride,
    });
  }

  it.each([
    [90, 22050], [90, 44100], [90, 48000],
    [120, 22050], [120, 44100], [120, 48000],
    [160, 22050], [160, 44100], [160, 48000],
  ])('detects %i BPM at %i Hz', async (expectedBpm, sampleRate) => {
    const id = `beat_${expectedBpm}_${sampleRate}`;
    addWav(id, createTestBpmWavBuffer(expectedBpm, 12, sampleRate));

    const result = await classify(id);

    expect(result.classifiedCount).toBe(1);
    expect(result.details[0].result?.bpm).toBeTypeOf('number');
    expect(Math.abs(Number(result.details[0].result?.bpm) - expectedBpm)).toBeLessThanOrEqual(2);
    expect(getAssetById(id)?.metadata.bpm).toBe(result.details[0].result?.bpm);
  });

  it.each([2, 3])('downmixes all %i channels before finding the beat', async (channels) => {
    const id = `channels_${channels}`;
    const wav = wavWithLastChannelOnly(createTestBpmWavBuffer(120, 12, 48000), channels);
    addWav(id, wav);

    const result = await classify(id);

    expect(result.classifiedCount).toBe(1);
    expect(Math.abs(Number(result.details[0].result?.bpm) - 120)).toBeLessThanOrEqual(2);
  });

  it('detects the original sample rate and tempo inside a ZIP entry', async () => {
    const id = 'zip_beat';
    addWav(id, createTestBpmWavBuffer(120, 12, 48000), { archive: true });

    const result = await classify(id);

    expect(result.classifiedCount).toBe(1);
    expect(Math.abs(Number(result.details[0].result?.bpm) - 120)).toBeLessThanOrEqual(2);
    expect(getAssetById(id)?.metadata.bpm).toBe(result.details[0].result?.bpm);
  });

  it('returns no tempo for silence', async () => {
    const id = 'silence';
    const wav = createTestBpmWavBuffer(120, 12, 22050);
    wav.fill(0, 44);
    addWav(id, wav);

    const result = await classify(id);

    expect(result.classifiedCount).toBe(0);
    expect(result.details[0].success).toBe(false);
    expect(getAssetById(id)?.metadata.bpm).toBeUndefined();
  });

  it('rejects short decoded clips even when indexed duration is missing', async () => {
    const id = 'short';
    addWav(id, createTestBpmWavBuffer(120, 0.5, 22050));

    const result = await classify(id);

    expect(result.classifiedCount).toBe(0);
    expect(result.details[0].error).toContain('shorter than minimum threshold');
  });

  it('applies BPM bounds after measuring the correctly timed signal', async () => {
    const id = 'bounded';
    addWav(id, createTestBpmWavBuffer(120, 12, 48000));

    const result = await classify(id, { minBpm: 130, maxBpm: 180 });

    expect(result.classifiedCount).toBe(0);
    expect(result.details[0].error).toContain('outside configured range');
    expect(getAssetById(id)?.metadata.bpm).toBeUndefined();
  });

  it.each([45, 220])('detects %i BPM when bounds extend past the default span', async (expectedBpm) => {
    const id = `extended_${expectedBpm}`;
    addWav(id, createTestBpmWavBuffer(expectedBpm, 16, 48000));

    const result = await classify(id, { minBpm: 20, maxBpm: 300 });

    expect(result.classifiedCount).toBe(1);
    expect(Math.abs(Number(result.details[0].result?.bpm) - expectedBpm)).toBeLessThanOrEqual(2);
  });

  it('limits analysis to the centered window', async () => {
    const id = 'windowed';
    addWav(id, createTestBpmWavBuffer(120, 14, 22050));

    const result = await classify(id, { maxAnalysisSeconds: 6 });

    expect(result.classifiedCount).toBe(1);
    expect(result.details[0].result?.duration).toBeCloseTo(6, 2);
    expect(Math.abs(Number(result.details[0].result?.bpm) - 120)).toBeLessThanOrEqual(2);
  });
});
