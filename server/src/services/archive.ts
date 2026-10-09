import AdmZip from 'adm-zip';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { isSupportedImageExtension, processImageBuffer } from './image.js';
import { isSupportedAudioExtension, processAudioBuffer } from './audio.js';
import { canonicalAssetId } from './assetIdentity.js';
import { IMAGE_THUMBNAIL_SPEC } from './processingFingerprint.js';
import type { AssetMetadata, AssetCategory } from '../../../shared/types.js';

type ZipEntry = ReturnType<AdmZip['getEntries']>[number];

// AdmZip keeps the compressed archive in memory. These limits also bound each
// synchronous inflation before image/audio processing can begin.
export const DEFAULT_ARCHIVE_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxEntryCompressedBytes: 128 * 1024 * 1024,
  maxEntryUncompressedBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
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
}

function assertWithinLimit(value: number, max: number, description: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new ArchiveResourceLimitError(`${description} exceeds the archive limit (${max} bytes)`);
  }
}

function loadBoundedArchive(
  archiveAbsolutePath: string,
  limits: ArchiveResourceLimits
): ZipEntry[] {
  const archiveSize = fs.statSync(archiveAbsolutePath).size;
  assertWithinLimit(archiveSize, limits.maxArchiveBytes, 'ZIP file size');

  const entries = new AdmZip(archiveAbsolutePath).getEntries();
  if (entries.length > limits.maxEntries) {
    throw new ArchiveResourceLimitError(
      `ZIP entry count ${entries.length} exceeds the archive limit (${limits.maxEntries})`
    );
  }

  let totalCompressedBytes = 0;
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const { compressedSize, size } = entry.header;
    assertWithinLimit(compressedSize, limits.maxEntryCompressedBytes, `ZIP entry ${entry.entryName} compressed size`);
    assertWithinLimit(size, limits.maxEntryUncompressedBytes, `ZIP entry ${entry.entryName} uncompressed size`);

    totalCompressedBytes += compressedSize;
    totalUncompressedBytes += size;
    assertWithinLimit(totalCompressedBytes, archiveSize, 'ZIP total declared compressed size');
    assertWithinLimit(totalUncompressedBytes, limits.maxTotalUncompressedBytes, 'ZIP total declared uncompressed size');

    if (size > 0 && (compressedSize === 0 || size / compressedSize > limits.maxCompressionRatio)) {
      throw new ArchiveResourceLimitError(`ZIP entry ${entry.entryName} exceeds the compression ratio limit`);
    }
  }

  return entries;
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

  const dirSegments = path.posix.dirname(entryName.replace(/\\/g, '/')).split('/').filter(Boolean);
  for (const segment of dirSegments) {
    if (segment !== '.' && segment.length > 1) {
      tags.push({ tag: segment, source: 'folder' });
    }
  }
  return tags;
}

/**
 * Read ZIP headers and compressed-byte fingerprints without inflating media.
 * Process one selected entry at a time after the caller checks its cache.
 * The legacy hashPrefix is only used for a damaged entry whose compressed
 * bytes cannot be read. Healthy entries remain stable when a sibling changes.
 */
export function openZipArchive(
  archiveAbsolutePath: string,
  relativeArchivePath: string,
  hashPrefix: string,
  limitOverrides: Partial<ArchiveResourceLimits> = {}
): ArchiveInventory {
  const limits = { ...DEFAULT_ARCHIVE_LIMITS, ...limitOverrides };
  const zipEntries = loadBoundedArchive(archiveAbsolutePath, limits);
  const archiveBaseName = path.parse(archiveAbsolutePath).name;
  const entries: ArchiveInventoryEntry[] = [];
  const entryByDescriptor = new Map<ArchiveInventoryEntry, ZipEntry>();
  const seenPaths = new Set<string>();

  for (const zipEntry of zipEntries) {
    if (zipEntry.isDirectory) continue;
    if (zipEntry.entryName.includes('__MACOSX') || zipEntry.name.startsWith('.')) continue;

    const filename = zipEntry.name;
    const extension = path.extname(filename).toLowerCase();
    const isImage = isSupportedImageExtension(extension);
    const isAudio = isSupportedAudioExtension(extension);
    if (!isImage && !isAudio) continue;

    const entryName = zipEntry.entryName;
    const virtualPath = `${relativeArchivePath}#/${entryName}`;
    if (seenPaths.has(virtualPath)) {
      throw new Error(`ZIP contains duplicate asset entry: ${entryName}`);
    }
    seenPaths.add(virtualPath);

    const category: AssetCategory = isImage ? 'image' : 'audio';
    const mtime = zipEntry.header.time?.getTime();
    const effectiveMtime = Number.isFinite(mtime) ? mtime : 0;
    let hash: string;
    try {
      const compressedHash = crypto.createHash('sha256').update(zipEntry.getCompressedData()).digest('hex');
      hash = crypto.createHash('sha256')
        .update(`${compressedHash}\0${zipEntry.header.size}`)
        .digest('hex');
    } catch {
      // A corrupt local header must not prevent healthy siblings from being
      // inventoried. The later per-entry extraction will report this failure.
      hash = crypto.createHash('sha256')
        .update(`unreadable\0${hashPrefix}\0${entryName}\0${zipEntry.header.crc}`)
        .digest('hex');
    }

    const descriptor: ArchiveInventoryEntry = {
      id: canonicalAssetId(archiveAbsolutePath, entryName),
      virtualPath,
      entryName,
      filename,
      extension,
      category,
      size: zipEntry.header.size,
      compressedSize: zipEntry.header.compressedSize,
      mtime: effectiveMtime,
      hash,
      tags: createEntryTags(archiveBaseName, entryName, extension, category),
    };
    entries.push(descriptor);
    entryByDescriptor.set(descriptor, zipEntry);
  }

  return {
    entries,
    async processEntry(descriptor, options = {}) {
      const zipEntry = entryByDescriptor.get(descriptor);
      if (!zipEntry) throw new Error('ZIP entry is not part of this archive inventory');

      // Let the scan's cancellation request run before synchronous inflation.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (options.isCancelled?.()) throw new ArchiveCancelledError();

      const entryBuffer = zipEntry.getData();
      if (entryBuffer.length !== descriptor.size) {
        throw new Error(`ZIP entry ${descriptor.entryName} size differs from its header`);
      }

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
  const inventory = openZipArchive(archiveAbsolutePath, relativeArchivePath, hashPrefix);
  const items: ArchiveEntryItem[] = [];
  for (const descriptor of inventory.entries) {
    try {
      items.push(await inventory.processEntry(descriptor));
    } catch (err) {
      console.warn(`Failed to process zip entry ${descriptor.entryName}:`, err);
    }
  }
  return items;
}

export function getZipEntryBuffer(archiveAbsolutePath: string, internalPath: string): Buffer | null {
  if (!fs.existsSync(archiveAbsolutePath)) return null;
  const entries = loadBoundedArchive(archiveAbsolutePath, DEFAULT_ARCHIVE_LIMITS);
  const entry = entries.find((candidate) => candidate.entryName === internalPath);
  if (!entry || entry.isDirectory) return null;
  const buffer = entry.getData();
  if (buffer.length !== entry.header.size) {
    throw new Error(`ZIP entry ${internalPath} size differs from its header`);
  }
  return buffer;
}
