import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  initDatabase,
  getDatabase,
  isDatabaseInitialized,
  getCurrentLibraryPath,
  getAppSettings,
  upsertAsset,
  removeDeletedAssets,
  removeDeletedAssetsForSourceDirectory,
  getAssetByPath,
  getAssetById,
  getThumbnailsDir,
} from '../db/database.js';
import { isSupportedImageExtension, processImageFile } from './image.js';
import { isSupportedAudioExtension, processAudioFile } from './audio.js';
import { isArchiveFile, inspectZipArchive } from './archive.js';
import { runStackingEngine } from './stacker.js';
import { getAllClassifiers, getEffectiveClassifierSettings, runClassifier } from './classifiers/index.js';
import type { ScanProgressEvent, ScanStatusType } from '../../../shared/types.js';
import { config, getDataDir } from '../config.js';
import { canonicalAssetId, sourceDisplaySuffix } from './assetIdentity.js';

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
  // Send current state immediately on connect
  listener(currentScanStatus);
  return () => {
    sseListeners.delete(listener);
  };
}

export function getCurrentScanStatus(): ScanProgressEvent {
  return currentScanStatus;
}

export function requestCancelScan(): void {
  cancelRequested = true;
}

function broadcastProgress(update: Partial<ScanProgressEvent>): void {
  currentScanStatus = {
    ...currentScanStatus,
    ...update,
  };
  for (const listener of sseListeners) {
    try {
      listener(currentScanStatus);
    } catch {
      // ignore
    }
  }
}

function getFileHashFast(size: number, mtime: number): string {
  return crypto.createHash('md5').update(`${size}:${mtime}`).digest('hex');
}

export interface ScanOptions {
  fullRescan?: boolean;
  rescanDirectories?: string[];
}

