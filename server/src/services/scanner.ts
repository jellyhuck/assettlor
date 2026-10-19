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
  getThumbnailsDir,
  getCurrentDataDir,
  reconcileScannedAssets,
} from '../db/database.js';
import type { CompletedScanScope } from '../db/database.js';
import { isSupportedImageExtension, processImageFile } from './image.js';
import { isSupportedAudioExtension, processAudioFile } from './audio.js';
import { isArchiveFile, openZipArchive, ArchiveCancelledError } from './archive.js';
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

type SseListener = (event: ScanProgressEvent) => void;
const sseListeners = new Set<SseListener>();

let currentScanStatus: ScanProgressEvent = {
  status: 'idle',
  libraryPath: '',
  libraryPaths: [],
  scannedCount: 0,
  indexedCount: 0,
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
    scannedCount: 0,
    indexedCount: 0,
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
  category: 'image' | 'audio';
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

function removeUnusedThumbnails(): void {
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
  const scopes: ScanScope[] = [];
  const pending: PendingAsset[] = [];
  const cacheRefreshes: { id: string; size: number; mtime: number }[] = [];
  const createdFinalPaths: string[] = [];
  let committed = false;

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

  async function walkDirectory(directory: string, root: string, scope: ScanScope): Promise<void> {
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
        await walkDirectory(absolutePath, root, scope);
        continue;
      }
      if (isWithin(absolutePath, dataDir)) continue;
      if (!entry.isFile()) continue;
      scannedCount++;
      const extension = path.extname(entry.name).toLowerCase();
      const image = isSupportedImageExtension(extension);
      const audio = isSupportedAudioExtension(extension);
      const archive = isArchiveFile(absolutePath);
      if (!image && !audio && !archive) continue;
      if (scannedCount % 10 === 0) {
        broadcastProgress({
          scannedCount,
          indexedCount,
          currentFile: displayPath(root, absolutePath),
          elapsedMs: Date.now() - startTime,
          message: `Inventoried ${scannedCount} files...`,
        });
      }
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(absolutePath);
      } catch (error) {
        if (!archive) seenIds.add(canonicalAssetId(absolutePath));
        fail(scope, absolutePath, error);
        continue;
      }
      if (archive) {
        try {
          const opened = await openZipArchive(
            absolutePath, displayPath(root, absolutePath), `${stats.size}:${stats.mtimeMs}`, {}, cancelled
          );
          try {
            for (const descriptor of opened.entries) {
              if (seenIds.has(descriptor.id)) continue;
              seenIds.add(descriptor.id);
              await processInventoryItem({ kind: 'zip', sourceDirectory: root, archivePath: absolutePath, inventory: opened, entry: descriptor });
            }
          } finally {
            opened.close();
          }
        } catch (error) {
          if (error instanceof ScanCancelledError || error instanceof ArchiveCancelledError || cancelRequested) {
            throw new ScanCancelledError();
          }
          fail(scope, absolutePath, error);
        }
      } else {
        const id = canonicalAssetId(absolutePath);
        if (seenIds.has(id)) continue;
        seenIds.add(id);
        await processInventoryItem({
          kind: 'disk', sourceDirectory: root, absolutePath,
          displayPath: displayPath(root, absolutePath), stats,
          category: image ? 'image' : 'audio', extension, id,
        });
      }
    }
  }

  function stagedThumbnail(assetId: string, hash: string, fingerprint: string, force: boolean):
    { stagedPath: string; finalPath: string } {
    const suffix = force ? `-${scanId.slice(0, 12)}` : '';
    const filename = `${assetId}-${hash.slice(0, 16)}-${fingerprint.slice(0, 12)}${suffix}.webp`;
    return { stagedPath: path.join(stagingDir, `${assetId}.webp`), finalPath: path.join(thumbnailDir, filename) };
  }

  const shouldForce = (sourceDirectory: string): boolean => Boolean(options?.fullRescan && (
    !options.rescanDirectories?.length || options.rescanDirectories.some((root) => path.resolve(root) === sourceDirectory)
  ));

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
    const fingerprint = getProcessingFingerprint(category as 'image' | 'audio', settings);
    const metadataVersion = getMetadataProcessingVersion(category as 'image' | 'audio');
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
      pending.push({
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
        classificationRelevant: !cached || cached.hash !== hash || cached.path !== currentPath ||
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

  try {
    broadcastProgress({
      status: 'scanning',
      libraryPath: targetRoots[0],
      libraryPaths: targetRoots,
      scannedCount: 0,
      indexedCount: 0,
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
      await walkDirectory(root, root, scope);
    }

    throwIfCancelled();

    if (!scopes.some((scope) => scope.rootSucceeded)) {
      broadcastProgress({
        status: 'error',
        failedScopes: [...failures],
        scannedCount,
        indexedCount: 0,
        error: 'No library root could be enumerated',
        message: 'Scan failed: no library root could be enumerated.',
        elapsedMs: Date.now() - startTime,
      });
      return currentScanStatus;
    }

    // Versioned cache paths keep old thumbnails readable until the DB commit.
    for (const asset of pending) {
      throwIfCancelled();
      if (!fs.existsSync(asset.thumbnailPath!)) {
        fs.renameSync(asset.stagedThumbnailPath, asset.thumbnailPath!);
        createdFinalPaths.push(asset.thumbnailPath!);
      }
    }
    throwIfCancelled();

    const db = getDatabase();
    const beforeMembership = new Map((db.prepare('SELECT id, stack_id, stack_index FROM assets').all() as
      { id: string; stack_id: string | null; stack_index: number | null }[])
      .map((row) => [row.id, `${row.stack_id || ''}:${row.stack_index ?? ''}`]));
    const changedIds = new Set(pending.filter((asset) => asset.classificationRelevant).map((asset) => asset.id));
    let stackStats = { animationStacksCreated: 0, audioStacksCreated: 0 };
    db.transaction(() => {
      const refresh = db.prepare('UPDATE assets SET size = ?, mtime = ?, updated_at = ? WHERE id = ?');
      for (const asset of cacheRefreshes) refresh.run(asset.size, asset.mtime, Date.now(), asset.id);
      for (const asset of pending) upsertAsset(asset);
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

    broadcastProgress({ message: 'Running automatic asset classifiers...', scannedCount, indexedCount });
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

    const elapsedMs = Date.now() - startTime;
    const partial = failures.size > 0;
    broadcastProgress({
      status: 'completed',
      libraryPath: targetRoots[0],
      libraryPaths: targetRoots,
      scannedCount,
      indexedCount,
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
    }
    if (error instanceof ScanCancelledError || cancelRequested) {
      broadcastProgress({
        status: 'idle',
        libraryPath: targetRoots[0],
        libraryPaths: targetRoots,
        scannedCount,
        indexedCount: committed ? indexedCount : 0,
        currentFile: undefined,
        failedScopes: [...failures],
        error: undefined,
        message: committed
          ? 'Scan cancelled during automatic classification; indexed assets remain available.'
          : 'Scan cancelled.',
        elapsedMs: Date.now() - startTime,
      });
    } else {
      const message = error instanceof Error ? error.message : 'Unknown error';
      broadcastProgress({
        status: 'error',
        libraryPath: targetRoots[0],
        libraryPaths: targetRoots,
        scannedCount,
        indexedCount: committed ? indexedCount : 0,
        currentFile: undefined,
        failedScopes: [...failures],
        error: message,
        message: committed
          ? `Indexing completed, but automatic classification failed: ${message}`
          : `Scan failed: ${message}`,
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
