import crypto from 'node:crypto';
import path from 'node:path';

/** A source identity never depends on the configured library order or UI path. */
export function canonicalAssetId(absolutePath: string, archiveEntryPath?: string | null): string {
  const digest = crypto.createHash('sha256');
  const source = path.resolve(absolutePath);
  if (archiveEntryPath != null) {
    digest.update('zip\0').update(source).update('\0').update(archiveEntryPath);
    return `zip_${digest.digest('hex')}`;
  }
  digest.update('file\0').update(source);
  return `file_${digest.digest('hex')}`;
}

/** Stable suffix for roots with the same basename in a display namespace. */
export function sourceDisplaySuffix(sourceDirectory: string): string {
  return crypto.createHash('sha256').update(path.resolve(sourceDirectory)).digest('hex').slice(0, 10);
}
