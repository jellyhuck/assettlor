import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  initDatabase,
  getDatabase,
  isDatabaseInitialized,
  getAppSettings,
  upsertAsset,
  getScanCacheRecord,
  getArchiveScanCache,
  upsertArchiveRecord,
  getThumbnailsDir,
  getCurrentDataDir,
  reconcileScannedAssets,
  reconcileArchiveRecords,
  removeLibraryIndex,
  restoreTags,
} from '../db/database.js';
import type { ArchiveRecord, CompletedScanScope, TagRow } from '../db/database.js';
import { isSupportedImageExtension, processImageFile } from './image.js';
import { isSupportedAudioExtension, processAudioFile } from './audio.js';
import { isSupportedModelExtension, processModelFile } from './model.js';
import { isArchiveFile, openZipArchive, ArchiveCancelledError, INDEXABLE_ENTRY_TYPES } from './archive.js';
import type { ArchiveInventory, ArchiveInventoryEntry } from './archive.js';
import { runStackingEngine } from './stacker.js';
import {
  getAllClassifiers,
  getEffectiveClassifierSettings,
  runClassifier,
  ClassifierCancelledError,
} from './classifiers/index.js';
import type { AssetMetadata, ScanProgressEvent } from '../../../shared/types.js';
import { config, getDataDir } from '../config.js';
import { canonicalAssetId, sourceDisplaySuffix } from './assetIdentity.js';
import { getProcessingFingerprint, getMetadataProcessingVersion } from './processingFingerprint.js';
import type { ThumbnailCategory } from './processingFingerprint.js';

type SseListener = (event: ScanProgressEvent) => void;
const sseListeners = new Set<SseListener>();

let currentScanStatus: ScanProgressEvent = {
  status: 'idle',
  libraryPath: '',
  libraryPaths: [],
  scannedCount: 0,
  indexedCount: 0,
  committedCount: 0,
};
let cancelRequested = false;

export function addScanListener(listener: SseListener): () => void {
  sseListeners.add(listener);
  listener(currentScanStatus);
  return () => { sseListeners.delete(listener); };
}

export function getCurrentScanStatus(): ScanProgressEvent {
  return currentScanStatus;
}

export function getScanListenerCountForTesting(): number {
  return sseListeners.size;
}

export function requestCancelScan(): void {
  if (currentScanStatus.status === 'scanning') cancelRequested = true;
}

function broadcastProgress(update: Partial<ScanProgressEvent>): void {
  currentScanStatus = { ...currentScanStatus, ...update };
  for (const listener of sseListeners) {
    try {
      listener(currentScanStatus);
    } catch (error) {
      console.warn('Scan progress listener failed:', error);
    }
  }
}

export interface ScanOptions {
  fullRescan?: boolean;
  rescanDirectories?: string[];
  /** Roots whose index is rebuilt from scratch and swapped in at commit. */
  reindexDirectories?: string[];
  /** Restores user tags on reindexed assets that still exist (default true). */
  keepUserTags?: boolean;
  /** Processed assets published per mini-batch commit (tests use small values). */
  batchSize?: number;
}

/** Processed assets that are committed to the index together mid-scan. */
export const INDEX_BATCH_SIZE = 500;

/**
 * Deletes the index of libraries removed from settings, then their unused
 * thumbnails. Returns null while a scan owns the index.
 */
export function purgeLibraryIndexes(roots: string[]): { removedCount: number } | null {
  if (currentScanStatus.status === 'scanning') return null;
  if (!isDatabaseInitialized()) initDatabase(getDataDir());
  const db = getDatabase();
  const removed = new Set(roots.map((root) => path.resolve(root)));
  let removedCount = 0;
  db.transaction(() => {
    for (const root of removed) removedCount += removeLibraryIndex(root).removedCount;
    const marker = db.prepare("SELECT value FROM settings WHERE key = 'scan:configured-roots'").get() as
      { value: string } | undefined;
    if (!marker) return;
    try {
      const previous = JSON.parse(marker.value) as unknown;
      if (Array.isArray(previous)) {
        db.prepare("UPDATE settings SET value = ? WHERE key = 'scan:configured-roots'")
          .run(JSON.stringify(previous.filter((root) => typeof root !== 'string' || !removed.has(path.resolve(root)))));
      }
    } catch (error) {
      console.warn('Ignoring invalid configured-root scan marker:', error);
    }
  })();
  removeUnusedThumbnails();
  return { removedCount };
}

