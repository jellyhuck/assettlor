import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { resetConfigForTesting } from '../server/src/config.js';
import {
  addTagsToAssets,
  closeDatabase,
  getDatabase,
  getStackAssets,
  initDatabase,
  updateAppSettings,
  upsertAsset,
} from '../server/src/db/database.js';
import {
  addScanListener,
  requestCancelScan,
  scanLibrary,
} from '../server/src/services/scanner.js';
import type { ScanProgressEvent } from '../shared/types.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

interface IndexedAsset {
  id: string;
  path: string;
  absolute_path: string;
  archive_path: string | null;
  archive_entry_path: string | null;
  source_directory: string | null;
  thumbnail_path: string | null;
  stack_id: string | null;
  stack_index: number | null;
  created_at: number;
  updated_at: number;
}

function indexedAssets(): IndexedAsset[] {
  return getDatabase().prepare(
    'SELECT id, path, absolute_path, archive_path, archive_entry_path, ' +
    'source_directory, thumbnail_path, stack_id, stack_index, ' +
    'created_at, updated_at FROM assets ORDER BY id'
  ).all() as IndexedAsset[];
}

function catalogSnapshot(): {
  assets: IndexedAsset[];
  tags: unknown[];
  stacks: unknown[];
  thumbnails: [string, string][];
} {
  const assets = indexedAssets();
  return {
    assets,
    tags: getDatabase().prepare(
      'SELECT asset_id, tag, source FROM tags ORDER BY asset_id, tag, source'
    ).all(),
    stacks: getDatabase().prepare(
      'SELECT id, name, type, item_count, representative_asset_id, metadata, created_at ' +
      'FROM stacks ORDER BY id'
    ).all(),
    thumbnails: assets.map((asset) => [
      asset.id,
      asset.thumbnail_path ? fs.readFileSync(asset.thumbnail_path).toString('base64') : '',
    ]),
  };
}

function failedScopes(status: ScanProgressEvent): string[] {
  return (status as ScanProgressEvent & { failedScopes?: string[] }).failedScopes || [];
}

