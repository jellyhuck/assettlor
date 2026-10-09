import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ArchiveCancelledError,
  ArchiveResourceLimitError,
  DEFAULT_ARCHIVE_LIMITS,
  getZipEntryBuffer,
  inspectZipArchive,
  openZipArchive,
} from '../server/src/services/archive.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestZipArchive,
  createTestWavBuffer,
  TINY_PNG_BUFFER,
} from './helpers.js';

describe('ZIP archive inventory', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('archive-inventory-');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
    vi.restoreAllMocks();
  });

  it('lists entries without decoding and processes each selected entry in isolation', async () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'sprites/good.png', content: TINY_PNG_BUFFER },
      { name: 'sprites/broken.png', content: Buffer.from('not a PNG') },
      { name: 'audio/jump.wav', content: createTestWavBuffer(0.1, 8000) },
      { name: 'notes/readme.txt', content: 'not indexed' },
    ]);

    const inventory = openZipArchive(archivePath, 'Pack.zip', 'outer-hash');
    expect(inventory.entries.map((entry) => entry.entryName).sort()).toEqual([
      'audio/jump.wav', 'sprites/broken.png', 'sprites/good.png',
    ]);
    expect(inventory.entries[0]).not.toHaveProperty('thumbnailBuffer');
    expect(inventory.entries[0]).not.toHaveProperty('metadata');

    const broken = inventory.entries.find((entry) => entry.entryName === 'sprites/broken.png')!;
    await expect(inventory.processEntry(broken)).rejects.toThrow();

    const good = await inventory.processEntry(
      inventory.entries.find((entry) => entry.entryName === 'sprites/good.png')!
    );
    expect(good.metadata.width).toBe(1);
    expect(good.thumbnailBuffer).toBeInstanceOf(Buffer);
    const audio = await inventory.processEntry(
      inventory.entries.find((entry) => entry.entryName === 'audio/jump.wav')!
    );
    expect(audio.metadata.sampleRate).toBe(8000);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compatibleItems = await inspectZipArchive(archivePath, 'Pack.zip', 'outer-hash');
    expect(compatibleItems.map((item) => item.entryName).sort()).toEqual([
      'audio/jump.wav', 'sprites/good.png',
    ]);
  });

  it('keeps unchanged members stable when another member changes', () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    const fixedDate = new Date('2020-01-02T03:04:06.000Z');
    function writeArchive(changedContent: string): void {
      const zip = new AdmZip();
      const changed = zip.addFile('sprites/changed.png', Buffer.from(changedContent));
      changed.header.time = fixedDate;
      const stable = zip.addFile('sprites/stable.png', TINY_PNG_BUFFER);
      stable.header.time = fixedDate;
      zip.writeZip(archivePath);
      fs.utimesSync(archivePath, fixedDate, fixedDate);
    }

    writeArchive('AAAA');
    const firstSize = fs.statSync(archivePath).size;
    const first = openZipArchive(archivePath, 'Pack.zip', 'archive-v1');

    writeArchive('BBBB');
    expect(fs.statSync(archivePath).size).toBe(firstSize);
    const second = openZipArchive(archivePath, 'Another Display/Pack.zip', 'archive-v2');

    expect(second.entries[0].hash).not.toBe(first.entries[0].hash);
    expect(second.entries[1].hash).toBe(first.entries[1].hash);
    expect(second.entries[0].id).toBe(first.entries[0].id);
    expect(second.entries[1].id).toBe(first.entries[1].id);
  });

  it('checks cancellation before inflating an entry', async () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'broken.png', content: Buffer.from('not a PNG') },
    ]);
    const inventory = openZipArchive(archivePath, 'Pack.zip', 'hash');
    await expect(inventory.processEntry(inventory.entries[0], {
      isCancelled: () => true,
    })).rejects.toBeInstanceOf(ArchiveCancelledError);
  });

  it('isolates a damaged local header from healthy archive siblings', async () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'a-broken.png', content: TINY_PNG_BUFFER },
      { name: 'z-good.png', content: TINY_PNG_BUFFER },
    ]);
    const bytes = fs.readFileSync(archivePath);
    const localHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(localHeader).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(0, localHeader);
    fs.writeFileSync(archivePath, bytes);

    const inventory = openZipArchive(archivePath, 'Pack.zip', 'hash');
    expect(inventory.entries).toHaveLength(2);
    const broken = inventory.entries.find((entry) => entry.entryName === 'a-broken.png')!;
    const good = inventory.entries.find((entry) => entry.entryName === 'z-good.png')!;
    await expect(inventory.processEntry(broken)).rejects.toThrow();
    expect((await inventory.processEntry(good)).metadata.width).toBe(1);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const items = await inspectZipArchive(archivePath, 'Pack.zip', 'hash');
    expect(items.map((item) => item.entryName)).toEqual(['z-good.png']);
  });

  it('rejects excessive ZIP file size and entry counts before processing', () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'one.png', content: TINY_PNG_BUFFER },
      { name: 'two.png', content: TINY_PNG_BUFFER },
    ]);
    const size = fs.statSync(archivePath).size;

    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxArchiveBytes: size - 1,
    })).toThrow(ArchiveResourceLimitError);
    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxEntries: 1,
    })).toThrow(ArchiveResourceLimitError);
  });

  it('checks declared per-entry, aggregate, and compression-ratio limits', () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [
      { name: 'one.png', content: Buffer.alloc(128) },
      { name: 'two.png', content: Buffer.alloc(128) },
    ]);

    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxEntryUncompressedBytes: 127,
    })).toThrow(ArchiveResourceLimitError);
    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxTotalUncompressedBytes: 255,
    })).toThrow(ArchiveResourceLimitError);
    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxEntryCompressedBytes: 1,
    })).toThrow(ArchiveResourceLimitError);
    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash', {
      maxCompressionRatio: 2,
    })).toThrow(ArchiveResourceLimitError);
  });

  it('rejects a forged oversized header before on-demand extraction', () => {
    const archivePath = path.join(tempDir, 'Pack.zip');
    createTestZipArchive(archivePath, [{ name: 'one.png', content: TINY_PNG_BUFFER }]);
    const bytes = fs.readFileSync(archivePath);
    const centralHeader = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    expect(centralHeader).toBeGreaterThanOrEqual(0);
    bytes.writeUInt32LE(DEFAULT_ARCHIVE_LIMITS.maxEntryUncompressedBytes + 1, centralHeader + 24);
    fs.writeFileSync(archivePath, bytes);

    expect(() => openZipArchive(archivePath, 'Pack.zip', 'hash')).toThrow(ArchiveResourceLimitError);
    expect(() => getZipEntryBuffer(archivePath, 'one.png')).toThrow(ArchiveResourceLimitError);
  });
});