/** Reserve before the route persists settings or starts asynchronous work. */
export function startScan(
  targetDirectories: string[],
  options?: ScanOptions,
  onReserved?: () => void
): Promise<ScanProgressEvent> | null {
  if (currentScanStatus.status === 'scanning') return null;
  cancelRequested = false;
  broadcastProgress({
    status: 'scanning',
    libraryPath: targetDirectories[0] || '',
    libraryPaths: targetDirectories,
    reindexing: Boolean(options?.reindexDirectories?.length),
    phase: 'counting',
    scannedCount: 0,
    indexedCount: 0,
    committedCount: 0,
    totalCount: 0,
    processedCount: 0,
    currentFile: undefined,
    failedScopes: [],
    error: undefined,
    message: 'Starting scan...',
    startTime: Date.now(),
    elapsedMs: 0,
  });
  try {
    onReserved?.();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Scan setup failed';
    broadcastProgress({ status: 'error', error: message, message: `Scan failed: ${message}` });
    throw error;
  }
  return Promise.resolve().then(() => runScanLibrary(targetDirectories, options, true)).catch((error) => {
    const message = error instanceof Error ? error.message : 'Scan setup failed';
    broadcastProgress({ status: 'error', error: message, message: `Scan failed: ${message}` });
    return currentScanStatus;
  });
}

export async function scanLibrary(
  targetDirectoriesInput?: string | string[],
  options?: ScanOptions
): Promise<ScanProgressEvent> {
  return runScanLibrary(targetDirectoriesInput, options, false);
}

class ScanCancelledError extends Error {
  constructor() {
    super('Scan cancelled');
  }
}

interface DiskInventoryItem {
  kind: 'disk';
  sourceDirectory: string;
  absolutePath: string;
  displayPath: string;
  stats: fs.Stats;
  category: ThumbnailCategory;
  extension: string;
  id: string;
}

interface ZipInventoryItem {
  kind: 'zip';
  sourceDirectory: string;
  archivePath: string;
  inventory: ArchiveInventory;
  entry: ArchiveInventoryEntry;
}

type InventoryItem = DiskInventoryItem | ZipInventoryItem;

/** An indexable file found by the counting pass; an archive stands for its entries. */
interface ScanCandidate {
  root: string;
  scope: ScanScope;
  absolutePath: string;
  extension: string;
  kind: ThumbnailCategory | 'archive';
}

/** Minimum interval between routine progress events; milestones are sent at once. */
const PROGRESS_INTERVAL_MS = 100;
type PendingAsset = Parameters<typeof upsertAsset>[0] & {
  stagedThumbnailPath: string;
  classificationRelevant: boolean;
};

interface ScanScope extends CompletedScanScope {
  rootSucceeded: boolean;
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function displayPrefixes(sources: string[]): Map<string, string> {
  const prefixes = new Map<string, string>();
  if (sources.length === 1) {
    prefixes.set(sources[0], '');
    return prefixes;
  }
  const counts = new Map<string, number>();
  for (const source of sources) {
    const base = path.basename(source);
    counts.set(base, (counts.get(base) || 0) + 1);
  }
  for (const source of sources) {
    const base = path.basename(source);
    prefixes.set(source, counts.get(base)! > 1 ? `${base} (${sourceDisplaySuffix(source)})` : base);
  }
  return prefixes;
}

async function contentHash(filePath: string): Promise<string> {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) {
    if (cancelRequested) throw new ScanCancelledError();
    digest.update(chunk as Buffer);
  }
  return digest.digest('hex');
}

export function removeUnusedThumbnails(): void {
  const thumbnailDir = getThumbnailsDir();
  const rows = getDatabase().prepare('SELECT thumbnail_path FROM assets WHERE thumbnail_path IS NOT NULL').all() as
    { thumbnail_path: string }[];
  const referenced = new Set(rows.map((row) => path.resolve(row.thumbnail_path)));
  let names: string[];
  try {
    names = fs.readdirSync(thumbnailDir);
  } catch (error) {
    console.warn(`Cannot inspect thumbnail cache ${thumbnailDir}:`, error);
    return;
  }
  for (const name of names) {
    if (!name.endsWith('.webp')) continue;
    const filePath = path.join(thumbnailDir, name);
    if (!referenced.has(path.resolve(filePath))) {
      try {
        fs.unlinkSync(filePath);
      } catch (error) {
        console.warn(`Cannot remove unused thumbnail ${filePath}:`, error);
      }
    }
  }
}