describe('scan scope reconciliation and lifecycle', () => {
  let fixture: string;
  let libraryA: string;
  let libraryB: string;
  let dataDir: string;

  beforeEach(() => {
    fixture = createTempDir('scan-lifecycle-');
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
        folder: { enabled: false },
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

  function byDiskPath(file: string): IndexedAsset | undefined {
    return indexedAssets().find((asset) => asset.absolute_path === file && !asset.archive_path);
  }

  function byArchiveEntry(archive: string, entry: string): IndexedAsset | undefined {
    return indexedAssets().find(
      (asset) => asset.archive_path === archive && asset.archive_entry_path === entry
    );
  }

  it('preserves an offline root and stable display identities while scanning available roots', async () => {
    const fileA = path.join(libraryA, 'icon.png');
    const fileB = path.join(libraryB, 'sprite.png');
    writePng(fileA);
    writePng(fileB);
    expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
    const beforeA = byDiskPath(fileA)!;
    const beforeB = byDiskPath(fileB)!;
    expect(beforeA).toBeDefined();
    expect(beforeB).toBeDefined();

    fs.renameSync(libraryB, libraryB + '-offline');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = await scanLibrary([libraryA, libraryB]);

    expect(status.status).toBe('completed');
    expect(status.message).toMatch(/partial/i);
    expect(failedScopes(status)).toContain(libraryB);
    expect(byDiskPath(fileA)).toMatchObject({ id: beforeA.id, path: beforeA.path });
    expect(byDiskPath(fileB)).toMatchObject({ id: beforeB.id, path: beforeB.path });
    expect(fs.existsSync(beforeA.thumbnail_path!)).toBe(true);
    expect(fs.existsSync(beforeB.thumbnail_path!)).toBe(true);
  });

  it('indexes overlapping roots once under the most specific source', async () => {
    const nested = path.join(libraryA, 'nested');
    const file = path.join(nested, 'icon.png');
    writePng(file);
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryA, nested],
      classifiers: {
        bpm: { enabled: false }, sprite: { enabled: false }, pack: { enabled: false },
        folder: { enabled: false },
      },
    });

    expect((await scanLibrary([libraryA, nested])).status).toBe('completed');
    const first = byDiskPath(file)!;
    expect(indexedAssets()).toHaveLength(1);
    expect(first.source_directory).toBe(nested);

    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [nested, libraryA],
      classifiers: {
        bpm: { enabled: false }, sprite: { enabled: false }, pack: { enabled: false },
        folder: { enabled: false },
      },
    });
    expect((await scanLibrary([nested, libraryA])).status).toBe('completed');
    expect(indexedAssets()).toHaveLength(1);
    expect(byDiskPath(file)).toMatchObject({
      id: first.id, source_directory: nested, path: first.path,
    });
  });

  it('keeps a legacy nested-root row with no source directory when the inner root is offline', async () => {
    const inner = path.join(libraryA, 'inner');
    const file = path.join(inner, 'icon.png');
    writePng(file);
    resetConfigForTesting({
      data_dir: dataDir,
      libraries: [libraryA, inner],
      classifiers: {
        bpm: { enabled: false },
        sprite: { enabled: false },
        pack: { enabled: false },
        folder: { enabled: false },
      },
    });
    const thumbnail = path.join(dataDir, 'thumbnails', 'legacy-inner.webp');
    fs.writeFileSync(thumbnail, TINY_PNG_BUFFER);
    upsertAsset({
      id: 'legacy-inner-asset',
      path: 'inner/icon.png',
      absolutePath: file,
      name: 'icon.png',
      extension: '.png',
      category: 'image',
      size: TINY_PNG_BUFFER.length,
      mtime: fs.statSync(file).mtimeMs,
      hash: 'legacy-hash',
      isArchiveEntry: false,
      sourceDirectory: null,
      thumbnailPath: thumbnail,
      metadata: { width: 1, height: 1 },
    });
    addTagsToAssets(['legacy-inner-asset'], ['favorite']);
    const before = catalogSnapshot();
    expect(before.assets[0].source_directory).toBeNull();

    fs.renameSync(inner, path.join(fixture, 'inner-offline'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = await scanLibrary([libraryA, inner]);

    expect(status.status).toBe('completed');
    expect(failedScopes(status)).toContain(inner);
    expect(catalogSnapshot()).toEqual(before);
    expect(fs.readFileSync(thumbnail)).toEqual(TINY_PNG_BUFFER);
  });

  it('reconciles only a selected successful root', async () => {
    const fileA = path.join(libraryA, 'deleted.png');
    const fileB = path.join(libraryB, 'untouched.png');
    writePng(fileA);
    writePng(fileB);
    expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
    const beforeB = byDiskPath(fileB)!;

    fs.unlinkSync(fileA);
    const status = await scanLibrary([libraryA]);

    expect(status.status).toBe('completed');
    expect(byDiskPath(fileA)).toBeUndefined();
    expect(byDiskPath(fileB)).toMatchObject({ id: beforeB.id, path: beforeB.path });
  });

  it('keeps configured roots when scanning an unrelated ad hoc root', async () => {
    const fileA = path.join(libraryA, 'old.png');
    const fileB = path.join(libraryB, 'sprite.png');
    const adHoc = path.join(fixture, 'ad-hoc');
    const fileC = path.join(adHoc, 'new.png');
    for (const file of [fileA, fileB, fileC]) writePng(file);
    expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
    const beforeA = byDiskPath(fileA)!;
    const beforeB = byDiskPath(fileB)!;
    addTagsToAssets([beforeB.id], ['favorite']);
    const curatedB = byDiskPath(fileB)!;
    const thumbnailA = fs.readFileSync(beforeA.thumbnail_path!);
    const thumbnailB = fs.readFileSync(beforeB.thumbnail_path!);
    fs.unlinkSync(fileA);

    const status = await scanLibrary([adHoc]);

    expect(status.status).toBe('completed');
    expect(byDiskPath(fileC)).toBeDefined();
    expect(byDiskPath(fileA)).toEqual(beforeA);
    expect(byDiskPath(fileB)).toEqual(curatedB);
    expect(getDatabase().prepare(
      "SELECT 1 FROM tags WHERE asset_id = ? AND tag = 'favorite' AND source = 'user'"
    ).get(beforeB.id)).toBeDefined();
    expect(fs.readFileSync(beforeA.thumbnail_path!)).toEqual(thumbnailA);
    expect(fs.readFileSync(beforeB.thumbnail_path!)).toEqual(thumbnailB);
  });

  it('removes rows only after a configured root is explicitly removed from settings', async () => {
    const fileA = path.join(libraryA, 'kept.png');
    const fileB = path.join(libraryB, 'removed.png');
    writePng(fileA);
    writePng(fileB);
    expect((await scanLibrary([libraryA, libraryB])).status).toBe('completed');
    const beforeA = byDiskPath(fileA)!;
    const beforeB = byDiskPath(fileB)!;
    addTagsToAssets([beforeB.id], ['favorite']);
    expect(fs.existsSync(beforeB.thumbnail_path!)).toBe(true);

    updateAppSettings({ libraryPaths: [libraryA] });
    const status = await scanLibrary([libraryA]);

    expect(status.status).toBe('completed');
    expect(byDiskPath(fileA)).toMatchObject({ id: beforeA.id });
    expect(byDiskPath(fileB)).toBeUndefined();
    expect(getDatabase().prepare('SELECT 1 FROM tags WHERE asset_id = ?').get(beforeB.id))
      .toBeUndefined();
    expect(fs.existsSync(beforeB.thumbnail_path!)).toBe(false);
  });

  it('preserves failed nested scopes while reconciling successful sibling scopes', async () => {
    const failedDir = path.join(libraryA, 'temporarily-unreadable');
    const hiddenFile = path.join(failedDir, 'old.png');
    const removedSibling = path.join(libraryA, 'healthy', 'removed.png');
    writePng(hiddenFile);
    writePng(removedSibling);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const beforeHidden = byDiskPath(hiddenFile)!;
    const hiddenThumbnail = fs.readFileSync(beforeHidden.thumbnail_path!);
    fs.unlinkSync(hiddenFile);
    fs.unlinkSync(removedSibling);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, options) => {
      if (String(directory) === failedDir) {
        throw Object.assign(new Error('injected directory read failure'), { code: 'EACCES' });
      }
      return originalReaddir(directory, options);
    });
    const status = await scanLibrary([libraryA]);

    expect(failedScopes(status)).toContain(failedDir);
    expect(status.status).toMatch(/completed|error/);
    expect(byDiskPath(hiddenFile)).toMatchObject({ id: beforeHidden.id, path: beforeHidden.path });
    expect(fs.readFileSync(beforeHidden.thumbnail_path!)).toEqual(hiddenThumbnail);
    expect(byDiskPath(removedSibling)).toBeUndefined();
  });

  it('keeps rows, user tags, thumbnails, and stacks on immediate full-rescan cancellation', async () => {
    const first = path.join(libraryA, 'walk_01.png');
    const second = path.join(libraryA, 'walk_02.png');
    const third = path.join(libraryA, 'icon.png');
    for (const file of [first, second, third]) writePng(file);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const member = byDiskPath(first)!;
    addTagsToAssets([member.id], ['favorite']);
    const before = catalogSnapshot();
    expect(before.stacks).toHaveLength(1);
    expect(before.tags).toContainEqual({ asset_id: member.id, tag: 'favorite', source: 'user' });

    const events: ScanProgressEvent[] = [];
    let cancelled = false;
    const unsubscribe = addScanListener((event) => {
      events.push({ ...event });
      if (event.status === 'scanning' && !cancelled) {
        cancelled = true;
        requestCancelScan();
      }
    });
    try {
      const status = await scanLibrary([libraryA], { fullRescan: true });
      expect(cancelled).toBe(true);
      expect(status.status).toBe('idle');
      expect(status.message).toMatch(/cancelled/i);
      const startedAt = events.findIndex((event) => event.status === 'scanning');
      expect(events.slice(startedAt).some((event) => event.status === 'completed')).toBe(false);
    } finally {
      unsubscribe();
    }

    expect(catalogSnapshot()).toEqual(before);
    const stack = before.stacks[0] as { id: string; item_count: number };
    expect(getStackAssets(stack.id)).toHaveLength(stack.item_count);
  });

  it('stops ZIP entry work after cancellation and keeps the prior archive catalog', async () => {
    const archive = path.join(libraryA, 'Pack.zip');
    createTestZipArchive(archive, [
      { name: 'sprites/a.png', content: TINY_PNG_BUFFER },
      { name: 'sprites/b.png', content: TINY_PNG_BUFFER },
      { name: 'sprites/c.png', content: TINY_PNG_BUFFER },
    ]);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const first = byArchiveEntry(archive, 'sprites/a.png')!;
    addTagsToAssets([first.id], ['favorite']);
    const before = catalogSnapshot();
    expect(before.assets).toHaveLength(3);

    const originalWriteFile = fs.promises.writeFile.bind(fs.promises);
    const thumbnailRoot = path.join(dataDir, 'thumbnail-staging');
    let thumbnailWrites = 0;
    vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (target, data, options) => {
      await originalWriteFile(target, data, options);
      if (String(target).startsWith(thumbnailRoot)) {
        thumbnailWrites++;
        if (thumbnailWrites === 1) requestCancelScan();
      }
    });
    const events: ScanProgressEvent[] = [];
    const unsubscribe = addScanListener((event) => events.push({ ...event }));
    try {
      const status = await scanLibrary([libraryA], { fullRescan: true });
      expect(thumbnailWrites).toBe(1);
      expect(status.status).toBe('idle');
      expect(status.message).toMatch(/cancelled/i);
      const startedAt = events.findIndex((event) => event.status === 'scanning');
      expect(events.slice(startedAt).some((event) => event.status === 'completed')).toBe(false);
    } finally {
      unsubscribe();
    }

    expect(catalogSnapshot()).toEqual(before);
  });

  it('keeps the prior catalog when a full-rescan root cannot be enumerated', async () => {
    const file = path.join(libraryA, 'icon.png');
    writePng(file);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const before = catalogSnapshot();

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const originalReaddir = fs.promises.readdir.bind(fs.promises);
    vi.spyOn(fs.promises, 'readdir').mockImplementation(async (directory, options) => {
      if (String(directory) === libraryA) {
        throw Object.assign(new Error('injected root read failure'), { code: 'EACCES' });
      }
      return originalReaddir(directory, options);
    });
    const status = await scanLibrary([libraryA], { fullRescan: true });

    expect(status.status).toBe('error');
    expect(failedScopes(status)).toContain(libraryA);
    expect(catalogSnapshot()).toEqual(before);
  });

  it('treats a file root as a failed scope without clearing existing rows', async () => {
    const file = path.join(libraryA, 'icon.png');
    writePng(file);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const before = catalogSnapshot();

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = await scanLibrary([file]);

    expect(status.status).toBe('error');
    expect(failedScopes(status)).toContain(file);
    expect(catalogSnapshot()).toEqual(before);
  });

  it('preserves archive entries and thumbnails when an archive becomes corrupt', async () => {
    const archive = path.join(libraryA, 'Pack.zip');
    createTestZipArchive(archive, [{ name: 'sprites/hero.png', content: TINY_PNG_BUFFER }]);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    const before = byArchiveEntry(archive, 'sprites/hero.png')!;
    expect(before).toBeDefined();
    const thumbnail = fs.readFileSync(before.thumbnail_path!);

    fs.writeFileSync(archive, Buffer.from('not a ZIP archive'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const status = await scanLibrary([libraryA]);

    expect(status.status).toBe('completed');
    expect(status.message).toMatch(/partial/i);
    expect(failedScopes(status)).toContain(archive);
    expect(byArchiveEntry(archive, 'sprites/hero.png')).toMatchObject({
      id: before.id,
      path: before.path,
    });
    expect(fs.readFileSync(before.thumbnail_path!)).toEqual(thumbnail);
  });

  it('removes archive entries only when the archive is confirmed absent', async () => {
    const archive = path.join(libraryA, 'Pack.zip');
    const diskFile = path.join(libraryA, 'icon.png');
    createTestZipArchive(archive, [{ name: 'sprites/hero.png', content: TINY_PNG_BUFFER }]);
    writePng(diskFile);
    expect((await scanLibrary([libraryA])).status).toBe('completed');
    expect(byArchiveEntry(archive, 'sprites/hero.png')).toBeDefined();
    const diskBefore = byDiskPath(diskFile)!;

    fs.unlinkSync(archive);
    const status = await scanLibrary([libraryA]);

    expect(status.status).toBe('completed');
    expect(failedScopes(status)).toEqual([]);
    expect(byArchiveEntry(archive, 'sprites/hero.png')).toBeUndefined();
    expect(byDiskPath(diskFile)).toMatchObject({ id: diskBefore.id, path: diskBefore.path });
  });
});
