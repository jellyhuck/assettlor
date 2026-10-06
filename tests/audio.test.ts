import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import {
  isSupportedAudioExtension,
  getAudioMimeType,
  getBpmColor,
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

  describe('getBpmColor', () => {
    it('should return default teal when BPM is null, undefined, or NaN', () => {
      expect(getBpmColor(undefined).primary).toBe('rgb(121, 204, 191)');
      expect(getBpmColor(null).primary).toBe('rgb(121, 204, 191)');
      expect(getBpmColor(NaN).primary).toBe('rgb(121, 204, 191)');
      expect(getBpmColor(undefined).secondary).toBe('#F4CE73');
    });

    it('should return teal color for low BPM (<= 60)', () => {
      const low60 = getBpmColor(60);
      expect(low60.primary).toBe('rgb(121, 204, 191)');
      const low40 = getBpmColor(40);
      expect(low40.primary).toBe('rgb(121, 204, 191)');
    });

    it('should return red color for high BPM (>= 180)', () => {
      const high180 = getBpmColor(180);
      expect(high180.primary).toBe('rgb(239, 68, 68)');
      const high220 = getBpmColor(220);
      expect(high220.primary).toBe('rgb(239, 68, 68)');
    });

    it('should return vibrant purple in the middle for 120 BPM', () => {
      const mid120 = getBpmColor(120);
      // t = (120 - 60) / (180 - 60) = 0.5 -> Purple (168, 85, 247)
      expect(mid120.primary).toBe('rgb(168, 85, 247)');
      expect(mid120.secondary).toBe('#F4CE73');
    });

    it('should smoothly transition from teal through purple to red across tempo ranges', () => {
      const c75 = getBpmColor(75);
      const c100 = getBpmColor(100);
      const c125 = getBpmColor(125);
      const c150 = getBpmColor(150);

      const getR = (c: { primary: string }) => parseInt(c.primary.match(/\d+/)![0], 10);
      expect(getR(c75)).toBeLessThan(getR(c100));
      expect(getR(c100)).toBeLessThan(getR(c125));
      expect(getR(c125)).toBeLessThan(getR(c150));
    });
  });

  describe('generateAudioThumbnail', () => {
    it('should generate sound note icon thumbnail for short sounds (<= 5s)', async () => {
      const thumb = await generateAudioThumbnail('laser_shot_01.wav', 1.25, 2);
      expect(thumb).toBeInstanceOf(Buffer);

      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(240);
    });

    it('should generate sound note icon thumbnail for 5.0s boundary sound', async () => {
      const thumb = await generateAudioThumbnail('click_5s.wav', 5.0, 1);
      expect(thumb).toBeInstanceOf(Buffer);
      const meta = await sharp(thumb).metadata();
      expect(meta.format).toBe('webp');
    });

    it('should generate music plate icon thumbnail for music (> 5s)', async () => {
      const thumbMusic = await generateAudioThumbnail('theme_song.mp3', 45, 2, 120);
      expect(thumbMusic).toBeInstanceOf(Buffer);

      const meta = await sharp(thumbMusic).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(400);
      expect(meta.height).toBe(240);
    });

    it('should generate dedicated thumbnails unaffected by BPM values', async () => {
      const lowBpmThumb = await generateAudioThumbnail('dance_track.mp3', 60, 2, 70);
      const highBpmThumb = await generateAudioThumbnail('dance_track.mp3', 60, 2, 175);
      const noBpmThumb = await generateAudioThumbnail('dance_track.mp3', 60, 2);
      expect(lowBpmThumb.equals(highBpmThumb)).toBe(true);
      expect(lowBpmThumb.equals(noBpmThumb)).toBe(true);
    });

    it('should generate identical thumbnails for identical inputs', async () => {
      const thumb1 = await generateAudioThumbnail('test_audio.wav', 2.5);
      const thumb2 = await generateAudioThumbnail('test_audio.wav', 2.5);
      expect(thumb1.equals(thumb2)).toBe(true);

      const musicThumb1 = await generateAudioThumbnail('song.mp3', 60, 2, 130);
      const musicThumb2 = await generateAudioThumbnail('song.mp3', 60, 2, 130);
      expect(musicThumb1.equals(musicThumb2)).toBe(true);
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
