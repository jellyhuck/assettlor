import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import sharp from 'sharp';
import bmp from 'bmp-js';
import {
  isSupportedImageExtension,
  processImageBuffer,
  processImageFile,
  SUPPORTED_IMAGE_EXTENSIONS,
} from '../server/src/services/image.js';
import {
  createTempDir,
  cleanupTempDir,
  TINY_PNG_BUFFER,
  createTestTgaBuffer,
} from './helpers.js';

describe('Image Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('img-test-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('isSupportedImageExtension', () => {
    it('should return true for all supported image extensions', () => {
      const extensions = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif', '.tga', '.svg'];
      for (const ext of extensions) {
        expect(isSupportedImageExtension(ext)).toBe(true);
        expect(isSupportedImageExtension(ext.toUpperCase())).toBe(true);
      }
    });

    it('should return false for non-image or unsupported extensions', () => {
      const invalid = ['.wav', '.mp3', '.zip', '.txt', '.json', '.exe', '', '.psd'];
      for (const ext of invalid) {
        expect(isSupportedImageExtension(ext)).toBe(false);
      }
    });
  });

  describe('processImageBuffer - PNG', () => {
    it('thumbnails a large GUI template above 16 megapixels', async () => {
      const large = await sharp({
        create: { width: 4500, height: 4300, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 1 } },
      }).png({ compressionLevel: 1 }).toBuffer();

      const result = await processImageBuffer(large, '.png');
      expect(result.metadata.width).toBe(4500);
      expect(result.metadata.height).toBe(4300);
      expect((await sharp(result.thumbnailBuffer).metadata()).format).toBe('webp');
    });

    it('should process a valid PNG buffer and produce WebP thumbnail', async () => {
      const result = await processImageBuffer(TINY_PNG_BUFFER, '.png');
      expect(result).toBeDefined();
      expect(result.metadata.width).toBe(1);
      expect(result.metadata.height).toBe(1);
      expect(result.metadata.format).toBe('png');
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);

      // Verify the generated thumbnail is valid WebP
      const thumbMeta = await sharp(result.thumbnailBuffer).metadata();
      expect(thumbMeta.format).toBe('webp');
      expect(thumbMeta.width).toBe(1);
      expect(thumbMeta.height).toBe(1);
    });
  });

  describe('processImageBuffer - SVG', () => {
    it('should process SVG and render a WebP thumbnail', async () => {
      const svg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="40" fill="red"/></svg>`;
      const buffer = Buffer.from(svg);
      const result = await processImageBuffer(buffer, '.svg');

      expect(result.metadata.width).toBe(100);
      expect(result.metadata.height).toBe(100);
      expect(result.metadata.format).toBe('svg');
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);

      const thumbMeta = await sharp(result.thumbnailBuffer).metadata();
      expect(thumbMeta.format).toBe('webp');
      expect(thumbMeta.width).toBe(100);
      expect(thumbMeta.height).toBe(100);
    });
  });

  describe('processImageBuffer - BMP', () => {
    it('should decode BMP buffer and produce thumbnail', async () => {
      // Create a small 4x4 24-bit BMP buffer using bmp-js
      const width = 4;
      const height = 4;
      const rawData = Buffer.alloc(width * height * 4, 128); // RGBA
      const bmpData = bmp.encode({
        data: rawData,
        width,
        height,
      });

      const result = await processImageBuffer(bmpData.data, '.bmp');
      expect(result.metadata.format).toBe('bmp');
      expect(result.metadata.width).toBe(width);
      expect(result.metadata.height).toBe(height);
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);

      const thumbMeta = await sharp(result.thumbnailBuffer).metadata();
      expect(thumbMeta.format).toBe('webp');
    });
  });

  describe('processImageBuffer - TGA', () => {
    it('should decode 24-bit bottom-up TGA buffer', async () => {
      const tgaBuffer = createTestTgaBuffer(4, 4, false);
      const result = await processImageBuffer(tgaBuffer, '.tga');

      expect(result.metadata.format).toBe('tga');
      expect(result.metadata.width).toBe(4);
      expect(result.metadata.height).toBe(4);
      expect(result.metadata.channels).toBe(3);
      expect(result.metadata.hasAlpha).toBe(false);
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);

      const thumbMeta = await sharp(result.thumbnailBuffer).metadata();
      expect(thumbMeta.format).toBe('webp');
    });

    it('should decode 24-bit top-down TGA buffer', async () => {
      const tgaBuffer = createTestTgaBuffer(2, 2, true);
      const result = await processImageBuffer(tgaBuffer, '.tga');

      expect(result.metadata.format).toBe('tga');
      expect(result.metadata.width).toBe(2);
      expect(result.metadata.height).toBe(2);
    });

    it('should handle corrupt or invalid TGA buffer gracefully', async () => {
      const invalidTga = Buffer.from([0, 0, 99, 0]); // Unsupported type 99
      await expect(processImageBuffer(invalidTga, '.tga')).rejects.toThrow(/TGA.*header/);
    });
  });

  describe('processImageFile', () => {
    it('should read file from disk and process properly', async () => {
      const filePath = path.join(tempDir, 'test.png');
      fs.writeFileSync(filePath, TINY_PNG_BUFFER);

      const result = await processImageFile(filePath);
      expect(result.metadata.width).toBe(1);
      expect(result.metadata.height).toBe(1);
      expect(result.metadata.format).toBe('png');
      expect(result.thumbnailBuffer).toBeInstanceOf(Buffer);
    });
  });
});
