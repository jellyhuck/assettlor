import path from 'path';
import {
  Asset,
  ClassifierAssetResult,
  PackClassifierSettings,
} from '../../../shared/types.js';
import {
  Classifier,
  ClassifierStep,
} from './types.js';
import {
  updateAssetMetadata,
  addAssetTags,
  removeAssetTagsBySource,
} from '../../db/database.js';

export const DEFAULT_PACK_SETTINGS: PackClassifierSettings = {
  enabled: true,
  inferFromArchive: true,
  inferFromDirectory: true,
  directoryStrategy: 'top',
  directoryDepth: 1,
  cleanSeparators: true,
  stripVersionSuffix: true,
  stripAffixes: false,
  caseConvention: 'as-is',
  applyTag: true,
  tagPrefix: 'pack:',
  targetArchives: [],
  targetDirectories: [],
};

export interface PackIntermediateState {
  skipped: boolean;
  skipReason?: string;
  source?: 'archive' | 'directory';
  rawName?: string;
  packName?: string;
  tagsAdded: string[];
  error?: string;
}

export function extractArchiveBaseName(archivePathOrVirtual: string): string {
  if (!archivePathOrVirtual) return '';
  let archivePath = archivePathOrVirtual;
  if (archivePath.includes('#/')) {
    archivePath = archivePath.split('#/')[0];
  }
  const base = path.basename(archivePath);
  const ext = path.extname(base);
  return ext ? base.slice(0, -ext.length) : base;
}

export function extractDirectoryCandidate(
  assetPath: string,
  strategy: 'top' | 'enclosing' | 'pattern' = 'top',
  depth: number = 1
): string | null {
  if (!assetPath) return null;
  const normalized = assetPath.replace(/\\/g, '/');
  // If it's a virtual path inside an archive, directory-based extraction does not apply
  if (normalized.includes('#/')) return null;

  const dir = path.dirname(normalized);
  if (!dir || dir === '.') return null;

  const segments = dir.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  if (strategy === 'enclosing') {
    return segments[segments.length - 1];
  }

  if (strategy === 'pattern') {
    // Look for segment indicating a pack, bundle, set, collection, or assets
    const packKeywords = ['pack', 'bundle', 'set', 'collection', 'assets'];
    // Prefer non-generic segment (e.g. "FantasyPack" or "HeroSet")
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i].toLowerCase();
      // If segment contains keyword but isn't just a generic plural folder like "packs" or "assets"
      if (packKeywords.some((kw) => seg.includes(kw)) && seg !== 'packs' && seg !== 'assets') {
        return segments[i];
      }
    }
    // If not found, check if depth 1 is generic container like "packs", and depth 2 exists
    if ((segments[0].toLowerCase() === 'packs' || segments[0].toLowerCase() === 'assets') && segments.length > 1) {
      return segments[1];
    }
    return segments[0];
  }

  // Strategy 'top' with configurable depth (1-indexed)
  const targetIndex = Math.max(0, Math.min((depth || 1) - 1, segments.length - 1));
  return segments[targetIndex];
}

export function normalizePackName(
  rawName: string,
  settings: Partial<PackClassifierSettings> = {}
): string {
  if (!rawName) return '';
  let str = rawName.trim();

  // 1. Strip version suffixes (e.g. _v1.0, -v2, .v3, _1.0.0, -beta1)
  if (settings.stripVersionSuffix !== false) {
    str = str.replace(/[-_ .]+v?\d+(?:\.\d+)*(?:[-_ .]?(?:alpha|beta|rc|build|release)\d*)?$/i, '');
  }

  // 2. Strip affixes if enabled (e.g. trailing "Pack", "AssetPack", "Bundle")
  if (settings.stripAffixes) {
    str = str.replace(/[-_ ]*(?:asset[-_ ]?pack|pack|bundle|collection|assets)[-_ ]*$/i, '');
    str = str.replace(/^[-_ ]*(?:pack|bundle)[-_ ]*/i, '');
  }

  // 3. Clean separators (convert _ and - to spaces, collapse multiple spaces)
  if (settings.cleanSeparators !== false) {
    str = str.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
  }

  str = str.trim();

  // 4. Case convention
  const casing = settings.caseConvention || 'as-is';
  if (casing === 'lower') {
    str = str.toLowerCase();
  } else if (casing === 'upper') {
    str = str.toUpperCase();
  } else if (casing === 'title') {
    str = str.replace(/\b([a-zA-Z0-9])/g, (c) => c.toUpperCase());
  }

  return str;
}

/**
 * Step 1: Probe Source
 * Inspects asset origin (archive vs filesystem directory) and verifies against filter settings.
 */
