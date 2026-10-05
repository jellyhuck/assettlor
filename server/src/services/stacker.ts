import path from 'path';
import { getDatabase, isDatabaseInitialized, clearStacks, createStack } from '../db/database.js';

interface AssetCandidate {
  id: string;
  name: string;
  path: string;
  category: string;
  extension: string;
  archivePath: string | null;
}

// Regex to extract base name and sequence/variant identifier
const NUMBERED_PATTERN = /^(.*?)(?:[-_ .]|frame|f|#)*?(\d{1,4})$/i;
const LETTER_PATTERN = /^(.*?)[-_ .]([a-zA-Z])$/i;

function humanizeName(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function runStackingEngine(): { animationStacksCreated: number; audioStacksCreated: number } {
  if (!isDatabaseInitialized()) {
    return { animationStacksCreated: 0, audioStacksCreated: 0 };
  }
  const db = getDatabase();

  // Reset current stack associations
  clearStacks();

  const allAssets = db.prepare(`
    SELECT id, name, path, category, extension, archive_path
    FROM assets
    ORDER BY path ASC
  `).all() as AssetCandidate[];

  // Group by (directory context + category)
  const dirGroups = new Map<string, AssetCandidate[]>();

  for (const asset of allAssets) {
    const dir = path.dirname(asset.path);
    const key = `${asset.category}:::${asset.archivePath || ''}:::${dir}`;
    let list = dirGroups.get(key);
    if (!list) {
      list = [];
      dirGroups.set(key, list);
    }
    list.push(asset);
  }

  let animationCount = 0;
  let audioCount = 0;

  for (const [groupKey, assets] of dirGroups.entries()) {
    if (assets.length < 2) continue;
    const [category] = groupKey.split(':::');

    if (category === 'image') {
      // Look for animation sequences
      const patternGroups = new Map<string, { asset: AssetCandidate; frameNum: number }[]>();

      for (const asset of assets) {
        const nameWithoutExt = path.parse(asset.name).name;
        const match = nameWithoutExt.match(NUMBERED_PATTERN);

        if (match) {
          const baseName = match[1].toLowerCase().replace(/[-_ .]+$/, '');
          const frameNum = parseInt(match[2], 10);
          if (baseName.length > 0) {
            let pGroup = patternGroups.get(baseName);
            if (!pGroup) {
              pGroup = [];
              patternGroups.set(baseName, pGroup);
            }
            pGroup.push({ asset, frameNum });
          }
        }
      }

      for (const [baseName, items] of patternGroups.entries()) {
        if (items.length >= 2) {
          // Sort frames by number
          items.sort((a, b) => a.frameNum - b.frameNum);

          const stackId = `stack_anim_${Buffer.from(`${groupKey}_${baseName}`).toString('base64url').slice(0, 32)}`;
          const representative = items[0].asset;
          const rawBase = path.parse(representative.name).name.replace(/[-_ .]*\d+$/, '');
          const displayName = humanizeName(rawBase || baseName);

          createStack({
            id: stackId,
            name: displayName,
            type: 'animation',
            itemCount: items.length,
            representativeAssetId: representative.id,
            metadata: {
              detectedBaseName: baseName,
              frameRange: [items[0].frameNum, items[items.length - 1].frameNum],
              fps: 12,
            },
            assetIdsWithIndex: items.map((it, idx) => ({
              assetId: it.asset.id,
              index: idx,
            })),
          });

          animationCount++;
        }
      }
    } else if (category === 'audio') {
      // Look for audio variations (both numbers and letters)
      const variationGroups = new Map<string, { asset: AssetCandidate; index: number }[]>();

      for (const asset of assets) {
        const nameWithoutExt = path.parse(asset.name).name;
        const numMatch = nameWithoutExt.match(NUMBERED_PATTERN);
        const letterMatch = nameWithoutExt.match(LETTER_PATTERN);

        if (numMatch) {
          const baseName = numMatch[1].toLowerCase().replace(/[-_ .]+$/, '');
          const idx = parseInt(numMatch[2], 10);
          if (baseName.length > 0) {
            let vGroup = variationGroups.get(baseName);
            if (!vGroup) {
              vGroup = [];
              variationGroups.set(baseName, vGroup);
            }
            vGroup.push({ asset, index: idx });
          }
        } else if (letterMatch) {
          const baseName = letterMatch[1].toLowerCase().replace(/[-_ .]+$/, '');
          const charCode = letterMatch[2].toLowerCase().charCodeAt(0);
          if (baseName.length > 0) {
            let vGroup = variationGroups.get(baseName);
            if (!vGroup) {
              vGroup = [];
              variationGroups.set(baseName, vGroup);
            }
            vGroup.push({ asset, index: charCode });
          }
        }
      }

      for (const [baseName, items] of variationGroups.entries()) {
        if (items.length >= 2) {
          items.sort((a, b) => a.index - b.index);

          const stackId = `stack_audio_${Buffer.from(`${groupKey}_${baseName}`).toString('base64url').slice(0, 32)}`;
          const representative = items[0].asset;
          const rawBase = path.parse(representative.name).name.replace(/[-_ .]*(\d+|[a-zA-Z])$/, '');
          const displayName = humanizeName(rawBase || baseName);

          createStack({
            id: stackId,
            name: displayName,
            type: 'audio_variation',
            itemCount: items.length,
            representativeAssetId: representative.id,
            metadata: {
              detectedBaseName: baseName,
              variationCount: items.length,
            },
            assetIdsWithIndex: items.map((it, idx) => ({
              assetId: it.asset.id,
              index: idx,
            })),
          });

          audioCount++;
        }
      }
    }
  }

  return {
    animationStacksCreated: animationCount,
    audioStacksCreated: audioCount,
  };
}
