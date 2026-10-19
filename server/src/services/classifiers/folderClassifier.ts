import path from 'path';
import type {
  Asset,
  ClassifierAssetResult,
  FolderClassifierSettings,
} from '../../../../shared/types.js';
import {
  Classifier,
  ClassifierStep,
} from './types.js';
import {
  finalizeClassifierAsset,
} from '../../db/database.js';
import { sourceRelativePackPath } from './packClassifier.js';

export const DEFAULT_FOLDER_SETTINGS: FolderClassifierSettings = {
  enabled: true,
  includeArchiveFolders: true,
};

export interface FolderIntermediateState {
  skipped: boolean;
  skipReason?: string;
  relativePath?: string;
  folders?: string[];
  error?: string;
}

/**
 * Library-relative path without the scanner's display prefix. Archive entries
 * keep the virtual form `dir/Archive.zip#/inner/file.ext`.
 */
export function sourceRelativeAssetPath(asset: Asset): string {
  if (!asset.isArchiveEntry) return sourceRelativePackPath(asset);
  const [displayArchive, ...inner] = asset.path.replace(/\\/g, '/').split('#/');
  const entryPath = (asset.archiveEntryPath || inner.join('#/')).replace(/\\/g, '/');
  let archivePath = displayArchive;
  const archiveDisk = asset.archivePath || asset.absolutePath;
  if (asset.sourceDirectory && archiveDisk && path.isAbsolute(archiveDisk)) {
    const relative = path.relative(asset.sourceDirectory, archiveDisk);
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      archivePath = relative.split(path.sep).join('/');
    }
  }
  return `${archivePath}#/${entryPath}`;
}

function directorySegments(filePath: string): string[] {
  const dir = path.posix.dirname(filePath);
  if (!dir || dir === '.' || dir === '/') return [];
  return dir.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
}

/**
 * Subfolders of a library-relative path, outermost first. A name that repeats
 * at several depths is listed once, keeping its first spelling; the archive
 * file itself is not a folder.
 */
export function extractSubfolders(
  relativePath: string,
  settings: Partial<FolderClassifierSettings> = {}
): string[] {
  const normalized = relativePath.replace(/\\/g, '/');
  const separator = normalized.indexOf('#/');
  const segments = separator < 0
    ? directorySegments(normalized)
    : [
      ...directorySegments(normalized.slice(0, separator)),
      ...(settings.includeArchiveFolders === false ? [] : directorySegments(normalized.slice(separator + 2))),
    ];
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const segment of segments) {
    const key = segment.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    folders.push(segment);
  }
  return folders;
}

/**
 * Step 1: Resolve Relative Path
 * Computes the asset path relative to its library root.
 */
const resolveStep: ClassifierStep<FolderClassifierSettings, FolderIntermediateState> = {
  id: 'resolve-path',
  name: 'Resolve Relative Path',
  description: 'Computes the asset path relative to its library root, including ZIP interior paths.',
  execute: ({ asset, intermediate }) => {
    const relativePath = sourceRelativeAssetPath(asset);
    if (!relativePath) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Could not determine the library-relative path';
      return false;
    }
    intermediate.relativePath = relativePath;
  },
};

/**
 * Step 2: Extract Subfolders
 * Splits the relative path into its subfolder names.
 */
const extractStep: ClassifierStep<FolderClassifierSettings, FolderIntermediateState> = {
  id: 'extract-folders',
  name: 'Extract Subfolders',
  description: 'Lists every subfolder between the library root and the asset.',
  execute: ({ settings, intermediate }) => {
    const folders = extractSubfolders(intermediate.relativePath || '', settings);
    if (folders.length === 0) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Asset is located at the library root without a subfolder';
      return false;
    }
    intermediate.folders = folders;
  },
};

/**
 * Step 3: Persist Metadata
 * Saves the subfolders into asset metadata; the folder: filter queries them.
 */
const persistStep: ClassifierStep<FolderClassifierSettings, FolderIntermediateState> = {
  id: 'persist-metadata',
  name: 'Persist Metadata',
  description: 'Saves the subfolder list to asset metadata.',
  // The engine finalizes even when an earlier step concludes without a result.
  execute: () => undefined,
};

export const folderClassifier: Classifier<FolderClassifierSettings, FolderIntermediateState> = {
  id: 'folder',
  name: 'Folder Classifier',
  description: 'Classifies assets by the subfolders in their library-relative path.',
  category: 'general',
  defaultSettings: DEFAULT_FOLDER_SETTINGS,
  requiresBuffer: false,
  steps: [resolveStep, extractStep, persistStep],
  createIntermediateState: () => ({
    skipped: false,
  }),
  createAssetResult: (asset: Asset, intermediate: FolderIntermediateState): ClassifierAssetResult => {
    if (intermediate.folders?.length) {
      return {
        assetId: asset.id,
        assetPath: asset.path,
        success: true,
        outcome: 'classified',
        result: {
          folders: intermediate.folders,
          relativePath: intermediate.relativePath,
        },
      };
    }

    return {
      assetId: asset.id,
      assetPath: asset.path,
      success: false,
      outcome: 'no-result',
      error: intermediate.error || intermediate.skipReason || 'No subfolders found',
    };
  },
  finalizeAsset: (asset, intermediate, _settings, result) => {
    const classified = result.outcome === 'classified' && Boolean(intermediate.folders?.length);
    return finalizeClassifierAsset(
      asset, 'folder', classified ? 'classified' : 'no-result',
      classified ? { folders: intermediate.folders } : {}
    );
  },
};
