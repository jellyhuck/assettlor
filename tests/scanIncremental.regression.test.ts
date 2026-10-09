import AdmZip from 'adm-zip';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  addTagsToAssets,
  closeDatabase,
  getDatabase,
  initDatabase,
  updateAppSettings,
} from '../server/src/db/database.js';
import { addScanListener, requestCancelScan, scanLibrary } from '../server/src/services/scanner.js';
import type { ScanProgressEvent } from '../shared/types.js';
import { cleanupTempDir, createTempDir, createTestTgaBuffer, TINY_PNG_BUFFER } from './helpers.js';

const calls = vi.hoisted(() => ({
  imageBuffers: [] as string[],
  imageFiles: [] as string[],
  classifierRuns: [] as string[],
  beforeClassifier: undefined as undefined | (() => Promise<void>),
}));

vi.mock('../server/src/services/image.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/src/services/image.js')>();
  return {
    ...actual,
    processImageBuffer: async (...args: Parameters<typeof actual.processImageBuffer>) => {
      calls.imageBuffers.push(args[0].toString('base64'));
      return actual.processImageBuffer(...args);
    },
    processImageFile: async (...args: Parameters<typeof actual.processImageFile>) => {
      calls.imageFiles.push(args[0]);
      return actual.processImageFile(...args);
    },
  };
});

vi.mock('../server/src/services/classifiers/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../server/src/services/classifiers/index.js')>();
  return {
    ...actual,
    runClassifier: async (...args: Parameters<typeof actual.runClassifier>) => {
      calls.classifierRuns.push(args[0].id);
      await calls.beforeClassifier?.();
      return actual.runClassifier(...args);
    },
  };
});

interface CacheRow {
  id: string;
  hash: string;
  thumbnail_path: string;
  metadata: string;
  created_at: number;
}

function cacheRow(absolutePath: string): CacheRow {
  const row = getDatabase().prepare(
    'SELECT id, hash, thumbnail_path, metadata, created_at FROM assets WHERE absolute_path = ?'
  ).get(absolutePath) as CacheRow | undefined;
  if (!row) throw new Error('Asset missing from index: ' + absolutePath);
  return row;
}