export async function scanLibrary(
  targetDirectoriesInput?: string | string[],
  options?: ScanOptions
): Promise<ScanProgressEvent> {
  if (currentScanStatus.status === 'scanning') {
    return currentScanStatus;
  }

  cancelRequested = false;
  const startTime = Date.now();

  let targetDirs: string[] = [];
  if (typeof targetDirectoriesInput === 'string') {
    const trimmed = targetDirectoriesInput.trim();
    if (trimmed) targetDirs = [trimmed];
  } else if (Array.isArray(targetDirectoriesInput)) {
    targetDirs = targetDirectoriesInput.map((p) => String(p).trim()).filter(Boolean);
  } else {
    try {
      const settings = getAppSettings();
      targetDirs = settings.libraryPaths && settings.libraryPaths.length > 0
        ? settings.libraryPaths
        : (settings.libraryPath ? [settings.libraryPath] : []);
    } catch {
      targetDirs = [];
    }
  }

  if (targetDirs.length === 0) {
    throw new Error('No target directory specified to scan');
  }

  const resolvedDirs = targetDirs.map((d) => path.resolve(d));

  // If a single directory was provided, throw if it doesn't exist
  if (targetDirs.length === 1 && !fs.existsSync(resolvedDirs[0])) {
    throw new Error(`Directory does not exist: ${resolvedDirs[0]}`);
  }

  const existingDirs = resolvedDirs.filter((d) => {
    const exists = fs.existsSync(d);
    if (!exists) {
      console.warn(`Directory does not exist, skipping: ${d}`);
    }
    return exists;
  });

  if (existingDirs.length === 0) {
    throw new Error(`Directory does not exist: ${resolvedDirs[0]}`);
  }

  // Ensure DB and thumbnail cache are initialized inside configured data_dir
  if (!isDatabaseInitialized()) {
    initDatabase(getDataDir());
  }

  const settings = getAppSettings();
  const allConfigured = settings.libraryPaths && settings.libraryPaths.length > 0
    ? settings.libraryPaths
    : (settings.libraryPath ? [settings.libraryPath] : []);
  const resolvedConfigured = allConfigured.map((d) => path.resolve(d));

  const thumbnailsDir = getThumbnailsDir();
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }

  broadcastProgress({
    status: 'scanning',
    libraryPath: existingDirs[0] || '',
    libraryPaths: existingDirs,
    scannedCount: 0,
    indexedCount: 0,
    message: existingDirs.length > 1
      ? `Starting scan of ${existingDirs.length} libraries...`
      : 'Starting scan...',
    startTime,
    elapsedMs: 0,
  });

  // Calculate unique prefixes for multiple directories based on full configured list
  const prefixSourceDirs = resolvedConfigured.length > 0 && existingDirs.every((d) => resolvedConfigured.includes(d))
    ? resolvedConfigured
    : resolvedDirs;
  const dirPrefixes = new Map<string, string>();
  if (prefixSourceDirs.length > 1) {
    const baseCounts = new Map<string, number>();
    for (const d of prefixSourceDirs) {
      const base = path.basename(d);
      baseCounts.set(base, (baseCounts.get(base) || 0) + 1);
    }
    for (const d of prefixSourceDirs) {
      const base = path.basename(d);
      if ((baseCounts.get(base) || 0) > 1) {
        dirPrefixes.set(d, `${base} (${sourceDisplaySuffix(d)})`);
      } else {
        dirPrefixes.set(d, base);
      }
    }
  } else {
    dirPrefixes.set(prefixSourceDirs[0], '');
  }

  const activePaths = new Set<string>();
  let scannedCount = 0;
  let indexedCount = 0;

  async function walkDir(currentDir: string, rootDir: string, prefix: string): Promise<void> {
    if (cancelRequested) return;

    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(currentDir, { withFileTypes: true });
    } catch (err) {
      console.warn(`Cannot read directory ${currentDir}:`, err);
      return;
    }

    for (const entry of entries) {
      if (cancelRequested) break;

      // Ignore cache dir, dotfiles, node_modules, git
      if (entry.name === config.cacheDirName || entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const innerRelative = path.relative(rootDir, fullPath);
      const relativePath = prefix
        ? path.posix.join(prefix, innerRelative.split(path.sep).join('/'))
        : innerRelative.split(path.sep).join('/');

      if (entry.isDirectory()) {
        await walkDir(fullPath, rootDir, prefix);
      } else if (entry.isFile()) {
        scannedCount++;
        const ext = path.extname(entry.name).toLowerCase();
        const isImg = isSupportedImageExtension(ext);
        const isAud = isSupportedAudioExtension(ext);
        const isZip = isArchiveFile(fullPath);

        if (!isImg && !isAud && !isZip) {
          continue;
        }

        let stats: fs.Stats;
        try {
          stats = await fs.promises.stat(fullPath);
        } catch {
          continue;
        }

        const quickHash = getFileHashFast(stats.size, stats.mtimeMs);

        if (scannedCount % 10 === 0) {
          broadcastProgress({
            scannedCount,
            indexedCount,
            currentFile: relativePath,
            elapsedMs: Date.now() - startTime,
            message: `Scanned ${scannedCount} files...`,
          });
        }

        if (isZip) {
          // Virtual archive inspection
          try {
            const archiveEntries = await inspectZipArchive(fullPath, relativePath, quickHash);
            for (const item of archiveEntries) {
              activePaths.add(item.virtualPath);

              // Check if already indexed with same hash
              const existing = getAssetByPath(item.virtualPath);
              const thumbFilename = `${item.id}.webp`;
              const thumbDiskPath = path.join(thumbnailsDir, thumbFilename);

              if (
                !options?.fullRescan && existing &&
                existing.hash === item.hash &&
                existing.absolutePath === fullPath &&
                existing.archivePath === fullPath &&
                existing.sourceDirectory === rootDir &&
                fs.existsSync(thumbDiskPath) &&
                (item.category !== 'audio' || existing.metadata?.audioThumbnailVersion === 4)
              ) {
                // Asset unchanged!
                continue;
              }

              // Write thumbnail to disk
              await fs.promises.writeFile(thumbDiskPath, item.thumbnailBuffer);

              upsertAsset({
                id: item.id,
                path: item.virtualPath,
                absolutePath: fullPath,
                name: item.filename,
                extension: item.extension,
                category: item.category,
                size: item.size,
                mtime: item.mtime,
                hash: item.hash,
                isArchiveEntry: true,
                archivePath: fullPath,
                archiveEntryPath: item.entryName,
                sourceDirectory: rootDir,
                thumbnailPath: thumbDiskPath,
                metadata: item.metadata,
                tags: item.tags,
              });

              indexedCount++;
            }
          } catch (err) {
            console.warn(`Failed inspecting zip archive ${relativePath}:`, err);
          }
        } else {
          // Regular image or audio file
          activePaths.add(relativePath);

          const assetId = canonicalAssetId(fullPath);
          const thumbFilename = `${assetId}.webp`;
          const thumbDiskPath = path.join(thumbnailsDir, thumbFilename);

          const existing = getAssetById(assetId);
          if (
            !options?.fullRescan && existing &&
            existing.path === relativePath &&
            existing.hash === quickHash &&
            existing.absolutePath === fullPath &&
            existing.sourceDirectory === rootDir &&
            fs.existsSync(thumbDiskPath) &&
            (!isAud || existing.metadata?.audioThumbnailVersion === 4)
          ) {
            // Asset unchanged
            continue;
          }

          // Generate tags from directory hierarchy
          const tags: { tag: string; source: string }[] = [];
          const dirSegments = path.dirname(relativePath).split('/').filter(Boolean);
          for (const seg of dirSegments) {
            if (seg !== '.' && seg.length > 0) {
              tags.push({ tag: seg, source: 'folder' });
            }
          }
          tags.push({ tag: ext.replace('.', ''), source: 'extension' });
          tags.push({ tag: isImg ? 'image' : 'audio', source: 'category' });

          // Keyword heuristics
          const lowerName = entry.name.toLowerCase();
          if (lowerName.includes('walk') || lowerName.includes('run') || lowerName.includes('attack') || lowerName.includes('anim')) {
            tags.push({ tag: 'animated', source: 'auto' });
          }
          if (lowerName.includes('ui') || lowerName.includes('button') || lowerName.includes('hud') || lowerName.includes('icon')) {
            tags.push({ tag: 'ui', source: 'auto' });
          }
          if (lowerName.includes('pixel') || lowerName.includes('tile')) {
            tags.push({ tag: 'pixel-art', source: 'auto' });
          }

          try {
            if (isImg) {
              const res = await processImageFile(fullPath);
              if (res.metadata.width && res.metadata.width <= 64 && res.metadata.height && res.metadata.height <= 64) {
                tags.push({ tag: 'pixel-art', source: 'auto' });
              }
              await fs.promises.writeFile(thumbDiskPath, res.thumbnailBuffer);

              upsertAsset({
                id: assetId,
                path: relativePath,
                absolutePath: fullPath,
                name: entry.name,
                extension: ext,
                category: 'image',
                size: stats.size,
                mtime: stats.mtimeMs,
                hash: quickHash,
                isArchiveEntry: false,
                sourceDirectory: rootDir,
                thumbnailPath: thumbDiskPath,
                metadata: res.metadata,
                tags,
              });
            } else {
              const res = await processAudioFile(fullPath);
              await fs.promises.writeFile(thumbDiskPath, res.thumbnailBuffer);

              upsertAsset({
                id: assetId,
                path: relativePath,
                absolutePath: fullPath,
                name: entry.name,
                extension: ext,
                category: 'audio',
                size: stats.size,
                mtime: stats.mtimeMs,
                hash: quickHash,
                isArchiveEntry: false,
                sourceDirectory: rootDir,
                thumbnailPath: thumbDiskPath,
                metadata: res.metadata,
                tags,
              });
            }

            indexedCount++;
          } catch (err) {
            console.warn(`Error indexing file ${relativePath}:`, err);
          }
        }
      }
    }
  }

  try {
    for (let i = 0; i < existingDirs.length; i++) {
      if (cancelRequested) break;
      const dir = existingDirs[i];
      const prefix = dirPrefixes.get(dir) || '';
      if (existingDirs.length > 1) {
        broadcastProgress({
          message: `Scanning library ${i + 1} of ${existingDirs.length}: ${path.basename(dir)}...`,
          elapsedMs: Date.now() - startTime,
        });
      }
      await walkDir(dir, dir, prefix);
    }

    if (cancelRequested) {
      broadcastProgress({
        status: 'idle',
        libraryPath: existingDirs[0] || '',
        libraryPaths: existingDirs,
        message: 'Scan cancelled.',
      });
      return currentScanStatus;
    }

    broadcastProgress({
      message: 'Cleaning up deleted assets...',
    });

    // Remove deleted files
    const isPartialScan = existingDirs.length < resolvedConfigured.length && resolvedConfigured.length > 1;
    if (isPartialScan) {
      for (const dir of existingDirs) {
        removeDeletedAssetsForSourceDirectory(dir, activePaths);
      }
    } else {
      removeDeletedAssets(activePaths);
    }

    broadcastProgress({
      message: 'Grouping animation stacks and audio variations...',
    });

    // Run Stacking Engine
    const stackStats = runStackingEngine();

    // Run Automatic Classifiers
    broadcastProgress({
      message: 'Running automatic asset classifiers...',
    });

    const classifiers = getAllClassifiers();
    let totalClassified = 0;

    for (const classifier of classifiers) {
      if (cancelRequested) break;
      const settings = getEffectiveClassifierSettings(classifier) as { enabled?: boolean };
      if (settings.enabled !== false) {
        try {
          const runRes = await runClassifier(classifier, {
            targetType: 'all',
            onProgress: (p) => {
              broadcastProgress({
                currentFile: p.currentAsset,
                message: `${classifier.name} [${p.stepName}]: ${p.processedCount + 1}/${p.totalTargeted}`,
              });
            },
          });
          totalClassified += runRes.classifiedCount;
        } catch (err) {
          console.warn(`Automatic classifier ${classifier.id} note:`, err);
        }
      }
    }

    const elapsedMs = Date.now() - startTime;
    broadcastProgress({
      status: 'completed',
      libraryPath: existingDirs[0] || '',
      libraryPaths: existingDirs,
      scannedCount,
      indexedCount,
      message: `Completed in ${(elapsedMs / 1000).toFixed(1)}s: ${indexedCount} assets indexed (${stackStats.animationStacksCreated} animation stacks, ${stackStats.audioStacksCreated} audio variations${totalClassified > 0 ? `, ${totalClassified} classified` : ''}).`,
      elapsedMs,
    });
  } catch (err: any) {
    console.error('Scan failed:', err);
    broadcastProgress({
      status: 'error',
      libraryPath: existingDirs[0] || '',
      libraryPaths: existingDirs,
      error: err?.message || 'Scan failed',
      message: `Scan failed: ${err?.message || 'Unknown error'}`,
    });
  }

  return currentScanStatus;
}
