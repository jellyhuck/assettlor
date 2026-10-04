import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  initDatabase,
  getDatabase,
  upsertAsset,
  removeDeletedAssets,
  getAssetByPath,
} from '../db/database.js';
import { isSupportedImageExtension, processImageFile } from './image.js';
import { isSupportedAudioExtension, processAudioFile } from './audio.js';
import { isArchiveFile, inspectZipArchive } from './archive.js';
import { runStackingEngine } from './stacker.js';
import { ScanProgressEvent, ScanStatusType } from '../../shared/types.js';
import { config } from '../config.js';

type SseListener = (event: ScanProgressEvent) => void;
const sseListeners = new Set<SseListener>();

let currentScanStatus: ScanProgressEvent = {
  status: 'idle',
  libraryPath: '',
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

export async function scanLibrary(targetDirectory: string): Promise<ScanProgressEvent> {
  if (currentScanStatus.status === 'scanning') {
    return currentScanStatus;
  }

  cancelRequested = false;
  const startTime = Date.now();
  const libraryPath = path.resolve(targetDirectory);

  if (!fs.existsSync(libraryPath)) {
    throw new Error(`Directory does not exist: ${libraryPath}`);
  }

  // Initialize DB and thumbnail cache inside library directory
  initDatabase(libraryPath);
  const thumbnailsDir = path.join(libraryPath, config.cacheDirName, 'thumbnails');

  broadcastProgress({
    status: 'scanning',
    libraryPath,
    scannedCount: 0,
    indexedCount: 0,
    message: 'Starting scan...',
    startTime,
    elapsedMs: 0,
  });

  const activePaths = new Set<string>();
  let scannedCount = 0;
  let indexedCount = 0;

  async function walkDir(currentDir: string): Promise<void> {
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
      const relativePath = path.relative(libraryPath, fullPath);

      if (entry.isDirectory()) {
        await walkDir(fullPath);
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

              if (existing && existing.hash === item.hash && fs.existsSync(thumbDiskPath)) {
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

          const assetId = `file_${Buffer.from(relativePath).toString('base64url')}`;
          const thumbFilename = `${assetId}.webp`;
          const thumbDiskPath = path.join(thumbnailsDir, thumbFilename);

          const existing = getAssetByPath(relativePath);
          if (existing && existing.hash === quickHash && fs.existsSync(thumbDiskPath)) {
            // Asset unchanged
            continue;
          }

          // Generate tags from directory hierarchy
          const tags: { tag: string; source: string }[] = [];
          const dirSegments = path.dirname(relativePath).split(path.sep).filter(Boolean);
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
    await walkDir(libraryPath);

    if (cancelRequested) {
      broadcastProgress({
        status: 'idle',
        message: 'Scan cancelled.',
      });
      return currentScanStatus;
    }

    broadcastProgress({
      message: 'Cleaning up deleted assets...',
    });

    // Remove deleted files
    removeDeletedAssets(activePaths);

    broadcastProgress({
      message: 'Grouping animation stacks and audio variations...',
    });

    // Run Stacking Engine
    const stackStats = runStackingEngine();

    const elapsedMs = Date.now() - startTime;
    broadcastProgress({
      status: 'completed',
      scannedCount,
      indexedCount,
      message: `Completed in ${(elapsedMs / 1000).toFixed(1)}s: ${indexedCount} assets indexed (${stackStats.animationStacksCreated} animation stacks, ${stackStats.audioStacksCreated} audio variations).`,
      elapsedMs,
    });
  } catch (err: any) {
    console.error('Scan failed:', err);
    broadcastProgress({
      status: 'error',
      error: err?.message || 'Scan failed',
      message: `Scan failed: ${err?.message || 'Unknown error'}`,
    });
  }

  return currentScanStatus;
}
