import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import { isSupportedImageExtension, processImageBuffer } from './image.js';
import { isSupportedAudioExtension, processAudioBuffer, getAudioMimeType } from './audio.js';
import { AssetMetadata, AssetCategory } from '../../shared/types.js';

export function isArchiveFile(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.zip';
}

export interface ArchiveEntryItem {
  id: string;
  virtualPath: string; // e.g. "packs/RetroPack.zip#/sprites/hero_01.png"
  entryName: string;
  filename: string;
  extension: string;
  category: AssetCategory;
  size: number;
  mtime: number;
  hash: string;
  metadata: AssetMetadata;
  thumbnailBuffer: Buffer;
  tags: { tag: string; source: string }[];
}

export async function inspectZipArchive(
  archiveAbsolutePath: string,
  relativeArchivePath: string,
  hashPrefix: string
): Promise<ArchiveEntryItem[]> {
  const archiveBaseName = path.parse(archiveAbsolutePath).name;
  const zip = new AdmZip(archiveAbsolutePath);
  const entries = zip.getEntries();
  const items: ArchiveEntryItem[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.isDirectory) continue;

    // Filter hidden files like __MACOSX or .DS_Store
    if (entry.entryName.includes('__MACOSX') || entry.name.startsWith('.')) continue;

    const ext = path.extname(entry.name).toLowerCase();
    const isImg = isSupportedImageExtension(ext);
    const isAud = isSupportedAudioExtension(ext);

    if (!isImg && !isAud) continue;

    const category: AssetCategory = isImg ? 'image' : 'audio';
    const virtualPath = `${relativeArchivePath}#/${entry.entryName}`;
    const entryBuffer = entry.getData();
    const entrySize = entry.header.size || entryBuffer.length;
    const entryMtime = entry.header.time ? entry.header.time.getTime() : Date.now();

    // Unique deterministic id
    const entryId = `zip_${Buffer.from(virtualPath).toString('base64url')}`;

    let metadata: AssetMetadata = {};
    let thumbnailBuffer: Buffer;

    if (isImg) {
      try {
        const res = await processImageBuffer(entryBuffer, ext);
        metadata = res.metadata;
        thumbnailBuffer = res.thumbnailBuffer;
      } catch (err) {
        console.warn(`Failed to process zip image entry ${entry.entryName}:`, err);
        continue;
      }
    } else {
      try {
        const res = await processAudioBuffer(entryBuffer, entry.name, ext);
        metadata = res.metadata;
        thumbnailBuffer = res.thumbnailBuffer;
      } catch (err) {
        console.warn(`Failed to process zip audio entry ${entry.entryName}:`, err);
        continue;
      }
    }

    // Auto-tags: archive name, internal folders, extension, category
    const tags: { tag: string; source: string }[] = [];
    tags.push({ tag: archiveBaseName, source: 'archive' });
    tags.push({ tag: ext.replace('.', ''), source: 'extension' });
    tags.push({ tag: category, source: 'category' });

    // Internal path segments
    const dirSegments = path.dirname(entry.entryName).split(/[\\/]/).filter(Boolean);
    for (const seg of dirSegments) {
      if (seg !== '.' && seg.length > 1) {
        tags.push({ tag: seg, source: 'folder' });
      }
    }

    items.push({
      id: entryId,
      virtualPath,
      entryName: entry.entryName,
      filename: entry.name,
      extension: ext,
      category,
      size: entrySize,
      mtime: entryMtime,
      hash: `${hashPrefix}:${entry.entryName}:${entrySize}`,
      metadata,
      thumbnailBuffer,
      tags,
    });
  }

  return items;
}

export function getZipEntryBuffer(archiveAbsolutePath: string, internalPath: string): Buffer | null {
  if (!fs.existsSync(archiveAbsolutePath)) return null;
  const zip = new AdmZip(archiveAbsolutePath);
  const entry = zip.getEntry(internalPath);
  if (!entry) return null;
  return entry.getData();
}
