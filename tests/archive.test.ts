import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  isArchiveFile,
  inspectZipArchive,
  getZipEntryBuffer,
} from '../server/src/services/archive.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
  createTestWavBuffer,
} from './helpers.js';

describe('Archive Service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('archive-test-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('isArchiveFile', () => {
    it('should identify zip files', () => {
      expect(isArchiveFile('pack.zip')).toBe(true);
      expect(isArchiveFile('/path/to/archive.ZIP')).toBe(true);
      expect(isArchiveFile('bundle.tar.gz')).toBe(false);
      expect(isArchiveFile('image.png')).toBe(false);
    });
  });

  describe('inspectZipArchive', () => {
    it('should extract images and audio entries from zip with tags and metadata', async () => {
      const zipPath = path.join(tempDir, 'MyPack.zip');
      createTestZipArchive(zipPath, [
        { name: 'sprites/hero.png', content: TINY_PNG_BUFFER },
        { name: 'audio/sfx/jump.wav', content: createTestWavBuffer(0.1, 8000) },
        { name: 'docs/readme.txt', content: 'Some documentation' },
        { name: '__MACOSX/._hero.png', content: 'hidden apple double' },
        { name: '.DS_Store', content: 'mac junk' },
      ]);

      const items = await inspectZipArchive(zipPath, 'MyPack.zip', 'hash123');

      // Should only extract hero.png and jump.wav (skipping readme.txt and __MACOSX / .DS_Store)
      expect(items).toHaveLength(2);

      const hero = items.find((i) => i.filename === 'hero.png');
      expect(hero).toBeDefined();
      expect(hero!.category).toBe('image');
      expect(hero!.virtualPath).toBe('MyPack.zip#/sprites/hero.png');
      expect(hero!.id).toMatch(/^zip_/);
      expect(hero!.metadata.width).toBe(1);
      expect(hero!.metadata.height).toBe(1);
      expect(hero!.thumbnailBuffer).toBeInstanceOf(Buffer);

      // Verify tags on hero: archive name, folder, extension, category
      const heroTagNames = hero!.tags.map((t) => t.tag);
      expect(heroTagNames).toContain('MyPack');
      expect(heroTagNames).toContain('sprites');
      expect(heroTagNames).toContain('png');
      expect(heroTagNames).toContain('image');

      const jump = items.find((i) => i.filename === 'jump.wav');
      expect(jump).toBeDefined();
      expect(jump!.category).toBe('audio');
      expect(jump!.virtualPath).toBe('MyPack.zip#/audio/sfx/jump.wav');
      expect(jump!.metadata.sampleRate).toBe(8000);

      const jumpTagNames = jump!.tags.map((t) => t.tag);
      expect(jumpTagNames).toContain('MyPack');
      expect(jumpTagNames).toContain('audio');
      expect(jumpTagNames).toContain('sfx');
      expect(jumpTagNames).toContain('wav');
    });

    it('should return empty array for empty zip archive', async () => {
      const zipPath = path.join(tempDir, 'empty.zip');
      createTestZipArchive(zipPath, []);

      const items = await inspectZipArchive(zipPath, 'empty.zip', 'hash_empty');
      expect(items).toEqual([]);
    });
  });

  describe('getZipEntryBuffer', () => {
    it('should retrieve entry buffer when file exists inside zip', () => {
      const zipPath = path.join(tempDir, 'sample.zip');
      const textContent = 'Hello from zip';
      createTestZipArchive(zipPath, [
        { name: 'hello.txt', content: textContent },
      ]);

      const buf = getZipEntryBuffer(zipPath, 'hello.txt');
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf!.toString('utf8')).toBe(textContent);
    });

    it('should return null if archive does not exist on disk', () => {
      const buf = getZipEntryBuffer('/non/existent/path.zip', 'file.png');
      expect(buf).toBeNull();
    });

    it('should return null if entry does not exist inside zip', () => {
      const zipPath = path.join(tempDir, 'sample.zip');
      createTestZipArchive(zipPath, [{ name: 'foo.png', content: TINY_PNG_BUFFER }]);

      const buf = getZipEntryBuffer(zipPath, 'bar.png');
      expect(buf).toBeNull();
    });
  });
});
