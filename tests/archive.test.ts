import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  isArchiveFile,
  inspectZipArchive,
  getZipEntryBuffer,
  getZipRootDirectory,
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
    it('should identify zip files', async () => {
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
    it('should retrieve entry buffer when file exists inside zip', async () => {
      const zipPath = path.join(tempDir, 'sample.zip');
      createTestZipArchive(zipPath, [
        { name: 'sprites/hello.png', content: TINY_PNG_BUFFER },
        { name: 'hello.txt', content: 'Hello from zip' },
      ]);

      const buf = await getZipEntryBuffer(zipPath, 'sprites/hello.png');
      expect(buf).toBeInstanceOf(Buffer);
      expect(buf!.equals(TINY_PNG_BUFFER)).toBe(true);
      // Entries that are never indexed are not served.
      expect(await getZipEntryBuffer(zipPath, 'hello.txt')).toBeNull();
    });

    it('should return null if archive does not exist on disk', async () => {
      const buf = await getZipEntryBuffer('/non/existent/path.zip', 'file.png');
      expect(buf).toBeNull();
    });

    it('should return null if entry does not exist inside zip', async () => {
      const zipPath = path.join(tempDir, 'sample.zip');
      createTestZipArchive(zipPath, [{ name: 'foo.png', content: TINY_PNG_BUFFER }]);

      const buf = await getZipEntryBuffer(zipPath, 'bar.png');
      expect(buf).toBeNull();
    });
  });

  describe('getZipRootDirectory', () => {
    it('should return the single top-level directory', async () => {
      const zipPath = createTestZipArchive(path.join(tempDir, 'single.zip'), [
        { name: 'Pack/a.png', content: TINY_PNG_BUFFER },
        { name: 'Pack/sub/b.png', content: TINY_PNG_BUFFER },
        { name: '.DS_Store', content: 'junk' },
      ]);
      expect(await getZipRootDirectory(zipPath)).toBe('Pack');
    });

    it('should return null for mixed roots or root-level files', async () => {
      const mixed = createTestZipArchive(path.join(tempDir, 'mixed.zip'), [
        { name: 'a/x.png', content: TINY_PNG_BUFFER },
        { name: 'b/y.png', content: TINY_PNG_BUFFER },
      ]);
      const rootFile = createTestZipArchive(path.join(tempDir, 'root-file.zip'), [
        { name: 'Pack/x.png', content: TINY_PNG_BUFFER },
        { name: 'y.png', content: TINY_PNG_BUFFER },
      ]);
      expect(await getZipRootDirectory(mixed)).toBeNull();
      expect(await getZipRootDirectory(rootFile)).toBeNull();
    });

    it('should return null for a missing archive', async () => {
      expect(await getZipRootDirectory(path.join(tempDir, 'missing.zip'))).toBeNull();
    });
  });
});
