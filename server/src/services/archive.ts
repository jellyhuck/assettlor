import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import zlib from 'zlib';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import { isSupportedImageExtension, processImageBuffer } from './image.js';
import { isSupportedAudioExtension, processAudioBuffer } from './audio.js';
import { canonicalAssetId } from './assetIdentity.js';
import { IMAGE_THUMBNAIL_SPEC } from './processingFingerprint.js';
import type { AssetMetadata, AssetCategory } from '../../../shared/types.js';

// Archives are read through a file descriptor: only the central directory and
// the entry being processed are held in memory, so the archive size is not
// bounded. These limits bound each inflation and the work one archive causes.
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxEntries: 250_000,
  maxEntryCompressedBytes: 128 * 1024 * 1024,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 8 * 1024 * 1024 * 1024,
  maxCompressionRatio: 1_000,
});

export type ArchiveResourceLimits = typeof DEFAULT_ARCHIVE_LIMITS;

export class ArchiveResourceLimitError extends Error {
  readonly code = 'ARCHIVE_RESOURCE_LIMIT';

  constructor(message: string) {
    super(message);
    this.name = 'ArchiveResourceLimitError';
  }
}

export class ArchiveCancelledError extends Error {
  constructor() {
    super('Archive processing cancelled');
    this.name = 'ArchiveCancelledError';
  }
}

export function isArchiveFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.zip';
}

export interface ArchiveInventoryEntry {
  id: string;
  virtualPath: string; // e.g. "packs/RetroPack.zip#/sprites/hero_01.png"
  entryName: string;
  filename: string;
  extension: string;
  category: AssetCategory;
  size: number;
  compressedSize: number;
  mtime: number;
  hash: string;
  tags: { tag: string; source: string }[];
}

export interface ArchiveEntryItem extends ArchiveInventoryEntry {
  metadata: AssetMetadata;
  thumbnailBuffer: Buffer;
}

export interface ArchiveProcessOptions {
  isCancelled?: () => boolean;
  quality?: number;
}

export interface ArchiveInventory {
  entries: ArchiveInventoryEntry[];
  processEntry(
    entry: ArchiveInventoryEntry,
    options?: ArchiveProcessOptions
  ): Promise<ArchiveEntryItem>;
  /** Releases the archive's file descriptor. Safe to call more than once. */
  close(): void;
}

function assertWithinLimit(value: number, max: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ArchiveResourceLimitError(`${description} exceeds the archive limit (${max} bytes)`);
  }
}

function assertEntryWithinLimits(entryName: string, entry: Entry, limits: ArchiveResourceLimits): void {
  const { compressedSize, uncompressedSize: size } = entry;
  assertWithinLimit(compressedSize, limits.maxEntryCompressedBytes, `ZIP entry ${entryName} compressed size`);
  assertWithinLimit(size, limits.maxEntryUncompressedBytes, `ZIP entry ${entryName} uncompressed size`);
  if (size > 0 && (compressedSize === 0 || size / compressedSize > limits.maxCompressionRatio)) {
    throw new ArchiveResourceLimitError(`ZIP entry ${entryName} exceeds the compression ratio limit`);
  }
}

// Only these entries are ever read or inflated. Others, such as PSD sources,
// are never read and do not count against inflation limits.
function isIndexableMediaEntry(entryName: string): boolean {
  if (entryName.endsWith('/')) return false;
  const filename = path.posix.basename(entryName);
  if (entryName.includes('__MACOSX') || filename.startsWith('.')) return false;
  const extension = path.extname(filename).toLowerCase();
  return isSupportedImageExtension(extension) || isSupportedAudioExtension(extension);
}

const ARCHIVE_JUNK_ROOT_FILES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

interface ZipDirectory {
  zipfile: ZipFile;
  // Indexable media entries by name, in central-directory order.
  mediaEntries: Map<string, Entry>;
  // The single top-level directory holding every entry, if there is one.
  rootDirectory: string | null;
}

/**
 * Read the central directory and check the declared sizes of every entry
 * that may later be inflated. The caller owns the returned open ZipFile.
 */
