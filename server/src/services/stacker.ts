import { createHash } from 'crypto';
import path from 'path';
import { getDatabase, isDatabaseInitialized, clearStacks, createStack, getAppSettings } from '../db/database.js';
import type { AppSettings } from '../../../shared/types.js';

interface AssetCandidate {
  id: string;
  name: string;
  path: string;
  absolutePath: string;
  category: string;
  extension: string;
  isArchiveEntry: number;
  archivePath: string | null;
  archiveEntryPath: string | null;
  metadata: string | null;
}

type PlannedStack = Parameters<typeof createStack>[0];
type StackingSettings = Pick<AppSettings, 'autoStackAnimations' | 'autoStackAudio' | 'defaultFps'>;

interface PatternGroup {
  identity: string;
  type: 'animation' | 'audio_variation';
  baseName: string;
  items: { asset: AssetCandidate; sequenceIndex: number }[];
}

// Sparse sequences are intentional: frames 1 and 3 form a stack with indices 0 and 1.
const NUMBERED_PATTERN = /^(.*?)(?:[-_ .]|frame|f|#)*?(\d{1,4})$/i;
const LETTER_PATTERN = /^(.*?)[-_ .]([a-zA-Z])$/i;

function humanizeName(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function sourceContext(asset: AssetCandidate): string[] {
  if (asset.isArchiveEntry) {
    const separator = asset.absolutePath.indexOf('#/');
    const archivePath = asset.archivePath || (separator >= 0 ? asset.absolutePath.slice(0, separator) : asset.absolutePath);
    const entryPath = asset.archiveEntryPath || (separator >= 0 ? asset.absolutePath.slice(separator + 2) : asset.path);
    return ['archive', path.resolve(archivePath), path.posix.dirname(entryPath)];
  }

  // The actual parent directory survives display-prefix and configured-root changes.
  return ['file', path.dirname(path.resolve(asset.absolutePath))];
}

function mediaContext(asset: AssetCandidate): (string | number | null)[] {
  let metadata: Record<string, unknown> = {};
  if (asset.metadata) {
    try {
      const parsed: unknown = JSON.parse(asset.metadata);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        metadata = parsed as Record<string, unknown>;
      }
    } catch {
      // Legacy metadata can be malformed; extension remains a usable grouping key.
    }
  }
  const positiveNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

  if (asset.category === 'image') {
    return [asset.extension.toLowerCase(), positiveNumber(metadata.width), positiveNumber(metadata.height)];
  }
  return [asset.extension.toLowerCase(), positiveNumber(metadata.sampleRate), positiveNumber(metadata.numberOfChannels)];
}

function addToGroup(
  groups: Map<string, PatternGroup>,
  asset: AssetCandidate,
  type: PatternGroup['type'],
  baseName: string,
  sequenceIndex: number
): void {
  if (!baseName) return;
  // JSON tuple encoding keeps fields unambiguous even when paths contain separators.
  const identity = JSON.stringify([type, sourceContext(asset), mediaContext(asset), baseName]);
  let group = groups.get(identity);
  if (!group) {
    group = { identity, type, baseName, items: [] };
    groups.set(identity, group);
  }
  group.items.push({ asset, sequenceIndex });
}

function planStacks(assets: AssetCandidate[], settings: StackingSettings): PlannedStack[] {
  const groups = new Map<string, PatternGroup>();
  for (const asset of assets) {
    const stem = path.parse(asset.name).name;
    if (asset.category === 'image' && settings.autoStackAnimations) {
      const match = stem.match(NUMBERED_PATTERN);
      if (!match) continue;
      addToGroup(groups, asset, 'animation', match[1].toLowerCase().replace(/[-_ .]+$/, ''), Number(match[2]));
    } else if (asset.category === 'audio' && settings.autoStackAudio) {
      const numbered = stem.match(NUMBERED_PATTERN);
      const lettered = stem.match(LETTER_PATTERN);
      if (numbered) {
        addToGroup(groups, asset, 'audio_variation', numbered[1].toLowerCase().replace(/[-_ .]+$/, ''), Number(numbered[2]));
      } else if (lettered) {
        addToGroup(groups, asset, 'audio_variation', lettered[1].toLowerCase().replace(/[-_ .]+$/, ''), lettered[2].toLowerCase().charCodeAt(0));
      }
    }
  }

  const planned: PlannedStack[] = [];
  for (const group of groups.values()) {
    if (group.items.length < 2) continue;
    // Duplicate frame numbers are alternative renditions, not extra frames.
    if (new Set(group.items.map((item) => item.sequenceIndex)).size !== group.items.length) continue;

    const items = [...group.items].sort((a, b) => a.sequenceIndex - b.sequenceIndex);
    const representative = items[0].asset;
    const rawBase = path.parse(representative.name).name.replace(/[-_ .]*(\d+|[a-zA-Z])$/, '');
    const digest = createHash('sha256').update(group.identity).digest('hex');
    planned.push({
      id: `stack_${group.type === 'animation' ? 'anim' : 'audio'}_${digest}`,
      name: humanizeName(rawBase || group.baseName),
      type: group.type,
      itemCount: items.length,
      representativeAssetId: representative.id,
      metadata: group.type === 'animation'
        ? {
          detectedBaseName: group.baseName,
          frameRange: [items[0].sequenceIndex, items[items.length - 1].sequenceIndex],
          fps: settings.defaultFps,
        }
        : { detectedBaseName: group.baseName, variationCount: items.length },
      assetIdsWithIndex: items.map((item, index) => ({ assetId: item.asset.id, index })),
    });
  }
  return planned;
}

export function runStackingEngine(): { animationStacksCreated: number; audioStacksCreated: number } {
  if (!isDatabaseInitialized()) {
    return { animationStacksCreated: 0, audioStacksCreated: 0 };
  }

  const db = getDatabase();
  const settings = getAppSettings();
  const assets = db.prepare(`
    SELECT id, name, path, absolute_path AS absolutePath, category, extension,
      is_archive_entry AS isArchiveEntry, archive_path AS archivePath,
      archive_entry_path AS archiveEntryPath, metadata
    FROM assets
    ORDER BY path ASC
  `).all() as AssetCandidate[];
  const planned = planStacks(assets, settings);

  // Both helpers use nested savepoints, so any failure restores the old catalog.
  db.transaction(() => {
    clearStacks();
    for (const stack of planned) createStack(stack);
  })();

  return {
    animationStacksCreated: planned.filter((stack) => stack.type === 'animation').length,
    audioStacksCreated: planned.filter((stack) => stack.type === 'audio_variation').length,
  };
}