const probeStep: ClassifierStep<PackClassifierSettings, PackIntermediateState> = {
  id: 'probe-source',
  name: 'Inspect Asset Scope',
  description: 'Determines if asset originates from an archive or qualified directory.',
  execute: ({ asset, settings, intermediate }) => {
    if (asset.isArchiveEntry) {
      if (settings.inferFromArchive === false) {
        intermediate.skipped = true;
        intermediate.skipReason = 'Archive pack inference is disabled in settings';
        return false;
      }

      if (settings.targetArchives && settings.targetArchives.length > 0) {
        const rawArchive = extractArchiveBaseName(asset.archivePath || asset.path).toLowerCase();
        const fullArchive = (asset.archivePath || asset.path).toLowerCase();
        const matches = settings.targetArchives.some((t) => {
          const target = t.trim().toLowerCase();
          return (
            rawArchive === target ||
            fullArchive.endsWith(target) ||
            fullArchive.includes(target)
          );
        });
        if (!matches) {
          intermediate.skipped = true;
          intermediate.skipReason = `Archive does not match configured targetArchives filter`;
          return false;
        }
      }
    } else {
      // Disk file
      if (settings.inferFromDirectory === false) {
        intermediate.skipped = true;
        intermediate.skipReason = 'Directory pack inference is disabled in settings';
        return false;
      }

      const dir = path.dirname(asset.path).replace(/\\/g, '/');
      if (!dir || dir === '.') {
        intermediate.skipped = true;
        intermediate.skipReason = 'Asset is located at the root level without an enclosing directory';
        return false;
      }

      if (settings.targetDirectories && settings.targetDirectories.length > 0) {
        const normalizedDir = dir.toLowerCase();
        const segments = normalizedDir.split('/').filter(Boolean);
        const matches = settings.targetDirectories.some((t) => {
          const target = t.trim().toLowerCase().replace(/^\/+|\/+$/g, '');
          return (
            normalizedDir === target ||
            normalizedDir.startsWith(`${target}/`) ||
            normalizedDir.endsWith(`/${target}`) ||
            segments.includes(target)
          );
        });
        if (!matches) {
          intermediate.skipped = true;
          intermediate.skipReason = 'Directory does not match configured targetDirectories filter';
          return false;
        }
      }
    }
  },
};

/**
 * Step 2: Extract Pack Candidate
 * Extracts candidate pack name from archive name or directory structure.
 */
const extractStep: ClassifierStep<PackClassifierSettings, PackIntermediateState> = {
  id: 'extract-name',
  name: 'Extract Pack Candidate',
  description: 'Extracts candidate pack name from archive name or directory hierarchy.',
  execute: ({ asset, settings, intermediate }) => {
    if (asset.isArchiveEntry) {
      const raw = extractArchiveBaseName(asset.archivePath || asset.path);
      if (!raw) {
        intermediate.skipped = true;
        intermediate.skipReason = 'Could not determine archive base name';
        return false;
      }
      intermediate.rawName = raw;
      intermediate.source = 'archive';
    } else {
      const raw = extractDirectoryCandidate(
        asset.path,
        settings.directoryStrategy,
        settings.directoryDepth
      );
      if (!raw) {
        intermediate.skipped = true;
        intermediate.skipReason = 'Could not determine directory pack candidate';
        return false;
      }
      intermediate.rawName = raw;
      intermediate.source = 'directory';
    }
  },
};

/**
 * Step 3: Normalize & Clean Name
 * Formats separators, strips versions and affixes, and formats casing.
 */
const normalizeStep: ClassifierStep<PackClassifierSettings, PackIntermediateState> = {
  id: 'normalize-name',
  name: 'Normalize & Clean Name',
  description: 'Formats separators, strips version suffixes/affixes, and applies casing.',
  execute: ({ settings, intermediate }) => {
    if (!intermediate.rawName) {
      intermediate.skipped = true;
      intermediate.skipReason = 'No raw candidate name available to normalize';
      return false;
    }

    const normalized = normalizePackName(intermediate.rawName, settings);
    if (!normalized) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Normalized pack name is empty';
      return false;
    }

    intermediate.packName = normalized;
  },
};

/**
 * Step 4: Persist Metadata & Tags
 * Saves pack name into asset metadata and index.db tags.
 */
const persistStep: ClassifierStep<PackClassifierSettings, PackIntermediateState> = {
  id: 'persist-metadata',
  name: 'Persist Metadata & Tags',
  description: 'Saves pack name to asset metadata and updates database tags.',
  execute: ({ asset, settings, intermediate }) => {
    if (!intermediate.packName) {
      return;
    }

    // Persist pack name into asset metadata
    updateAssetMetadata(asset.id, {
      pack: intermediate.packName,
    });

    // Remove old tags previously generated by pack classifier
    removeAssetTagsBySource(asset.id, 'classifier:pack');

    if (settings.applyTag !== false) {
      const prefix = settings.tagPrefix !== undefined ? settings.tagPrefix : 'pack:';
      const tagName = `${prefix}${intermediate.packName}`;
      addAssetTags(asset.id, [{ tag: tagName, source: 'classifier:pack' }]);
      intermediate.tagsAdded = [tagName];
    } else {
      intermediate.tagsAdded = [];
    }
  },
};

export const packClassifier: Classifier<PackClassifierSettings, PackIntermediateState> = {
  id: 'pack',
  name: 'Pack Classifier',
  description: 'Identifies and attributes asset pack membership based on archive name or directory structure.',
  category: 'general',
  defaultSettings: DEFAULT_PACK_SETTINGS,
  steps: [probeStep, extractStep, normalizeStep, persistStep],
  createIntermediateState: () => ({
    skipped: false,
    tagsAdded: [],
  }),
  createAssetResult: (asset: Asset, intermediate: PackIntermediateState): ClassifierAssetResult => {
    if (intermediate.packName) {
      return {
        assetId: asset.id,
        assetPath: asset.path,
        success: true,
        result: {
          pack: intermediate.packName,
          source: intermediate.source,
          rawName: intermediate.rawName,
        },
        tagsAdded: intermediate.tagsAdded,
      };
    }

    return {
      assetId: asset.id,
      assetPath: asset.path,
      success: false,
      error: intermediate.error || intermediate.skipReason || 'Could not determine asset pack',
      tagsAdded: [],
    };
  },
};