describe('incremental scan and thumbnail freshness', () => {
  let fixture: string;
  let libraryDir: string;
  let dataDir: string;

  beforeEach(() => {
    fixture = createTempDir('scan-incremental-');
    libraryDir = path.join(fixture, 'library');
    dataDir = path.join(fixture, 'data');
    fs.mkdirSync(libraryDir, { recursive: true });
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryDir],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
      },
    });
    initDatabase(dataDir);
    calls.imageBuffers.length = 0;
    calls.imageFiles.length = 0;
    calls.classifierRuns.length = 0;
    calls.beforeClassifier = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    calls.beforeClassifier = undefined;
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(fixture);
  });

  function writeArchive(archivePath: string, stable: Buffer, changing: Buffer): void {
    const zip = new AdmZip();
    const fixedDate = new Date('2020-01-02T03:04:06.000Z');
    for (const [name, content] of [
      ['sprites/stable.png', stable],
      ['sprites/changing.png', changing],
    ] as const) {
      const entry = zip.addFile(name, content);
      entry.header.time = fixedDate;
    }
    zip.writeZip(archivePath);
    fs.utimesSync(archivePath, fixedDate, fixedDate);
  }

  it('skips unchanged ZIP decoding and decodes only a changed entry', async () => {
    const archivePath = path.join(libraryDir, 'Pack.zip');
    const stable = TINY_PNG_BUFFER;
    const firstChanging = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#ff0000' },
    }).png().toBuffer();
    const secondChanging = await sharp({
      create: { width: 2, height: 2, channels: 4, background: '#0000ff' },
    }).png().toBuffer();
    writeArchive(archivePath, stable, firstChanging);

    expect((await scanLibrary([libraryDir])).status).toBe('completed');
    expect(calls.imageBuffers).toHaveLength(2);
    calls.imageBuffers.length = 0;

    const unchanged = await scanLibrary([libraryDir]);
    expect(unchanged.status).toBe('completed');
    expect(unchanged.indexedCount).toBe(0);
    expect(calls.imageBuffers).toEqual([]);

    writeArchive(archivePath, stable, secondChanging);
    const changed = await scanLibrary([libraryDir]);
    expect(changed.status).toBe('completed');
    expect(changed.indexedCount).toBe(1);
    expect(calls.imageBuffers).toEqual([secondChanging.toString('base64')]);
  });

  it('detects a same-size replacement with preserved file modification time', async () => {
    const file = path.join(libraryDir, 'sprite.tga');
    const first = createTestTgaBuffer(2, 2, true);
    const second = Buffer.from(first);
    second[18] = 20;
    const fixedDate = new Date('2020-01-02T03:04:06.000Z');
    fs.writeFileSync(file, first);
    fs.utimesSync(file, fixedDate, fixedDate);
    expect((await scanLibrary([libraryDir])).status).toBe('completed');
    const before = cacheRow(file);
    addTagsToAssets([before.id], ['favorite']);
    calls.imageFiles.length = 0;

    fs.writeFileSync(file, second);
    fs.utimesSync(file, fixedDate, fixedDate);
    expect(fs.statSync(file).size).toBe(first.length);
    expect(fs.statSync(file).mtimeMs).toBe(fixedDate.getTime());
    const status = await scanLibrary([libraryDir]);
    const after = cacheRow(file);

    expect(status.status).toBe('completed');
    expect(status.indexedCount).toBe(1);
    expect(calls.imageFiles).toEqual([file]);
    expect(after.id).toBe(before.id);
    expect(after.hash).not.toBe(before.hash);
    expect(getDatabase().prepare(
      "SELECT 1 FROM tags WHERE asset_id = ? AND tag = 'favorite' AND source = 'user'"
    ).get(before.id)).toBeDefined();
  });

  it('excludes the canonical active data directory even when it is named data', async () => {
    closeDatabase();
    dataDir = path.join(libraryDir, 'data');
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryDir],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
      },
    });
    initDatabase(dataDir);
    const source = path.join(libraryDir, 'source.png');
    const cached = path.join(dataDir, 'cached.png');
    fs.writeFileSync(source, TINY_PNG_BUFFER);
    fs.writeFileSync(cached, TINY_PNG_BUFFER);

    const status = await scanLibrary([libraryDir]);
    const rows = getDatabase().prepare('SELECT absolute_path FROM assets').all() as
      { absolute_path: string }[];

    expect(status.status).toBe('completed');
    expect(status.scannedCount).toBe(1);
    expect(rows).toEqual([{ absolute_path: source }]);
  });

  it('regenerates thumbnails for quality changes without losing user curation', async () => {
    const file = path.join(libraryDir, 'sprite.tga');
    fs.writeFileSync(file, createTestTgaBuffer(2, 2, true));
    expect((await scanLibrary([libraryDir])).status).toBe('completed');
    const before = cacheRow(file);
    const oldFingerprint = (JSON.parse(before.metadata) as { thumbnailFingerprint: string }).thumbnailFingerprint;
    addTagsToAssets([before.id], ['favorite']);
    calls.imageFiles.length = 0;

    updateAppSettings({ thumbnailQuality: 37 });
    const status = await scanLibrary([libraryDir]);
    const after = cacheRow(file);
    const newFingerprint = (JSON.parse(after.metadata) as { thumbnailFingerprint: string }).thumbnailFingerprint;

    expect(status.status).toBe('completed');
    expect(status.indexedCount).toBe(1);
    expect(calls.imageFiles).toEqual([file]);
    expect(after.id).toBe(before.id);
    expect(after.hash).toBe(before.hash);
    expect(after.created_at).toBe(before.created_at);
    expect(newFingerprint).not.toBe(oldFingerprint);
    expect(after.thumbnail_path).not.toBe(before.thumbnail_path);
    expect(fs.existsSync(after.thumbnail_path)).toBe(true);
    expect(getDatabase().prepare(
      "SELECT 1 FROM tags WHERE asset_id = ? AND tag = 'favorite' AND source = 'user'"
    ).get(before.id)).toBeDefined();
  });

  it('skips automatic classifier work on an unchanged scan', async () => {
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryDir],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: true },
      },
    });
    const file = path.join(libraryDir, 'sprite.png');
    fs.writeFileSync(file, TINY_PNG_BUFFER);

    expect((await scanLibrary([libraryDir])).status).toBe('completed');
    expect(calls.classifierRuns).toContain('pack');
    calls.classifierRuns.length = 0;

    const unchanged = await scanLibrary([libraryDir]);
    expect(unchanged.status).toBe('completed');
    expect(unchanged.indexedCount).toBe(0);
    expect(calls.classifierRuns).toEqual([]);
  });

  it('refreshes file timestamps without decoding byte-identical content', async () => {
    const file = path.join(libraryDir, 'unchanged.png');
    fs.writeFileSync(file, TINY_PNG_BUFFER);
    expect((await scanLibrary([libraryDir])).status).toBe('completed');
    const before = cacheRow(file);
    calls.imageFiles.length = 0;

    const replacementTime = new Date('2025-04-05T06:07:08.000Z');
    fs.utimesSync(file, replacementTime, replacementTime);
    const status = await scanLibrary([libraryDir]);
    const after = cacheRow(file);
    const stored = getDatabase().prepare('SELECT mtime FROM assets WHERE id = ?').get(after.id) as
      { mtime: number };

    expect(status.status).toBe('completed');
    expect(status.indexedCount).toBe(0);
    expect(calls.imageFiles).toEqual([]);
    expect(after.thumbnail_path).toBe(before.thumbnail_path);
    expect(stored.mtime).toBe(fs.statSync(file).mtimeMs);
  });

  it('ends as cancelled during automatic classification and retries unfinished work', async () => {
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryDir],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: true },
      },
    });
    const file = path.join(libraryDir, 'sprite.png');
    fs.writeFileSync(file, TINY_PNG_BUFFER);
    const events: ScanProgressEvent[] = [];
    const unsubscribe = addScanListener((event) => events.push({ ...event }));
    calls.beforeClassifier = async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      requestCancelScan();
    };

    try {
      const cancelled = await scanLibrary([libraryDir]);
      expect(calls.classifierRuns).toContain('pack');
      expect(cancelled.status).toBe('idle');
      expect(cancelled.message).toMatch(/cancelled/i);
      const startedAt = events.findIndex((event) => event.status === 'scanning');
      expect(events.slice(startedAt).some((event) => event.status === 'completed')).toBe(false);
      // Index publication precedes automatic classification; cancellation
      // stops the classifier without discarding the usable indexed asset.
      expect(cacheRow(file).id).toBeDefined();
    } finally {
      calls.beforeClassifier = undefined;
      unsubscribe();
    }

    calls.classifierRuns.length = 0;
    const resumed = await scanLibrary([libraryDir]);
    expect(resumed.status).toBe('completed');
    expect(calls.classifierRuns).toContain('pack');
  });
});