async function readZipDirectory(
  archiveAbsolutePath: string,
  limits: ArchiveResourceLimits
): Promise<ZipDirectory> {
  // Names are decoded here rather than by yauzl, which rejects the whole
  // archive for a single absolute or ".." entry name.
  const zipfile = await yauzl.openPromise(archiveAbsolutePath, {
    lazyEntries: true,
    autoClose: false,
    decodeStrings: false,
    validateEntrySizes: true,
  });
  try {
    if (zipfile.entryCount > limits.maxEntries) {
      throw new ArchiveResourceLimitError(
        `ZIP entry count ${zipfile.entryCount} exceeds the archive limit (${limits.maxEntries})`
      );
    }

    const mediaEntries = new Map<string, Entry>();
    const roots = new Set<string>();
    let hasRootFile = false;
    let totalCompressedBytes = 0;
    let totalUncompressedBytes = 0;
    for await (const entry of zipfile.eachEntry()) {
      // Every declared entry must fit inside the file, inflated or not.
      totalCompressedBytes += entry.compressedSize;
      assertWithinLimit(totalCompressedBytes, zipfile.fileSize, 'ZIP total declared compressed size');

      const entryName = yauzl.getFileNameLowLevel(
        entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false
      );
      const segments = entryName.replace(/^(?:\.\/|\/)+/, '').split('/').filter(Boolean);
      if (segments.length > 0 && segments[0] !== '__MACOSX') {
        if (segments.length > 1 || entryName.endsWith('/')) {
          roots.add(segments[0]);
        } else if (!ARCHIVE_JUNK_ROOT_FILES.has(segments[0].toLowerCase())) {
          hasRootFile = true;
        }
      }

      if (!isIndexableMediaEntry(entryName) || yauzl.validateFileName(entryName) !== null) continue;
      if (mediaEntries.has(entryName)) {
        throw new Error(`ZIP contains duplicate asset entry: ${entryName}`);
      }
      assertEntryWithinLimits(entryName, entry, limits);
      totalUncompressedBytes += entry.uncompressedSize;
      assertWithinLimit(totalUncompressedBytes, limits.maxTotalUncompressedBytes, 'ZIP total declared uncompressed size');
      mediaEntries.set(entryName, entry);
    }

    const rootDirectory = !hasRootFile && roots.size === 1 ? [...roots][0] : null;
    return { zipfile, mediaEntries, rootDirectory };
  } catch (error) {
    zipfile.close();
    throw error;
  }
}

async function hashCompressedData(zipfile: ZipFile, entry: Entry): Promise<string> {
  const stream = await zipfile.openReadStreamPromise(entry, { decodeFileData: false });
  const hash = crypto.createHash('sha256');
  for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
  return hash.digest('hex');
}

async function readEntryData(zipfile: ZipFile, entry: Entry, entryName: string): Promise<Buffer> {
  const stream: Readable = await zipfile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    length += chunk.length;
    if (length > entry.uncompressedSize) {
      stream.destroy();
      break;
    }
    chunks.push(chunk);
  }
  if (length !== entry.uncompressedSize) {
    throw new Error(`ZIP entry ${entryName} size differs from its header`);
  }
  const buffer = Buffer.concat(chunks, length);
  if (zlib.crc32(buffer) !== entry.crc32) {
    throw new Error(`ZIP entry ${entryName} failed its CRC-32 check`);
  }
  return buffer;
}

function createEntryTags(
  archiveBaseName: string,
  entryName: string,
  extension: string,
  category: AssetCategory
): ArchiveInventoryEntry['tags'] {
  const tags: ArchiveInventoryEntry['tags'] = [
    { tag: archiveBaseName, source: 'archive' },
    { tag: extension.replace('.', ''), source: 'extension' },
    { tag: category, source: 'category' },
  ];

  const dirSegments = path.posix.dirname(entryName).split('/').filter(Boolean);
  for (const segment of dirSegments) {
    if (segment !== '.' && segment.length > 1) {
      tags.push({ tag: segment, source: 'folder' });
    }
  }
  return tags;
}

