import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  addTagsToAssets,
  closeDatabase,
  getDatabase,
  getThumbnailsDir,
  initDatabase,
} from '../server/src/db/database.js';
import { addScanListener, requestCancelScan, scanLibrary } from '../server/src/services/scanner.js';
import type { ScanProgressEvent } from '../shared/types.js';
import { cleanupTempDir, createTempDir, createTestZipArchive, TINY_PNG_BUFFER } from './helpers.js';

interface Row {
  id: string;
  absolute_path: string;
  archive_entry_path: string | null;
  thumbnail_path: string | null;
  stack_id: string | null;
  metadata: string | null;
}

function rows(): Row[] {
  return getDatabase().prepare(
    'SELECT id, absolute_path, archive_entry_path, thumbnail_path, stack_id, metadata FROM assets ' +
    'ORDER BY absolute_path, archive_entry_path'
  ).all() as Row[];
}

function settingKeys(prefix: string): string[] {
  return (getDatabase().prepare('SELECT key FROM settings WHERE key LIKE ? ORDER BY key').all(`${prefix}%`) as
    { key: string }[]).map((row) => row.key);
}

function archivePaths(): string[] {
  return (getDatabase().prepare('SELECT absolute_path FROM archives').all() as
    { absolute_path: string }[]).map((row) => row.absolute_path);
}

/** Cancels the scan once a scanning event reports at least `count` committed assets. */
function cancelAfterCommits(count: number): { events: ScanProgressEvent[]; stop: () => void } {
  const events: ScanProgressEvent[] = [];
  const stop = addScanListener((event) => {
    events.push({ ...event });
    if (event.status === 'scanning' && (event.committedCount ?? 0) >= count) requestCancelScan();
  });
  return { events, stop };
}

describe('mini-batch index commits', () => {
  let fixture: string;
  let libraryA: string;
  let libraryB: string;
  let dataDir: string;

  beforeEach(() => {
    fixture = createTempDir('scan-batches-');
    libraryA = path.join(fixture, 'library-a');
    libraryB = path.join(fixture, 'library-b');
    dataDir = path.join(fixture, 'data');
    fs.mkdirSync(libraryA, { recursive: true });
    fs.mkdirSync(libraryB, { recursive: true });
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryA, libraryB],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
        folder: { enabled: true },
      },
    });
    initDatabase(dataDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(fixture);
  });

  function writePng(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, TINY_PNG_BUFFER);
  }

  function writeWalkCycle(root: string): string[] {
    const files = [1, 2, 3, 4, 5].map((frame) => path.join(root, 'sprites', `walk_0${frame}.png`));
    for (const file of files) writePng(file);
    return files;
  }

  it('publishes each full batch while the scan is still running', async () => {
    writeWalkCycle(libraryA);
    const visible: { committed: number; rows: number }[] = [];
    const stop = addScanListener((event) => {
      if (event.status === 'scanning' && event.committedCount) {
        visible.push({ committed: event.committedCount, rows: rows().length });
      }
    });
    try {
      const status = await scanLibrary([libraryA], { batchSize: 2 });
      expect(status.status).toBe('completed');
      expect(status.committedCount).toBe(5);
    } finally {
      stop();
    }

    expect(visible).toContainEqual({ committed: 2, rows: 2 });
    expect(visible).toContainEqual({ committed: 4, rows: 4 });
    const indexed = rows();
    expect(indexed).toHaveLength(5);
    expect(new Set(indexed.map((row) => row.stack_id)).size).toBe(1);
    expect(indexed[0].stack_id).not.toBeNull();
    expect(settingKeys('scan:unclassified:')).toEqual([]);
  });

  it('keeps committed batches on cancellation and finishes them on the next scan', async () => {
    writeWalkCycle(libraryA);
    const { stop } = cancelAfterCommits(2);
    let cancelled: ScanProgressEvent;
    try {
      cancelled = await scanLibrary([libraryA], { batchSize: 2 });
    } finally {
      stop();
    }
    expect(cancelled.status).toBe('idle');
    expect(cancelled.message).toMatch(/cancelled; 2 assets indexed before it stopped remain available/);
    expect(cancelled.indexedCount).toBe(2);

    const partial = rows();
    expect(partial).toHaveLength(2);
    for (const row of partial) {
      expect(row.thumbnail_path && fs.existsSync(row.thumbnail_path)).toBe(true);
      expect(row.stack_id).toBeNull();
      expect(JSON.parse(row.metadata!).folders).toBeUndefined();
    }
    const referenced = new Set(partial.map((row) => path.basename(row.thumbnail_path!)));
    expect(fs.readdirSync(getThumbnailsDir()).filter((name) => name.endsWith('.webp')).sort())
      .toEqual([...referenced].sort());
    expect(settingKeys('scan:unclassified:')).toHaveLength(1);
    expect(settingKeys('scan:stack-signature')).toEqual([]);

    const resumed = await scanLibrary([libraryA], { batchSize: 2 });
    expect(resumed.status).toBe('completed');
    expect(resumed.indexedCount).toBe(3);
    const indexed = rows();
    expect(indexed).toHaveLength(5);
    expect(indexed.filter((row) => partial.some((before) => before.id === row.id)))
      .toEqual(partial.map((row) => ({ ...row, stack_id: expect.any(String), metadata: expect.any(String) })));
    expect(new Set(indexed.map((row) => row.stack_id)).size).toBe(1);
    expect(indexed[0].stack_id).not.toBeNull();
    for (const row of indexed) expect(JSON.parse(row.metadata!).folders).toEqual(['sprites']);
    expect(settingKeys('scan:unclassified:')).toEqual([]);
  });

  it('records a ZIP only after all of its entries are committed', async () => {
    const archive = path.join(libraryA, 'Pack.zip');
    createTestZipArchive(archive, ['a', 'b', 'c', 'd', 'e'].map((name) => ({
      name: `sprites/${name}.png`, content: TINY_PNG_BUFFER,
    })));
    const { stop } = cancelAfterCommits(2);
    try {
      expect((await scanLibrary([libraryA], { batchSize: 2 })).status).toBe('idle');
    } finally {
      stop();
    }
    expect(rows()).toHaveLength(2);
    expect(archivePaths()).toEqual([]);

    const resumed = await scanLibrary([libraryA], { batchSize: 2 });
    expect(resumed.status).toBe('completed');
    expect(rows()).toHaveLength(5);
    expect(archivePaths()).toEqual([archive]);
  });

  it('holds a reindexed library until the final commit', async () => {
    const reindexed = [1, 2, 3].map((index) => path.join(libraryA, `icon_${index}x.png`));
    for (const file of reindexed) writePng(file);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const before = rows();
    addTagsToAssets([before[0].id], ['favorite']);
    const tagsBefore = getDatabase().prepare('SELECT asset_id, tag FROM tags').all();
    writeWalkCycle(libraryB);

    const { stop } = cancelAfterCommits(1);
    let cancelled: ScanProgressEvent;
    try {
      cancelled = await scanLibrary([libraryA, libraryB], {
        reindexDirectories: [libraryA], keepUserTags: false, batchSize: 1,
      });
    } finally {
      stop();
    }
    expect(cancelled.status).toBe('idle');
    expect(rows().filter((row) => row.absolute_path.startsWith(libraryA))).toEqual(before);
    expect(getDatabase().prepare('SELECT asset_id, tag FROM tags').all()).toEqual(tagsBefore);
    expect(rows().filter((row) => row.absolute_path.startsWith(libraryB)).length).toBeGreaterThan(0);
  });
});
