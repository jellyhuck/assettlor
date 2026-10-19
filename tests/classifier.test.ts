import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  initDatabase,
  closeDatabase,
  upsertAsset,
  getAssetById,
  findAssetsByScope,
  updateAssetMetadata,
  getClassifierSettings,
  updateClassifierSettings,
} from '../server/src/db/database.js';
import {
  bpmClassifier,
  getTempoDescription,
  DEFAULT_BPM_SETTINGS,
} from '../server/src/services/classifiers/bpmClassifier.js';
import {
  getAllClassifiers,
  getClassifier,
  getClassifierInfo,
  saveClassifierSettings,
  getEffectiveClassifierSettings,
} from '../server/src/services/classifiers/registry.js';
import {
  runClassifier,
  loadAssetBuffer,
} from '../server/src/services/classifiers/engine.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestBpmWavBuffer,
  createTestWavBuffer,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

describe('Classifier Subsystem & BPM Classifier', () => {
  let tempLibraryDir: string;

  beforeEach(() => {
    tempLibraryDir = createTempDir('classifier-test-');
    initDatabase(tempLibraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempLibraryDir);
  });

  describe('BPM Classifier Unit Tests', () => {
    it('should calculate tempo description correctly across tempo brackets', () => {
      expect(getTempoDescription(60)).toBe('slow-tempo');
      expect(getTempoDescription(79)).toBe('slow-tempo');
      expect(getTempoDescription(80)).toBe('moderate-tempo');
      expect(getTempoDescription(110)).toBe('moderate-tempo');
      expect(getTempoDescription(120)).toBe('fast-tempo');
      expect(getTempoDescription(140)).toBe('fast-tempo');
      expect(getTempoDescription(155)).toBe('uptempo');
    });

    it('should have 4 defined pipeline steps', () => {
      expect(bpmClassifier.id).toBe('bpm');
      expect(bpmClassifier.steps.length).toBe(4);
      expect(bpmClassifier.steps.map((s) => s.id)).toEqual([
        'probe-audio',
        'decode-pcm',
        'analyze-tempo',
        'persist-metadata',
      ]);
    });
  });

  describe('Classifier Registry & Settings Persistence', () => {
    it('should list registered classifiers and retrieve BPM classifier', () => {
      const classifiers = getAllClassifiers();
      expect(classifiers.length).toBeGreaterThanOrEqual(1);

      const bpm = getClassifier('bpm');
      expect(bpm).toBeDefined();
      expect(bpm?.name).toBe('BPM & Tempo Classifier');

      const info = getClassifierInfo(bpm!);
      expect(info.id).toBe('bpm');
      expect(info.steps.length).toBe(4);
      expect(info.settings.minBpm).toBe(DEFAULT_BPM_SETTINGS.minBpm);
    });

    it('should persist and retrieve customized classifier settings in database', () => {
      const customSettings = {
        minBpm: 75,
        maxBpm: 180,
      };

      saveClassifierSettings('bpm', customSettings);

      const rawPersisted = getClassifierSettings('bpm');
      expect(rawPersisted).toBeDefined();
      expect(rawPersisted?.minBpm).toBe(75);

      const effective = getEffectiveClassifierSettings(bpmClassifier);
      expect(effective.minBpm).toBe(75);
      expect(effective.maxBpm).toBe(180);
      // default should be preserved if not overridden
      expect(effective.minDurationSeconds).toBe(DEFAULT_BPM_SETTINGS.minDurationSeconds);
    });
  });

  describe('Database Scope Queries & Asset Updates', () => {
    beforeEach(() => {
      // Seed assets in database
      const audio1 = path.join(tempLibraryDir, 'music', 'track1.wav');
      fs.mkdirSync(path.dirname(audio1), { recursive: true });
      fs.writeFileSync(audio1, createTestWavBuffer(1, 8000));

      upsertAsset({
        id: 'asset_audio_1',
        path: 'music/track1.wav',
        absolutePath: audio1,
        name: 'track1.wav',
        extension: '.wav',
        category: 'audio',
        size: 1000,
        mtime: 100,
        hash: 'h1',
        isArchiveEntry: false,
        metadata: { duration: 1.0 },
      });

      const audio2 = path.join(tempLibraryDir, 'sfx', 'click.wav');
      fs.mkdirSync(path.dirname(audio2), { recursive: true });
      fs.writeFileSync(audio2, createTestWavBuffer(0.2, 8000));

      upsertAsset({
        id: 'asset_audio_2',
        path: 'sfx/click.wav',
        absolutePath: audio2,
        name: 'click.wav',
        extension: '.wav',
        category: 'audio',
        size: 500,
        mtime: 200,
        hash: 'h2',
        isArchiveEntry: false,
        metadata: { duration: 0.2 },
      });

      const image1 = path.join(tempLibraryDir, 'sprites', 'hero.png');
      fs.mkdirSync(path.dirname(image1), { recursive: true });
      fs.writeFileSync(image1, TINY_PNG_BUFFER);

      upsertAsset({
        id: 'asset_img_1',
        path: 'sprites/hero.png',
        absolutePath: image1,
        name: 'hero.png',
        extension: '.png',
        category: 'image',
        size: TINY_PNG_BUFFER.length,
        mtime: 300,
        hash: 'h3',
        isArchiveEntry: false,
      });
    });

    it('findAssetsByScope should filter by targetType: asset', () => {
      const results = findAssetsByScope({
        targetType: 'asset',
        targetValue: 'asset_audio_1',
      });
      expect(results.length).toBe(1);
      expect(results[0].id).toBe('asset_audio_1');
    });

    it('findAssetsByScope should filter by targetType: directory', () => {
      const musicResults = findAssetsByScope({
        targetType: 'directory',
        targetValue: 'music',
      });
      expect(musicResults.length).toBe(1);
      expect(musicResults[0].name).toBe('track1.wav');

      const sfxResults = findAssetsByScope({
        targetType: 'directory',
        targetValue: 'sfx',
      });
      expect(sfxResults.length).toBe(1);
      expect(sfxResults[0].name).toBe('click.wav');
    });

    it('findAssetsByScope should filter by category when targetType is all', () => {
      const audioResults = findAssetsByScope({
        targetType: 'all',
        category: 'audio',
      });
      expect(audioResults.length).toBe(2);
      expect(audioResults.every((a) => a.category === 'audio')).toBe(true);
    });

    it('updateAssetMetadata should merge into existing metadata', () => {
      const updated = updateAssetMetadata('asset_audio_1', { bpm: 128, tempoDescription: 'fast-tempo' });
      expect(updated).toBeDefined();
      expect(updated?.metadata.bpm).toBe(128);
      expect(updated?.metadata.tempoDescription).toBe('fast-tempo');
      expect(updated?.metadata.duration).toBe(1.0); // Preserved previous metadata!
    });
  });

  describe('Multi-Step Classifier Pipeline Execution', () => {
    it('should detect BPM on rhythmic music track without assigning tags', async () => {
      const rhythmicWav = createTestBpmWavBuffer(120, 5, 22050);
      const filePath = path.join(tempLibraryDir, 'dance_loop.wav');
      fs.writeFileSync(filePath, rhythmicWav);

      upsertAsset({
        id: 'asset_dance',
        path: 'music/dance_loop.wav',
        absolutePath: filePath,
        name: 'dance_loop.wav',
        extension: '.wav',
        category: 'audio',
        size: rhythmicWav.length,
        mtime: Date.now(),
        hash: 'h_dance',
        isArchiveEntry: false,
        metadata: { duration: 5.0, sampleRate: 22050 },
      });

      const runResult = await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_dance',
      });

      expect(runResult.totalTargeted).toBe(1);
      expect(runResult.processedCount).toBe(1);
      expect(runResult.classifiedCount).toBe(1);
      expect(runResult.failedCount).toBe(0);

      const detail = runResult.details[0];
      expect(detail.success).toBe(true);
      expect(detail.result?.bpm).toBe(120);
      expect(detail.result?.tempoDescription).toBe('fast-tempo');

      // Verify database updated: metadata saved, no tags assigned
      const updated = getAssetById('asset_dance');
      expect(updated?.metadata.bpm).toBe(120);
      expect(updated?.metadata.tempoDescription).toBe('fast-tempo');
      expect(updated?.tags).toEqual([]);
    });

    it('should not modify or overwrite thumbnails when detecting BPM', async () => {
      const rhythmicWav = createTestBpmWavBuffer(120, 5, 22050);
      const filePath = path.join(tempLibraryDir, 'thumb_test.wav');
      fs.writeFileSync(filePath, rhythmicWav);

      const thumbPath = path.join(tempLibraryDir, '.assettlor', 'thumbnails', 'thumb_test.webp');
      fs.mkdirSync(path.dirname(thumbPath), { recursive: true });
      const initialThumbData = Buffer.from('TEST_DEDICATED_THUMBNAIL_BYTES');
      fs.writeFileSync(thumbPath, initialThumbData);

      upsertAsset({
        id: 'asset_thumb_test',
        path: 'music/thumb_test.wav',
        absolutePath: filePath,
        name: 'thumb_test.wav',
        extension: '.wav',
        category: 'audio',
        size: rhythmicWav.length,
        mtime: Date.now(),
        hash: 'h_thumb_test',
        isArchiveEntry: false,
        thumbnailPath: thumbPath,
        metadata: { duration: 5.0, sampleRate: 22050 },
      });

      await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_thumb_test',
      });

      // Verify thumbnail was not modified or overwritten
      const thumbAfter = fs.readFileSync(thumbPath);
      expect(thumbAfter.equals(initialThumbData)).toBe(true);
    });

    it('should skip audio under minDurationSeconds threshold', async () => {
      const shortWav = createTestWavBuffer(0.3, 8000);
      const filePath = path.join(tempLibraryDir, 'tiny_click.wav');
      fs.writeFileSync(filePath, shortWav);

      upsertAsset({
        id: 'asset_short',
        path: 'tiny_click.wav',
        absolutePath: filePath,
        name: 'tiny_click.wav',
        extension: '.wav',
        category: 'audio',
        size: shortWav.length,
        mtime: Date.now(),
        hash: 'h_short',
        isArchiveEntry: false,
        metadata: { duration: 0.3 },
      });

      const runResult = await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_short',
        settingsOverride: { minDurationSeconds: 1.0 },
      });

      expect(runResult.classifiedCount).toBe(0);
      expect(runResult.details[0].success).toBe(false);
      expect(runResult.details[0].error).toContain('shorter than minimum threshold');
    });

    it('should handle non-rhythmic audio gracefully without crashing', async () => {
      // Pure constant sine wave has no rhythmic beat peaks
      const sineWav = createTestWavBuffer(2.0, 11025);
      const filePath = path.join(tempLibraryDir, 'drone.wav');
      fs.writeFileSync(filePath, sineWav);

      upsertAsset({
        id: 'asset_drone',
        path: 'drone.wav',
        absolutePath: filePath,
        name: 'drone.wav',
        extension: '.wav',
        category: 'audio',
        size: sineWav.length,
        mtime: Date.now(),
        hash: 'h_drone',
        isArchiveEntry: false,
        metadata: { duration: 2.0 },
      });

      const runResult = await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_drone',
        settingsOverride: { minDurationSeconds: 0.5 },
      });

      expect(runResult.totalTargeted).toBe(1);
      expect(runResult.classifiedCount).toBe(0);
      expect(runResult.failedCount).toBe(1);
      expect(runResult.details[0].success).toBe(false);
    });

    it('should analyze audio files inside virtual zip archives', async () => {
      const rhythmicWav = createTestBpmWavBuffer(120, 4, 22050);
      const zipPath = path.join(tempLibraryDir, 'AudioPack.zip');

      createTestZipArchive(zipPath, [
        { name: 'music/level_theme.wav', content: rhythmicWav },
      ]);

      const virtualPath = 'AudioPack.zip#/music/level_theme.wav';
      const assetId = 'zip_asset_level';

      upsertAsset({
        id: assetId,
        path: virtualPath,
        absolutePath: zipPath,
        name: 'level_theme.wav',
        extension: '.wav',
        category: 'audio',
        size: rhythmicWav.length,
        mtime: Date.now(),
        hash: 'h_zip_level',
        isArchiveEntry: true,
        archivePath: zipPath,
        archiveEntryPath: 'music/level_theme.wav',
        metadata: { duration: 4.0 },
      });

      // Test buffer loading
      const asset = getAssetById(assetId)!;
      const loadedBuffer = await loadAssetBuffer(asset);
      expect(loadedBuffer).toBeDefined();
      expect(loadedBuffer?.length).toBe(rhythmicWav.length);

      // Run classifier targeted to archive scope
      const runResult = await runClassifier(bpmClassifier, {
        targetType: 'archive',
        targetValue: 'AudioPack.zip',
      });

      expect(runResult.totalTargeted).toBe(1);
      expect(runResult.classifiedCount).toBe(1);
      expect(runResult.details[0].result?.bpm).toBe(120);

      const updatedAsset = getAssetById(assetId);
      expect(updatedAsset?.metadata.bpm).toBe(120);
      expect(updatedAsset?.tags).toEqual([]);
    });

    it('should track progress reporting callbacks across steps', async () => {
      const rhythmicWav = createTestBpmWavBuffer(120, 4, 22050);
      const filePath = path.join(tempLibraryDir, 'track_prog.wav');
      fs.writeFileSync(filePath, rhythmicWav);

      upsertAsset({
        id: 'asset_prog',
        path: 'track_prog.wav',
        absolutePath: filePath,
        name: 'track_prog.wav',
        extension: '.wav',
        category: 'audio',
        size: rhythmicWav.length,
        mtime: Date.now(),
        hash: 'h_prog',
        isArchiveEntry: false,
        metadata: { duration: 4.0 },
      });

      const progressEvents: any[] = [];
      await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_prog',
        onProgress: (p) => progressEvents.push({ ...p }),
      });

      expect(progressEvents.length).toBeGreaterThanOrEqual(4);
      expect(progressEvents[0].stepIndex).toBe(1);
      expect(progressEvents[0].totalSteps).toBe(4);
      expect(progressEvents[3].stepIndex).toBe(4);
    });

    it('should extract analysis window from the middle of the audio track when exceeding maxAnalysisSeconds', async () => {
      // Create a 10s track:
      // - 0s to 3s: silence (intro)
      // - 3s to 7s: 4s of rhythmic 120 BPM pulses
      // - 7s to 10s: silence (outro)
      const sampleRate = 22050;
      const durationSec = 10;
      const numSamples = sampleRate * durationSec;
      const dataSize = numSamples * 2;
      const customWav = Buffer.alloc(44 + dataSize);

      customWav.write('RIFF', 0);
      customWav.writeUInt32LE(36 + dataSize, 4);
      customWav.write('WAVE', 8);
      customWav.write('fmt ', 12);
      customWav.writeUInt32LE(16, 16);
      customWav.writeUInt16LE(1, 20);
      customWav.writeUInt16LE(1, 22);
      customWav.writeUInt32LE(sampleRate, 24);
      customWav.writeUInt32LE(sampleRate * 2, 28);
      customWav.writeUInt16LE(2, 32);
      customWav.writeUInt16LE(16, 34);
      customWav.write('data', 36);
      customWav.writeUInt32LE(dataSize, 40);

      const beatInterval = 60 / 120;
      for (let i = 0; i < numSamples; i++) {
        const t = i / sampleRate;
        let sample = 0;
        if (t >= 3.0 && t < 7.0) {
          const timeInBeat = (t - 3.0) % beatInterval;
          if (timeInBeat < 0.05) {
            sample = Math.sin(2 * Math.PI * 150 * timeInBeat) * 30000;
          }
        }
        customWav.writeInt16LE(Math.floor(sample), 44 + i * 2);
      }

      const filePath = path.join(tempLibraryDir, 'middle_beat.wav');
      fs.writeFileSync(filePath, customWav);

      upsertAsset({
        id: 'asset_middle_beat',
        path: 'middle_beat.wav',
        absolutePath: filePath,
        name: 'middle_beat.wav',
        extension: '.wav',
        category: 'audio',
        size: customWav.length,
        mtime: Date.now(),
        hash: 'h_mid_beat',
        isArchiveEntry: false,
        metadata: { duration: 10.0 },
      });

      // Windowing with maxAnalysisSeconds: 4 on a 10s track extracts middle [3s, 7s], where the beats are
      const runResult = await runClassifier(bpmClassifier, {
        targetType: 'asset',
        targetValue: 'asset_middle_beat',
        settingsOverride: { maxAnalysisSeconds: 4.0 },
      });

      expect(runResult.totalTargeted).toBe(1);
      expect(runResult.classifiedCount).toBe(1);
      expect(runResult.details[0].success).toBe(true);
      expect(runResult.details[0].result?.bpm).toBe(120);
    });
  });
});