/**
 * Read ZIP headers and compressed-byte fingerprints without inflating media.
 * Process one selected entry at a time after the caller checks its cache, and
 * close the inventory when done. The legacy hashPrefix is only used for a
 * damaged entry whose compressed bytes cannot be read. Healthy entries remain
 * stable when a sibling changes.
 */
export async function openZipArchive(
  archiveAbsolutePath: string,
  relativeArchivePath: string,
  hashPrefix: string,
  limitOverrides: Partial<ArchiveResourceLimits> = {},
  isCancelled?: () => boolean
): Promise<ArchiveInventory> {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...limitOverrides };
  const { zipfile, mediaEntries } = await readZipDirectory(archiveAbsolutePath, limits);
  const archiveBaseName = path.parse(archiveAbsolutePath).name;
  const entries: ArchiveInventoryEntry[] = [];
  const entryByDescriptor = new Map<ArchiveInventoryEntry, Entry>();

  try {
    for (const [entryName, zipEntry] of mediaEntries) {
      if (isCancelled?.()) throw new ArchiveCancelledError();
      const filename = path.posix.basename(entryName);
      const extension = path.extname(filename).toLowerCase();
      const category: AssetCategory = isSupportedImageExtension(extension) ? 'image' : 'audio';
      const mtime = zipEntry.getLastModDate({ forceDosFormat: true }).getTime();
      let hash: string;
      try {
        const compressedHash = await hashCompressedData(zipfile, zipEntry);
        hash = crypto.createHash('sha256')
          .update(`${compressedHash}\0${zipEntry.uncompressedSize}`)
          .digest('hex');
      } catch {
        // A corrupt local header must not prevent healthy siblings from being
        // inventoried. The later per-entry extraction will report this failure.
        hash = crypto.createHash('sha256')
          .update(`unreadable\0${hashPrefix}\0${entryName}\0${zipEntry.crc32}`)
          .digest('hex');
      }

      const descriptor: ArchiveInventoryEntry = {
        id: canonicalAssetId(archiveAbsolutePath, entryName),
        virtualPath: `${relativeArchivePath}#/${entryName}`,
        entryName,
        filename,
        extension,
        category,
        size: zipEntry.uncompressedSize,
        compressedSize: zipEntry.compressedSize,
        mtime: Number.isFinite(mtime) ? mtime : 0,
        hash,
        tags: createEntryTags(archiveBaseName, entryName, extension, category),
      };
      entries.push(descriptor);
      entryByDescriptor.set(descriptor, zipEntry);
    }
  } catch (error) {
    zipfile.close();
    throw error;
  }

  return {
    entries,
    close: () => zipfile.close(),
    async processEntry(descriptor, options = {}) {
      const zipEntry = entryByDescriptor.get(descriptor);
      if (!zipEntry) throw new Error('ZIP entry is not part of this archive inventory');
      if (options.isCancelled?.()) throw new ArchiveCancelledError();

      const entryBuffer = await readEntryData(zipfile, zipEntry, descriptor.entryName);
      if (options.isCancelled?.()) throw new ArchiveCancelledError();

      const processed = descriptor.category === 'image'
        ? await processImageBuffer(
          entryBuffer,
          descriptor.extension,
          IMAGE_THUMBNAIL_SPEC.width,
          IMAGE_THUMBNAIL_SPEC.height,
          options.quality
        )
        : await processAudioBuffer(
          entryBuffer,
          descriptor.filename,
          descriptor.extension,
          options.quality
        );
      if (options.isCancelled?.()) throw new ArchiveCancelledError();

      return {
        ...descriptor,
        metadata: processed.metadata,
        thumbnailBuffer: processed.thumbnailBuffer,
      };
    },
  };
}