async function runScanLibrary(
  targetDirectoriesInput?: string | string[],
  options?: ScanOptions,
  reserved = false
): Promise<ScanProgressEvent> {
  if (currentScanStatus.status === 'scanning' && !reserved) return currentScanStatus;
  if (!reserved) cancelRequested = false;
  const startTime = Date.now();

  let supplied: string[];
  if (typeof targetDirectoriesInput === 'string') {
    supplied = targetDirectoriesInput.trim() ? [targetDirectoriesInput.trim()] : [];
  } else if (Array.isArray(targetDirectoriesInput)) {
    supplied = targetDirectoriesInput.map((entry) => String(entry).trim()).filter(Boolean);
  } else {
    const settings = getAppSettings();
    supplied = settings.libraryPaths.length ? settings.libraryPaths : (settings.libraryPath ? [settings.libraryPath] : []);
  }
  const targetRoots = [...new Set(supplied.map((entry) => path.resolve(entry)))];
  if (!targetRoots.length) throw new Error('No target directory specified to scan');
  const reindexRoots = new Set((options?.reindexDirectories ?? []).map((root) => path.resolve(root)));
  const keepUserTags = options?.keepUserTags !== false;
  const batchSize = Math.max(1, Math.floor(options?.batchSize ?? INDEX_BATCH_SIZE));
  if (!targetRoots.some((root) => fs.existsSync(root))) {
    throw new Error(`Directory does not exist: ${targetRoots[0]}`);
  }

  if (!isDatabaseInitialized()) initDatabase(getDataDir());
  const settings = getAppSettings();
  const configuredRoots = [...new Set(settings.libraryPaths.map((root) => path.resolve(root)))];
  const namespaceRoots = configuredRoots.length && targetRoots.every((root) => configuredRoots.includes(root))
    ? configuredRoots
    : targetRoots;
  const prefixes = displayPrefixes(namespaceRoots);
  const thumbnailDir = getThumbnailsDir();
  fs.mkdirSync(thumbnailDir, { recursive: true });
  const dataDir = path.resolve(getCurrentDataDir());
  const canonicalDataDir = fs.realpathSync.native(dataDir);
  const scanId = crypto.randomUUID();
  const stagingDir = path.join(getCurrentDataDir(), 'thumbnail-staging', scanId);
  fs.mkdirSync(stagingDir, { recursive: true });

  let scannedCount = 0;
  let indexedCount = 0;
  const failures = new Set<string>();
  const seenIds = new Set<string>();
  const seenArchives = new Set<string>();
  const archiveRecords: ArchiveRecord[] = [];
  const scopes: ScanScope[] = [];
  // Processed assets awaiting the next mini-batch commit. Reindexed roots are
  // held until the final commit, which swaps their whole index at once.
  let pending: PendingAsset[] = [];
  let cacheRefreshes: { id: string; size: number; mtime: number }[] = [];
  const held: PendingAsset[] = [];
  const heldArchiveRecords: ArchiveRecord[] = [];
  let createdFinalPaths: string[] = [];
  const changedIds = new Set<string>();
  let committedCount = 0;
  const candidates: ScanCandidate[] = [];
  const candidateIds = new Set<string>();
  const candidateArchives = new Set<string>();
  let totalCount = 0;
  let processedCount = 0;
  let lastReport = 0;
  let batchSeq = 0;
  let committed = false;
  const db = getDatabase();
  const beforeMembership = new Map((db.prepare('SELECT id, stack_id, stack_index FROM assets').all() as
    { id: string; stack_id: string | null; stack_index: number | null }[])
    .map((row) => [row.id, `${row.stack_id || ''}:${row.stack_index ?? ''}`]));

  const fail = (scope: ScanScope, failedPath: string, error: unknown): void => {
    failures.add(failedPath);
    scope.failedPaths.push(failedPath);
    console.warn(`Cannot scan ${failedPath}:`, error);
  };
  const cancelled = (): boolean => cancelRequested;
  const throwIfCancelled = (): void => {
    if (cancelRequested) throw new ScanCancelledError();
  };
  const displayPath = (root: string, absolutePath: string): string => {
    const relative = path.relative(root, absolutePath).split(path.sep).join('/');
    const prefix = prefixes.get(root) || '';
    return prefix ? path.posix.join(prefix, relative) : relative;
  };

  // Coalesces per-item updates; forced reports mark milestones such as a
  // committed batch or an opened archive growing the total.
  const reportProgress = (update: Partial<ScanProgressEvent>, force = false): void => {
    const now = Date.now();
    if (!force && now - lastReport < PROGRESS_INTERVAL_MS) return;
    lastReport = now;
    broadcastProgress({ scannedCount, indexedCount, processedCount, totalCount, elapsedMs: now - startTime, ...update });
  };
  const indexingMessage = (): string => `Indexing ${processedCount} / ${totalCount}...`;

  // Counting pass: lists indexable files in processing order so the total is
  // known before any work starts. Each archive counts once until it is opened.
  async function collectCandidates(directory: string, root: string, scope: ScanScope): Promise<void> {
    throwIfCancelled();
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(directory, { withFileTypes: true });
    } catch (error) {
      fail(scope, directory, error);
      return;
    }
    scope.completedDirectories.push(directory);
    if (directory === root) scope.rootSucceeded = true;

    for (const entry of entries) {
      throwIfCancelled();
      if (entry.name === config.cacheDirName || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        let insideDataDir = isWithin(absolutePath, dataDir);
        if (!insideDataDir) {
          try {
            insideDataDir = isWithin(fs.realpathSync.native(absolutePath), canonicalDataDir);
          } catch {
            // Traversal reports vanished or unreadable directories below.
          }
        }
        if (insideDataDir) continue;
        await collectCandidates(absolutePath, root, scope);
        continue;
      }
      if (isWithin(absolutePath, dataDir)) continue;
      if (!entry.isFile()) continue;
      scannedCount++;
      const extension = path.extname(entry.name).toLowerCase();
      const kind = isArchiveFile(absolutePath) ? 'archive'
        : isSupportedImageExtension(extension) ? 'image'
          : isSupportedAudioExtension(extension) ? 'audio'
            : isSupportedModelExtension(extension) ? 'model' : null;
      if (!kind) continue;
      // Overlapping roots reach the same file; the most specific root owns it.
      if (kind === 'archive') {
        if (candidateArchives.has(absolutePath)) continue;
        candidateArchives.add(absolutePath);
      } else {
        const id = canonicalAssetId(absolutePath);
        if (candidateIds.has(id)) continue;
        candidateIds.add(id);
      }
      candidates.push({ root, scope, absolutePath, extension, kind });
      totalCount++;
      reportProgress({
        phase: 'counting',
        currentFile: displayPath(root, absolutePath),
        message: `Counting files... ${totalCount} found`,
      });
    }
  }

  // Processing pass. An opened archive replaces its placeholder in the total
  // with its indexable entries, so the total grows while the scan runs.
  async function processCandidate({ root, scope, absolutePath, extension, kind }: ScanCandidate): Promise<void> {
    throwIfCancelled();
    const itemDisplayPath = displayPath(root, absolutePath);
    reportProgress({ phase: 'indexing', currentFile: itemDisplayPath, message: indexingMessage() });
    let stats: fs.Stats;
    try {
      stats = await fs.promises.stat(absolutePath);
    } catch (error) {
      if (kind !== 'archive') seenIds.add(canonicalAssetId(absolutePath));
      fail(scope, absolutePath, error);
      processedCount++;
      return;
    }
    if (kind === 'archive') {
      seenArchives.add(absolutePath);
      // ctime and inode catch in-place rewrites that preserve size and mtime.
      const signature = `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${INDEXABLE_ENTRY_TYPES}`;
      const unchangedIds = unchangedArchiveEntryIds(absolutePath, itemDisplayPath, root, signature);
      if (unchangedIds) {
        for (const id of unchangedIds) seenIds.add(id);
        totalCount += unchangedIds.length - 1;
        processedCount += unchangedIds.length;
        return;
      }
      const failedBefore = scope.failedPaths.length;
      const processedBefore = processedCount;
      const totalBefore = totalCount;
      try {
        const opened = await openZipArchive(
          absolutePath, itemDisplayPath, `${stats.size}:${stats.mtimeMs}`, {}, cancelled
        );
        try {
          totalCount += opened.entries.length - 1;
          reportProgress({ phase: 'indexing', currentFile: itemDisplayPath, message: indexingMessage() }, true);
          for (const descriptor of opened.entries) {
            if (!seenIds.has(descriptor.id)) {
              seenIds.add(descriptor.id);
              await processInventoryItem({ kind: 'zip', sourceDirectory: root, archivePath: absolutePath, inventory: opened, entry: descriptor });
              flushBatchIfFull();
            }
            processedCount++;
            reportProgress({ phase: 'indexing', currentFile: descriptor.virtualPath, message: indexingMessage() });
          }
          // A failed entry leaves no record, so the next scan reads the archive again.
          // The record is queued after its entries, so it never commits before them.
          if (scope.failedPaths.length === failedBefore) {
            (reindexRoots.has(root) ? heldArchiveRecords : archiveRecords).push({
              absolutePath, path: itemDisplayPath, sourceDirectory: root, signature,
              entryCount: opened.entries.length,
            });
          }
        } finally {
          opened.close();
        }
      } catch (error) {
        if (error instanceof ScanCancelledError || error instanceof ArchiveCancelledError || cancelRequested) {
          throw new ScanCancelledError();
        }
        fail(scope, absolutePath, error);
        // The placeholder and any entries it announced are all settled.
        processedCount = processedBefore + 1 + (totalCount - totalBefore);
      }
    } else {
      const id = canonicalAssetId(absolutePath);
      if (!seenIds.has(id)) {
        seenIds.add(id);
        await processInventoryItem({
          kind: 'disk', sourceDirectory: root, absolutePath,
          displayPath: itemDisplayPath, stats, category: kind, extension, id,
        });
        flushBatchIfFull();
      }
      processedCount++;
    }
  }

  function stagedThumbnail(assetId: string, hash: string, fingerprint: string, force: boolean):
    { stagedPath: string; finalPath: string } {
    const suffix = force ? `-${scanId.slice(0, 12)}` : '';
    const filename = `${assetId}-${hash.slice(0, 16)}-${fingerprint.slice(0, 12)}${suffix}.webp`;
    return { stagedPath: path.join(stagingDir, `${assetId}.webp`), finalPath: path.join(thumbnailDir, filename) };
  }

  const shouldForce = (sourceDirectory: string): boolean => reindexRoots.has(sourceDirectory) ||
    Boolean(options?.fullRescan && (
      !options.rescanDirectories?.length || options.rescanDirectories.some((root) => path.resolve(root) === sourceDirectory)
    ));

  // Returns the indexed entry IDs of an archive that needs no reading: the file
  // is unchanged and every entry would pass the per-entry cache check below.
  function unchangedArchiveEntryIds(
    absolutePath: string, archiveDisplayPath: string, sourceDirectory: string, signature: string
  ): string[] | null {
    if (shouldForce(sourceDirectory)) return null;
    const cached = getArchiveScanCache(absolutePath);
    if (!cached) return null;
    const { record, entries } = cached;
    if (record.signature !== signature || record.path !== archiveDisplayPath ||
        record.sourceDirectory !== sourceDirectory || entries.length !== record.entryCount) {
      return null;
    }
    for (const entry of entries) {
      const category = entry.category as ThumbnailCategory;
      if (entry.metadata.thumbnailFingerprint !== getProcessingFingerprint(category, settings) ||
          entry.metadata.metadataProcessingVersion !== getMetadataProcessingVersion(category) ||
          !entry.thumbnailPath || !fs.existsSync(entry.thumbnailPath)) {
        return null;
      }
    }
    return entries.map((entry) => entry.id);
  }

  // Process each archive before opening the next; only staged files and
  // small asset records survive until reconciliation.
  async function processInventoryItem(item: InventoryItem): Promise<void> {
    throwIfCancelled();
    const isZip = item.kind === 'zip';
    const id = isZip ? item.entry.id : item.id;
    let hash: string;
    try {
      hash = isZip ? item.entry.hash : await contentHash(item.absolutePath);
    } catch (error) {
      if (error instanceof ScanCancelledError || cancelRequested) throw new ScanCancelledError();
      const scope = scopes.find((candidate) => candidate.sourceDirectory === item.sourceDirectory)!;
      fail(scope, isZip ? item.entry.virtualPath : item.absolutePath, error);
      return;
    }
    const category = isZip ? item.entry.category : item.category;
    const fingerprint = getProcessingFingerprint(category as ThumbnailCategory, settings);
    const metadataVersion = getMetadataProcessingVersion(category as ThumbnailCategory);
    const sourceDirectory = item.sourceDirectory;
    const currentPath = isZip ? item.entry.virtualPath : item.displayPath;
    const absolutePath = isZip ? item.archivePath : item.absolutePath;
    const cached = getScanCacheRecord(id);
    if (!shouldForce(sourceDirectory) && cached &&
        cached.path === currentPath && cached.hash === hash &&
        cached.absolutePath === absolutePath &&
        cached.sourceDirectory === sourceDirectory &&
        cached.metadata.thumbnailFingerprint === fingerprint &&
        cached.metadata.metadataProcessingVersion === metadataVersion &&
        cached.thumbnailPath && fs.existsSync(cached.thumbnailPath)) {
      const size = isZip ? item.entry.size : item.stats.size;
      const mtime = isZip ? item.entry.mtime : item.stats.mtimeMs;
      if (cached.size !== size || cached.mtime !== mtime) {
        cacheRefreshes.push({ id, size, mtime });
      }
      return;
    }

    const { stagedPath, finalPath } = stagedThumbnail(id, hash, fingerprint, shouldForce(sourceDirectory));
    try {
      const processed = isZip
        ? await item.inventory.processEntry(item.entry, { quality: settings.thumbnailQuality, isCancelled: cancelled })
        : item.category === 'image'
          ? await processImageFile(item.absolutePath, undefined, undefined, settings.thumbnailQuality)
          : item.category === 'model'
            ? await processModelFile(item.absolutePath, settings.thumbnailQuality)
            : await processAudioFile(item.absolutePath, settings.thumbnailQuality);
      throwIfCancelled();
      if (!isZip) {
        const currentStats = await fs.promises.stat(item.absolutePath);
        if (currentStats.size !== item.stats.size || currentStats.mtimeMs !== item.stats.mtimeMs) {
          throw new Error('Source changed while it was being indexed');
        }
      }
      const metadata: AssetMetadata = {
        ...processed.metadata,
        thumbnailFingerprint: fingerprint,
        metadataProcessingVersion: metadataVersion,
      };
      await fs.promises.writeFile(stagedPath, processed.thumbnailBuffer);
      throwIfCancelled();
      (reindexRoots.has(sourceDirectory) ? held : pending).push({
        id,
        path: currentPath,
        absolutePath,
        name: isZip ? item.entry.filename : path.basename(item.absolutePath),
        extension: isZip ? item.entry.extension : item.extension,
        category,
        size: isZip ? item.entry.size : item.stats.size,
        mtime: isZip ? item.entry.mtime : item.stats.mtimeMs,
        hash,
        isArchiveEntry: isZip,
        archivePath: isZip ? item.archivePath : null,
        archiveEntryPath: isZip ? item.entry.entryName : null,
        sourceDirectory,
        thumbnailPath: finalPath,
        metadata,
        stagedThumbnailPath: stagedPath,
        classificationRelevant: reindexRoots.has(sourceDirectory) || !cached || cached.hash !== hash || cached.path !== currentPath ||
          cached.metadata.metadataProcessingVersion !== metadataVersion,
      });
      indexedCount++;
    } catch (error) {
      if (error instanceof ScanCancelledError || error instanceof ArchiveCancelledError || cancelRequested) {
        throw new ScanCancelledError();
      }
      const scope = scopes.find((candidate) => candidate.sourceDirectory === sourceDirectory)!;
      fail(scope, isZip ? currentPath : absolutePath, error);
    }
  }

  // Versioned cache paths keep old thumbnails readable until the DB commit.
  function publishThumbnails(assets: PendingAsset[]): void {
    for (const asset of assets) {
      throwIfCancelled();
      if (!fs.existsSync(asset.thumbnailPath!)) {
        fs.renameSync(asset.stagedThumbnailPath, asset.thumbnailPath!);
        createdFinalPaths.push(asset.thumbnailPath!);
      }
    }
  }

  // Runs inside a commit transaction; shared by mini-batches and the final commit.
  function writeBatch(
    assets: PendingAsset[], records: ArchiveRecord[], refreshes: { id: string; size: number; mtime: number }[]
  ): void {
    const refresh = db.prepare('UPDATE assets SET size = ?, mtime = ?, updated_at = ? WHERE id = ?');
    for (const asset of refreshes) refresh.run(asset.size, asset.mtime, Date.now(), asset.id);
    for (const asset of assets) upsertAsset(asset);
    for (const record of records) upsertArchiveRecord(record);
    const relevant = assets.filter((asset) => asset.classificationRelevant).map((asset) => asset.id);
    for (const id of relevant) changedIds.add(id);
    // Classifiers run after the final commit; these markers survive an
    // interrupted scan so its committed assets are still classified later.
    if (relevant.length) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
        .run(`scan:unclassified:${scanId}:${batchSeq++}`, JSON.stringify(relevant));
    }
    // Stacking runs only at the final commit; force it if this scan stops early.
    if (assets.length) db.prepare("DELETE FROM settings WHERE key = 'scan:stack-signature'").run();
  }

  // Publishes processed assets once enough accumulate, so an interrupted scan
  // keeps them and a later scan skips them through the cache check.
  function flushBatchIfFull(): void {
    if (pending.length < batchSize) return;
    throwIfCancelled();
    publishThumbnails(pending);
    db.transaction(() => writeBatch(pending, archiveRecords, cacheRefreshes))();
    committedCount += pending.length;
    pending = [];
    archiveRecords.length = 0;
    cacheRefreshes = [];
    createdFinalPaths = [];
    reportProgress({ phase: 'indexing', committedCount, message: `Indexed ${committedCount} assets...` }, true);
  }

  try {
    broadcastProgress({
      status: 'scanning',
      libraryPath: targetRoots[0],
      libraryPaths: targetRoots,
      reindexing: reindexRoots.size > 0,
      phase: 'counting',
      scannedCount: 0,
      indexedCount: 0,
      committedCount: 0,
      totalCount: 0,
      processedCount: 0,
      currentFile: undefined,
      failedScopes: [],
      error: undefined,
      message: targetRoots.length > 1 ? `Starting scan of ${targetRoots.length} libraries...` : 'Starting scan...',
      startTime,
      elapsedMs: 0,
    });
    throwIfCancelled();

    // Inventory records which scopes completed; failed subtrees are never proof of deletion.
    // A file visible through overlapping roots belongs to the most specific
    // configured root regardless of request order.
    for (const root of [...targetRoots].sort((left, right) => right.length - left.length)) {
      throwIfCancelled();
      const scope: ScanScope = { sourceDirectory: root, completedDirectories: [], failedPaths: [], rootSucceeded: false };
      scopes.push(scope);
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(root);
      } catch (error) {
        fail(scope, root, error);
        continue;
      }
      if (!stats.isDirectory()) {
        fail(scope, root, new Error('Library root is not a directory'));
        continue;
      }
      await collectCandidates(root, root, scope);
    }

    reportProgress({ phase: 'indexing', currentFile: undefined, message: indexingMessage() }, true);
    for (const candidate of candidates) await processCandidate(candidate);
    reportProgress({ phase: 'indexing', currentFile: undefined, message: indexingMessage() }, true);

    throwIfCancelled();

    if (!scopes.some((scope) => scope.rootSucceeded)) {
      broadcastProgress({
        status: 'error',
        phase: undefined,
        failedScopes: [...failures],
        scannedCount,
        indexedCount: 0,
        committedCount: 0,
        error: 'No library root could be enumerated',
        message: 'Scan failed: no library root could be enumerated.',
        elapsedMs: Date.now() - startTime,
      });
      return currentScanStatus;
    }

    // A reindex replaces the whole library, so it needs the library root itself.
    for (const root of reindexRoots) {
      if (!scopes.find((scope) => scope.sourceDirectory === root)?.rootSucceeded) {
        throw new Error(`Cannot reindex ${root}: library is unavailable`);
      }
    }

    const remaining = [...pending, ...held];
    publishThumbnails(remaining);
    throwIfCancelled();

    let stackStats = { animationStacksCreated: 0, audioStacksCreated: 0 };
    db.transaction(() => {
      const reindexedTags: TagRow[] = [];
      for (const root of reindexRoots) reindexedTags.push(...removeLibraryIndex(root).tags);
      writeBatch(remaining, [...archiveRecords, ...heldArchiveRecords], cacheRefreshes);
      if (keepUserTags) restoreTags(reindexedTags, seenIds);
      const configuredScan = configuredRoots.length > 0 &&
        targetRoots.every((root) => configuredRoots.includes(root));
      const rootMarker = db.prepare("SELECT value FROM settings WHERE key = 'scan:configured-roots'").get() as
        { value: string } | undefined;
      let removedConfiguredSources: string[] = [];
      if (configuredScan && rootMarker) {
        try {
          const previousRoots = JSON.parse(rootMarker.value) as unknown;
          if (Array.isArray(previousRoots) && previousRoots.every((root) => typeof root === 'string')) {
            removedConfiguredSources = previousRoots.filter((root) => !configuredRoots.includes(root));
          }
        } catch (error) {
          console.warn('Ignoring invalid configured-root scan marker:', error);
        }
      }
      const reconciliation = reconcileScannedAssets(scopes, seenIds, removedConfiguredSources);
      reconcileArchiveRecords(scopes, seenArchives, removedConfiguredSources);
      if (configuredScan) {
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scan:configured-roots', ?)")
          .run(JSON.stringify(configuredRoots));
      }
      const stackSignature = crypto.createHash('sha256').update(JSON.stringify([
        settings.autoStackAnimations, settings.autoStackAudio, settings.defaultFps,
      ])).digest('hex');
      const oldSignature = db.prepare("SELECT value FROM settings WHERE key = 'scan:stack-signature'").get() as
        { value: string } | undefined;
      if (changedIds.size || reconciliation.removedIds.length || oldSignature?.value !== stackSignature) {
        stackStats = runStackingEngine();
        db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('scan:stack-signature', ?)").run(stackSignature);
      } else {
        const counts = db.prepare(`
          SELECT type, COUNT(*) AS count FROM stacks GROUP BY type
        `).all() as { type: string; count: number }[];
        stackStats = {
          animationStacksCreated: counts.find((row) => row.type === 'animation')?.count || 0,
          audioStacksCreated: counts.find((row) => row.type === 'audio_variation')?.count || 0,
        };
      }
    })();
    committed = true;
    const afterMembership = db.prepare('SELECT id, stack_id, stack_index FROM assets').all() as
      { id: string; stack_id: string | null; stack_index: number | null }[];
    for (const row of afterMembership) {
      if (beforeMembership.get(row.id) !== `${row.stack_id || ''}:${row.stack_index ?? ''}`) changedIds.add(row.id);
    }
    removeUnusedThumbnails();
    throwIfCancelled();

    // Includes assets committed by earlier scans that stopped before classifying.
    const unclassifiedRows = db.prepare("SELECT key, value FROM settings WHERE key LIKE 'scan:unclassified:%'").all() as
      { key: string; value: string }[];
    for (const row of unclassifiedRows) {
      try {
        const parsed = JSON.parse(row.value) as unknown;
        if (Array.isArray(parsed)) {
          for (const id of parsed) if (typeof id === 'string') changedIds.add(id);
        }
      } catch (error) {
        console.warn(`Ignoring invalid unclassified-asset marker ${row.key}:`, error);
      }
    }

    broadcastProgress({
      phase: 'classifying', message: 'Running automatic asset classifiers...',
      scannedCount, indexedCount, committedCount: indexedCount, processedCount, totalCount,
    });
    let totalClassified = 0;
    for (const classifier of getAllClassifiers()) {
      throwIfCancelled();
      const effectiveSettings = getEffectiveClassifierSettings(classifier) as { enabled?: boolean };
      if (effectiveSettings.enabled === false) continue;
      const signature = crypto.createHash('sha256').update(JSON.stringify(effectiveSettings)).digest('hex');
      const key = `scan:classifier:${classifier.id}`;
      const pendingKey = `scan:classifier-pending:${classifier.id}`;
      const previous = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
      const previousPending = db.prepare('SELECT value FROM settings WHERE key = ?').get(pendingKey) as
        { value: string } | undefined;
      let retryIds: string[] = [];
      if (previousPending) {
        try {
          const parsed = JSON.parse(previousPending.value) as unknown;
          if (Array.isArray(parsed)) retryIds = parsed.filter((id): id is string => typeof id === 'string');
        } catch {
          // A damaged retry marker causes a full classifier run below.
          retryIds = afterMembership.map((row) => row.id);
        }
      }
      const targetIds = previous?.value === signature
        ? [...new Set([...changedIds, ...retryIds])]
        : afterMembership.map((row) => row.id);
      if (!targetIds.length) continue;
      try {
        db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
          .run(pendingKey, JSON.stringify(targetIds));
        const failedIds = new Set<string>();
        for (let index = 0; index < targetIds.length; index += 500) {
          throwIfCancelled();
          const result = await runClassifier(classifier, {
            targetType: 'asset',
            targetValue: targetIds.slice(index, index + 500),
            shouldCancel: cancelled,
            onProgress: (progress) => {
              broadcastProgress({
                currentFile: progress.currentAsset,
                message: `${classifier.name} [${progress.stepName}]: ${progress.processedCount + 1}/${progress.totalTargeted}`,
              });
            },
          });
          totalClassified += result.classifiedCount;
          for (const detail of result.details) {
            if (detail.retryable) failedIds.add(detail.assetId);
          }
        }
        db.transaction(() => {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, signature);
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
            .run(pendingKey, JSON.stringify([...failedIds]));
        })();
      } catch (error) {
        if (error instanceof ClassifierCancelledError || cancelRequested) throw new ScanCancelledError();
        fail(scopes[0], `classifier:${classifier.id}`, error);
      }
    }
    throwIfCancelled();
    // Each classifier now holds its own retry marker for unfinished targets.
    const deleteMarker = db.prepare('DELETE FROM settings WHERE key = ?');
    db.transaction(() => {
      for (const row of unclassifiedRows) deleteMarker.run(row.key);
    })();

    const elapsedMs = Date.now() - startTime;
    const partial = failures.size > 0;
    broadcastProgress({
      status: 'completed',
      libraryPath: targetRoots[0],
      libraryPaths: targetRoots,
      scannedCount,
      indexedCount,
      committedCount: indexedCount,
      phase: undefined,
      processedCount,
      totalCount,
      failedScopes: [...failures],
      currentFile: undefined,
      error: undefined,
      message: `${partial ? 'Partial scan' : 'Completed'} in ${(elapsedMs / 1000).toFixed(1)}s: ` +
        `${indexedCount} assets indexed (${stackStats.animationStacksCreated} animation stacks, ` +
        `${stackStats.audioStacksCreated} audio variations${totalClassified ? `, ${totalClassified} classified` : ''}).`,
      elapsedMs,
    });
    return currentScanStatus;
  } catch (error) {
    if (!committed) {
      for (const finalPath of createdFinalPaths) {
        try {
          fs.unlinkSync(finalPath);
        } catch (cleanupError) {
          console.warn(`Cannot remove unpublished thumbnail ${finalPath}:`, cleanupError);
        }
      }
      // Committed batches may have replaced thumbnails that are now unused.
      if (committedCount > 0) removeUnusedThumbnails();
    }
    const published = committed ? indexedCount : committedCount;
    const keptNote = !committed && committedCount > 0
      ? `; ${committedCount} assets indexed before it stopped remain available.`
      : '';
    if (error instanceof ScanCancelledError || cancelRequested) {
      broadcastProgress({
        status: 'idle',
        libraryPath: targetRoots[0],
        libraryPaths: targetRoots,
        scannedCount,
        indexedCount: published,
        committedCount: published,
        phase: undefined,
        processedCount,
        totalCount,
        currentFile: undefined,
        failedScopes: [...failures],
        error: undefined,
        message: committed
          ? 'Scan cancelled during automatic classification; indexed assets remain available.'
          : `Scan cancelled${keptNote || '.'}`,
        elapsedMs: Date.now() - startTime,
      });
    } else {
      const message = error instanceof Error ? error.message : 'Unknown error';
      broadcastProgress({
        status: 'error',
        libraryPath: targetRoots[0],
        libraryPaths: targetRoots,
        scannedCount,
        indexedCount: published,
        committedCount: published,
        phase: undefined,
        processedCount,
        totalCount,
        currentFile: undefined,
        failedScopes: [...failures],
        error: message,
        message: committed
          ? `Indexing completed, but automatic classification failed: ${message}`
          : `Scan failed: ${message}${keptNote}`,
        elapsedMs: Date.now() - startTime,
      });
    }
    return currentScanStatus;
  } finally {
    try {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`Cannot remove staged thumbnails ${stagingDir}:`, error);
    }
  }
}
