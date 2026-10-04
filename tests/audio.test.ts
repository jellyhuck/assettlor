import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import {
  isSupportedAudioExtension,
  getAudioMimeType,
  generateAudioThumbnail,
  processAudioBuffer,
  processAudioFile,
  SUPPORTED_AUDIO_EXTENSIONS,
} from '../server/src/services/audio.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestWavBuffer,
} from './helpers.js';

describe('Audio Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('audio-test-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('isSupportedAudioExtension', () => {
    it('should return true for supported audio formats', () => {
      const valid = ['.wav', '.mp3', '.ogg', '.flac'];
      for (const ext of valid) {
        expect(isSupportedAudioExtension(ext)).toBe(true);
        expect(isSupportedAudioExtension(ext.toUpperCase())).toBe(true);
      }
    });

    it('should return false for unsupported extensions', () => {
      const invalid = ['.png', '.jpg', '.txt', '.zip', '.m4a', ''];
      for (const ext of invalid) {
        expect(isSupportedAudioExtension(ext)).toBe(false);
      }
    });
  });

  describe('getAudioMimeType', () => {
    it('should return proper MIME type for each extension', () => {
      expect(getAudioMimeType('.wav')).toBe('audio/wav');
      expect(getAudioMimeType('.WAV')).toBe('audio/wav');
      expect(getAudioMimeType('.mp3')).toBe('audio/mpeg');
      expect(getAudioMimeType('.ogg')).toBe('audio/ogg');
      expect(getAudioMimeType('.flac')).toBe('audio/flac');
      expect(getAudioMimeType('.unknown')).toBe('audio/wav');
    });
  });

  describe('generateAudioThumbnail', () => {
    it('should generate a valid WebP thumbnail from audio name', async () => {
      const thumb = await generateAudioThumbnail('laser_shot_01.wav', 1.25, 2);
      expect(thumb).toBeInstanceOf(Buffer);

      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(240);
    });

    it('should generate identical thumbnails for the same name and metadata', async () => {
      const thumb1 = await generateAudioThumbnail('test_audio', 2.5);
      const thumb2 = await generateAudioThumbnail('test_audio', 2.5);
      expect(thumb1.equals(thumb2)).toBe(true);
    });

    it('should handle zero or undefined duration without crashing', async () => {
      const thumb = await generateAudioThumbnail('ambient_silence', undefined, 1);
      expect(thumb).toBeInstanceOf(Buffer);
      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe('webp');
    });
  });

  describe('processAudioBuffer', () => {
    it('should parse metadata from valid WAV buffer', async () => {
      const wavBuffer = createTestWavBuffer(0.2, 8000);
      const result = await processAudioBuffer(wavBuffer, 'test_beep.wav', '.wav');

      expect(result).toBeDefined();
      expect(result.metadata.sampleRate).toBe(8000);
      expect(result.metadata.numberOfChannels).toBe(1);
      expect(result.metadata.duration).toBeGreaterThan(0.18);
      expect(result.metadata.lossless).toBe(true);
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);
    });

    it('should handle invalid or corrupted audio buffer gracefully', async () => {
      const corruptBuffer = Buffer.from('NOT A VALID AUDIO FILE');
      const result = await processAudioBuffer(corruptBuffer, 'broken.wav', '.wav');

      expect(result).toBeDefined();
      expect(result.metadata).toEqual({});
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);
    });
  });

  describe('processAudioFile', () => {
    it('should process audio file on disk', async () => {
      const filePath = path.join(tempDir, 'beep.wav');
      fs.writeFileSync(filePath, createTestWavBuffer(0.1, 8000));

      const result = await processAudioFile(filePath);
      expect(result).toBeDefined();
      expect(result.metadata.sampleRate).toBe(8000);
      expect(result.metadata.numberOfChannels).toBe(1);
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);
    });
  });
});