// Preserve the original helper for existing callers while allowing the scanner
// to use the inventory and avoid retaining every processed thumbnail.
export async function inspectZipArchive(
  archiveAbsolutePath: string,
  relativeArchivePath: string,
  hashPrefix: string
): Promise<ArchiveEntryItem[]> {
  const inventory = await openZipArchive(archiveAbsolutePath, relativeArchivePath, hashPrefix);
  const items: ArchiveEntryItem[] = [];
  try {
    for (const descriptor of inventory.entries) {
      try {
        items.push(await inventory.processEntry(descriptor));
      } catch (err) {
        console.warn(`Failed to process zip entry ${descriptor.entryName}:`, err);
      }
    }
  } finally {
    inventory.close();
  }
  return items;
}

// Previews, copies, and classifiers read entries one request at a time. Keep a
// few recently used directories open so a large archive's central directory is
// not re-read for every entry. Idle archives are closed to release their files.
const MAX_CACHED_DIRECTORIES = 4;
const CACHED_DIRECTORY_IDLE_MS = 30_000;

interface CachedDirectory {
  signature: string;
  directory: Promise<ZipDirectory>;
  users: number;
  evicted: boolean;
  idleTimer?: NodeJS.Timeout;
}

const directoryCache = new Map<string, CachedDirectory>();

function closeIfUnused(cached: CachedDirectory): void {
  if (!cached.evicted || cached.users > 0) return;
  cached.directory.then((directory) => directory.zipfile.close(), () => undefined);
}

function evictDirectory(archiveAbsolutePath: string, cached: CachedDirectory): void {
  if (directoryCache.get(archiveAbsolutePath) === cached) directoryCache.delete(archiveAbsolutePath);
  clearTimeout(cached.idleTimer);
  cached.evicted = true;
  closeIfUnused(cached);
}

async function withCachedDirectory<T>(
  archiveAbsolutePath: string,
  use: (directory: ZipDirectory) => T | Promise<T>
): Promise<T | null> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(archiveAbsolutePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
  // ctime and inode catch in-place rewrites that preserve size and mtime.
  const signature = `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;

  let cached = directoryCache.get(archiveAbsolutePath);
  if (cached && cached.signature !== signature) {
    evictDirectory(archiveAbsolutePath, cached);
    cached = undefined;
  }
  if (cached) {
    // Move to the most recently used position.
    directoryCache.delete(archiveAbsolutePath);
    directoryCache.set(archiveAbsolutePath, cached);
  } else {
    const created: CachedDirectory = {
      signature,
      directory: readZipDirectory(archiveAbsolutePath, DEFAULT_ARCHIVE_LIMITS),
      users: 0,
      evicted: false,
    };
    created.directory.catch(() => evictDirectory(archiveAbsolutePath, created));
    directoryCache.set(archiveAbsolutePath, created);
    for (const [oldestPath, oldest] of directoryCache) {
      if (directoryCache.size <= MAX_CACHED_DIRECTORIES) break;
      evictDirectory(oldestPath, oldest);
    }
    cached = created;
  }

  const current = cached;
  clearTimeout(current.idleTimer);
  current.users++;
  try {
    return await use(await current.directory);
  } finally {
    current.users--;
    if (current.users === 0 && !current.evicted) {
      current.idleTimer = setTimeout(
        () => evictDirectory(archiveAbsolutePath, current),
        CACHED_DIRECTORY_IDLE_MS
      ).unref();
    }
    closeIfUnused(current);
  }
}

/** Reads one indexable media entry. Returns null for a missing archive or entry. */
export async function getZipEntryBuffer(archiveAbsolutePath: string, internalPath: string): Promise<Buffer | null> {
  return withCachedDirectory(archiveAbsolutePath, ({ zipfile, mediaEntries }) => {
    const entry = mediaEntries.get(internalPath);
    return entry ? readEntryData(zipfile, entry, internalPath) : null;
  });
}

/**
 * Returns the single top-level directory that holds every entry of a ZIP,
 * ignoring OS metadata such as __MACOSX/ and .DS_Store. Returns null when the
 * archive is missing, empty, has root-level files, or has several roots.
 */
export async function getZipRootDirectory(archiveAbsolutePath: string): Promise<string | null> {
  return withCachedDirectory(archiveAbsolutePath, (directory) => directory.rootDirectory);
}
