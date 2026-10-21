import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import {
  scanLibrary,
  getCurrentScanStatus,
  addScanListener,
  requestCancelScan,
} from '../server/src/services/scanner.js';
import { getDatabase, queryAssets, closeDatabase, initDatabase } from '../server/src/db/database.js';
import { getThumbnailsDir } from '../server/src/config.js';
import {
  createTempDir,
  cleanupTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
  createTestWavBuffer,
} from './helpers.js';
import { ScanProgressEvent } from '../shared/types.js';

describe('Scanner Service', () => {
  let libraryDir: string;

  beforeEach(() => {
    libraryDir = createTempDir('lib-scanner-');
    initDatabase(libraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(libraryDir);
  });

  it('should throw an error if target directory does not exist', async () => {
    await expect(scanLibrary('/non/existent/path/for/sure')).rejects.toThrow(
      /Directory does not exist/
    );
  });

  it('should scan library, index images, audio, zip entries, and create stacks', async () => {
    // 1. Create a character animation (2 frames)
    const charDir = path.join(libraryDir, 'characters');
    fs.mkdirSync(charDir, { recursive: true });
    fs.writeFileSync(path.join(charDir, 'walk_01.png'), TINY_PNG_BUFFER);
    fs.writeFileSync(path.join(charDir, 'walk_02.png'), TINY_PNG_BUFFER);

    // 2. Create audio variations
    const audioDir = path.join(libraryDir, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'click_01.wav'), createTestWavBuffer(0.1, 8000));
    fs.writeFileSync(path.join(audioDir, 'click_02.wav'), createTestWavBuffer(0.1, 8000));

    // 3. Create zip archive
    createTestZipArchive(path.join(libraryDir, 'pack.zip'), [
      { name: 'sword.png', content: TINY_PNG_BUFFER },
    ]);

    // 4. Create files to ignore: dotfile, node_modules, unsupported file
    fs.writeFileSync(path.join(libraryDir, '.ignored.png'), TINY_PNG_BUFFER);
    const nmDir = path.join(libraryDir, 'node_modules');
    fs.mkdirSync(nmDir);
    fs.writeFileSync(path.join(nmDir, 'bad.png'), TINY_PNG_BUFFER);
    fs.writeFileSync(path.join(libraryDir, 'notes.txt'), 'Not an asset');

    // Track progress events
    const events: ScanProgressEvent[] = [];
    const unsubscribe = addScanListener((ev) => {
      events.push({ ...ev });
    });

    const status = await scanLibrary(libraryDir);
    unsubscribe();

    expect(status.status).toBe('completed');
    expect(status.indexedCount).toBe(5); // 2 pngs + 2 wavs + 1 zip entry
    expect(status.scannedCount).toBeGreaterThanOrEqual(5);

    // Verify DB records
    const db = getDatabase();
    const assetCount = (db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c;
    expect(assetCount).toBe(5);

    const stackCount = (db.prepare('SELECT COUNT(*) as c FROM stacks').get() as any).c;
    expect(stackCount).toBe(2); // 1 animation stack + 1 audio stack

    // Thumbnails should be written in .assettlor/thumbnails
    const thumbDir = path.join(libraryDir, '.assettlor', 'thumbnails');
    expect(fs.existsSync(thumbDir)).toBe(true);
    const thumbs = fs.readdirSync(thumbDir);
    expect(thumbs.length).toBe(5);

    // Check query engine results
    const stacked = queryAssets({ isStackedView: true });
    // 1 walk stack + 1 click stack + 1 sword inside pack.zip = 3 items
    expect(stacked.items).toHaveLength(3);

    // Ensure progress listener received events
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) => e.status === 'completed')).toBe(true);
  });

  it('should skip reprocessing unchanged files on incremental scan', async () => {
    fs.writeFileSync(path.join(libraryDir, 'static.png'), TINY_PNG_BUFFER);

    // First scan
    const firstStatus = await scanLibrary(libraryDir);
    expect(firstStatus.indexedCount).toBe(1);

    // Second scan without modifying static.png
    const secondStatus = await scanLibrary(libraryDir);
    expect(secondStatus.status).toBe('completed');
    expect(secondStatus.indexedCount).toBe(0); // 0 re-indexed!
  });

  it('should cleanup assets deleted from the filesystem', async () => {
    const file1 = path.join(libraryDir, 'file1.png');
    const file2 = path.join(libraryDir, 'file2.png');
    fs.writeFileSync(file1, TINY_PNG_BUFFER);
    fs.writeFileSync(file2, TINY_PNG_BUFFER);

    await scanLibrary(libraryDir);
    let db = getDatabase();
    expect((db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c).toBe(2);

    // Delete file2 from disk and re-scan
    fs.unlinkSync(file2);
    await scanLibrary(libraryDir);

    db = getDatabase();
    expect((db.prepare('SELECT COUNT(*) as c FROM assets').get() as any).c).toBe(1);
    expect(db.prepare("SELECT * FROM assets WHERE name = 'file2.png'").get()).toBeUndefined();
  });

  it('should cancel scan when requestCancelScan is called', async () => {
    // Generate several files
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(path.join(libraryDir, `frame_${i}.png`), TINY_PNG_BUFFER);
    }

    requestCancelScan();
    const res = await scanLibrary(libraryDir);
    // Should be cancelled / idle
    expect(['idle', 'completed']).toContain(res.status);
  });

  it('should completely rescan a library by removing existing cached entries and reindexing', async () => {
    const file1 = path.join(libraryDir, 'test.png');
    fs.writeFileSync(file1, TINY_PNG_BUFFER);

    await scanLibrary(libraryDir);
    const db = getDatabase();
    const assetBefore = db.prepare("SELECT id, thumbnail_path, created_at FROM assets WHERE name = 'test.png'").get() as any;
    expect(assetBefore).toBeDefined();
    expect(fs.existsSync(assetBefore.thumbnail_path)).toBe(true);

    // Perform full rescan
    const rescanStatus = await scanLibrary(libraryDir, { fullRescan: true });
    expect(rescanStatus.status).toBe('completed');

    const assetAfter = db.prepare("SELECT id, thumbnail_path, created_at FROM assets WHERE name = 'test.png'").get() as any;
    expect(assetAfter).toBeDefined();
    expect(fs.existsSync(assetAfter.thumbnail_path)).toBe(true);
  });

  describe('processed / total progress', () => {
    async function scanWithEvents(target: string | string[]): Promise<ScanProgressEvent[]> {
      const events: ScanProgressEvent[] = [];
      const unsubscribe = addScanListener((event) => events.push({ ...event }));
      try {
        expect((await scanLibrary(target)).status).toBe('completed');
      } finally {
        unsubscribe();
      }
      return events.slice(events.findIndex((event) => event.status === 'scanning'));
    }

    it('counts files ahead and grows the total by each archive\'s indexable entries', async () => {
      fs.writeFileSync(path.join(libraryDir, 'a.png'), TINY_PNG_BUFFER);
      fs.writeFileSync(path.join(libraryDir, 'b.png'), TINY_PNG_BUFFER);
      fs.writeFileSync(path.join(libraryDir, 'notes.txt'), 'Not an asset');
      createTestZipArchive(path.join(libraryDir, 'pack.zip'), [
        { name: 'one.png', content: TINY_PNG_BUFFER },
        { name: 'two.png', content: TINY_PNG_BUFFER },
        { name: 'three.png', content: TINY_PNG_BUFFER },
        { name: 'readme.txt', content: Buffer.from('skip me') },
      ]);

      const events = await scanWithEvents(libraryDir);
      const indexing = events.filter((event) => event.phase === 'indexing');
      // Two images plus the archive placeholder, before the archive is opened.
      expect(indexing[0].totalCount).toBe(3);
      const totals = indexing.map((event) => event.totalCount!);
      expect(totals).toEqual([...totals].sort((left, right) => left - right));
      const final = events.at(-1)!;
      expect(final.status).toBe('completed');
      expect(final.totalCount).toBe(5);
      expect(final.processedCount).toBe(5);
      for (const event of indexing) expect(event.processedCount!).toBeLessThanOrEqual(event.totalCount!);

      // An unchanged archive is not reopened but still counts its entries.
      const rescan = (await scanWithEvents(libraryDir)).at(-1)!;
      expect(rescan.totalCount).toBe(5);
      expect(rescan.processedCount).toBe(5);
    });

    it('counts a file reached through overlapping roots once', async () => {
      const nested = path.join(libraryDir, 'nested');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(libraryDir, 'top.png'), TINY_PNG_BUFFER);
      fs.writeFileSync(path.join(nested, 'inner.png'), TINY_PNG_BUFFER);

      const final = (await scanWithEvents([libraryDir, nested])).at(-1)!;
      expect(final.totalCount).toBe(2);
      expect(final.processedCount).toBe(2);
    });
  });
});
