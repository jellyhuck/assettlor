import sharp from 'sharp';
import {
  Asset,
  ClassifierCategory,
  ClassifierAssetResult,
  SpriteClassifierSettings,
  SpriteCategory,
} from '../../../shared/types.js';
import {
  getDatabase,
  updateAssetMetadata,
  removeAssetTagsBySource,
  addAssetTags,
} from '../../db/database.js';
import { processImageBuffer } from '../image.js';
import { Classifier, ClassifierStep, ClassifierStepContext } from './types.js';

export const DEFAULT_SPRITE_SETTINGS: SpriteClassifierSettings = {
  enabled: true,
  minConfidence: 0.5,
  enableVisualAnalysis: true,
  enablePathAnalysis: true,
  enableStackAnalysis: true,
  applySpriteTag: false,
};

export const SPRITE_TAXONOMY: Record<'character' | 'object' | 'texture' | 'background', string[]> = {
  character: [
    'hero', 'player', 'character', 'knight', 'enemy', 'monster', 'boss', 'npc',
    'creature', 'zombie', 'avatar', 'warrior', 'mage', 'rogue', 'goblin', 'skeleton',
    'demon', 'dragon', 'walk', 'run', 'idle', 'jump', 'attack', 'dead', 'hurt',
    'die', 'fall', 'climb', 'human', 'char',
  ],
  object: [
    'item', 'weapon', 'sword', 'shield', 'potion', 'coin', 'chest', 'prop',
    'icon', 'pickup', 'gem', 'bullet', 'key', 'crate', 'door', 'object',
    'box', 'flask', 'relic', 'artifact', 'loot', 'spin', 'pulse', 'collectible',
    'button', 'ui', 'heart', 'diamond', 'gold', 'silver', 'arrow', 'bow',
    'armor', 'helmet', 'wand', 'ring', 'scroll',
  ],
  texture: [
    'tile', 'tileset', 'tilemap', 'ground', 'floor', 'wall', 'brick', 'stone',
    'grass', 'dirt', 'pattern', 'seamless', 'texture', 'surface', 'rock', 'wood',
    'sand', 'water', 'terrain', 'road', 'pavement', 'moss', 'gravel', 'concrete',
  ],
  background: [
    'bg', 'background', 'backdrop', 'scenery', 'landscape', 'environment', 'sky',
    'mountains', 'stage', 'level', 'scene', 'horizon', 'clouds', 'forest',
    'dungeon', 'cave', 'space', 'stars', 'sunset', 'panorama', 'interior', 'exterior',
  ],
};

export interface SpriteIntermediateState {
  skipped: boolean;
  skipReason?: string;
  visualScores?: {
    character: number;
    object: number;
    texture: number;
    background: number;
  };
  lexicalScores?: {
    character: number;
    object: number;
    texture: number;
    background: number;
  };
  combinedScores?: {
    character: number;
    object: number;
    texture: number;
    background: number;
  };
  detectedCategory: SpriteCategory;
  confidence: number;
  tagsAdded: string[];
  error?: string;
}

function splitTokens(str: string): string[] {
  if (!str) return [];
  // Split on camelCase boundaries and delimiters
  const separated = str.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return separated
    .toLowerCase()
    .split(/[/\\_\-\.\s]+/)
    .filter((t) => t.length > 1);
}

/**
 * Step 1: Probe Image
 * Validates that asset is an image and buffer is present.
 */
const probeStep: ClassifierStep<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'probe-image',
  name: 'Validate Image Buffer',
  description: 'Confirms asset category is image and image buffer is loaded.',
  execute: ({ asset, buffer, intermediate }) => {
    if (asset.category !== 'image') {
      intermediate.skipped = true;
      intermediate.skipReason = `Asset category is "${asset.category}", expected "image"`;
      return false;
    }

    if (!buffer || buffer.length === 0) {
      intermediate.skipped = true;
      intermediate.skipReason = 'Image buffer is empty or could not be loaded';
      return false;
    }
  },
};

/**
 * Step 2: Visual Feature Extraction
 * Analyzes alpha transparency, dimensions, aspect ratio, trim bounds, and edge seamlessness.
 */
const visualStep: ClassifierStep<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'analyze-visual-features',
  name: 'Extract Visual Features',
  description: 'Computes alpha transparency ratio, trim bounding box, and edge seamlessness.',
  execute: async ({ asset, buffer, settings, intermediate }) => {
    if (!settings.enableVisualAnalysis) {
      intermediate.visualScores = {
        character: 0.25,
        object: 0.25,
        texture: 0.25,
        background: 0.25,
      };
      return;
    }

    if (!buffer) return;

    try {
      let sharpInstance: sharp.Sharp;
      const ext = (asset.extension || '').toLowerCase();

      if (ext === '.tga' || ext === '.bmp') {
        const proc = await processImageBuffer(buffer, ext);
        sharpInstance = sharp(proc.thumbnailBuffer);
      } else {
        sharpInstance = sharp(buffer);
      }

      const { data, info } = await sharpInstance
        .raw()
        .ensureAlpha()
        .toBuffer({ resolveWithObject: true });

      const width = info.width;
      const height = info.height;
      const totalPixels = width * height;

      if (totalPixels === 0) {
        intermediate.visualScores = { character: 0.25, object: 0.25, texture: 0.25, background: 0.25 };
        return;
      }

      let nonTransparentCount = 0;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4;
          const alpha = data[idx + 3];
          if (alpha > 20) {
            nonTransparentCount++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      const alphaRatio = nonTransparentCount / totalPixels;
      const trimmedW = nonTransparentCount > 0 ? maxX - minX + 1 : width;
      const trimmedH = nonTransparentCount > 0 ? maxY - minY + 1 : height;
      const trimmedAspect = trimmedH / (trimmedW || 1); // >1 tall, <1 wide
      const overallAspect = width / (height || 1); // >1 wide, <1 tall

      // Seamlessness test: compare top vs bottom row and left vs right column
      let tbDiffSum = 0;
      let lrDiffSum = 0;
      const rowBytes = width * 4;

      for (let x = 0; x < width; x++) {
        const topIdx = x * 4;
        const botIdx = (height - 1) * rowBytes + x * 4;
        for (let c = 0; c < 3; c++) {
          tbDiffSum += Math.abs(data[topIdx + c] - data[botIdx + c]);
        }
      }

      for (let y = 0; y < height; y++) {
        const leftIdx = y * rowBytes;
        const rightIdx = y * rowBytes + (width - 1) * 4;
        for (let c = 0; c < 3; c++) {
          lrDiffSum += Math.abs(data[leftIdx + c] - data[rightIdx + c]);
        }
      }

      const meanTbDiff = tbDiffSum / (width * 3) / 255;
      const meanLrDiff = lrDiffSum / (height * 3) / 255;
      const meanEdgeDiff = (meanTbDiff + meanLrDiff) / 2;
      const edgeSeamlessness = Math.max(0, 1 - meanEdgeDiff * 2.5);

      const isPowerOfTwo = (width & (width - 1)) === 0 && (height & (height - 1)) === 0;
      const isSquare = Math.abs(width - height) <= Math.max(2, Math.floor(width * 0.05));

      // Calculate category visual scores
      let bgScore = 0.05;
      let texScore = 0.05;
      let charScore = 0.05;
      let objScore = 0.05;

      // 1. Background heuristics (opaque, wide, large)
      if (alphaRatio >= 0.95) {
        bgScore += 0.40;
        if (overallAspect >= 1.25) bgScore += 0.30;
        if (width >= 256 || height >= 200) bgScore += 0.25;
      }

      // 2. Texture heuristics (square, power-of-two, seamless edges, mostly opaque)
      if (alphaRatio >= 0.75) {
        if (isSquare) texScore += 0.30;
        if (isPowerOfTwo) texScore += 0.25;
        if (edgeSeamlessness >= 0.70) texScore += 0.30;
        texScore += 0.10;
      }

      // 3. Character heuristics (transparent background, tall vertical silhouette)
      if (alphaRatio >= 0.05 && alphaRatio <= 0.85) {
        charScore += 0.40;
        if (trimmedAspect >= 1.15) {
          charScore += 0.40;
          if (trimmedAspect <= 3.5) charScore += 0.15;
        }
      }

      // 4. Object heuristics (transparent background, compact/square or horizontal silhouette)
      if (alphaRatio >= 0.05 && alphaRatio <= 0.85) {
        objScore += 0.40;
        if (trimmedAspect < 1.15) {
          objScore += 0.35;
          if (width <= 128 && height <= 128) objScore += 0.20;
        }
      }

      intermediate.visualScores = {
        character: Math.min(1, charScore),
        object: Math.min(1, objScore),
        texture: Math.min(1, texScore),
        background: Math.min(1, bgScore),
      };
    } catch {
      intermediate.visualScores = {
        character: 0.25,
        object: 0.25,
        texture: 0.25,
        background: 0.25,
      };
    }
  },
};

/**
 * Step 3: Lexical & Context Signals
 * Tokenizes path, filename, and checks animation stack associations.
 */
const lexicalStep: ClassifierStep<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'analyze-context-signals',
  name: 'Extract Context & Lexical Signals',
  description: 'Parses directory and filename tokens and evaluates animation stack patterns.',
  execute: ({ asset, settings, intermediate }) => {
    if (!settings.enablePathAnalysis && !settings.enableStackAnalysis) {
      intermediate.lexicalScores = {
        character: 0.25,
        object: 0.25,
        texture: 0.25,
        background: 0.25,
      };
      return;
    }

    const tokens = new Set<string>();

    if (settings.enablePathAnalysis) {
      splitTokens(asset.path).forEach((t) => tokens.add(t));
      splitTokens(asset.name).forEach((t) => tokens.add(t));
    }

    // Stack context
    let stackName = '';
    if (settings.enableStackAnalysis && asset.stackId) {
      const db = getDatabase();
      const row = db.prepare('SELECT name FROM stacks WHERE id = ?').get(asset.stackId) as { name: string } | undefined;
      if (row?.name) {
        stackName = row.name;
        splitTokens(row.name).forEach((t) => tokens.add(t));
      }
    }

    const scores: Record<'character' | 'object' | 'texture' | 'background', number> = {
      character: 0.05,
      object: 0.05,
      texture: 0.05,
      background: 0.05,
    };

    // Match taxonomy keywords
    for (const cat of ['character', 'object', 'texture', 'background'] as const) {
      const keywords = SPRITE_TAXONOMY[cat];
      let matches = 0;
      for (const kw of keywords) {
        if (tokens.has(kw)) {
          matches++;
        }
      }
      if (matches > 0) {
        scores[cat] += Math.min(0.9, matches * 0.45);
      }
    }

    // Animation stack pattern boosts
    if (stackName) {
      const lowerStack = stackName.toLowerCase();
      if (/walk|run|idle|jump|attack|hero|knight|player/.test(lowerStack)) {
        scores.character += 0.40;
      }
      if (/spin|coin|item|rotate|pulse/.test(lowerStack)) {
        scores.object += 0.40;
      }
    }

    intermediate.lexicalScores = {
      character: Math.min(1, scores.character),
      object: Math.min(1, scores.object),
      texture: Math.min(1, scores.texture),
      background: Math.min(1, scores.background),
    };
  },
};

/**
 * Step 4: Scoring Matrix
 * Combines visual and lexical probabilities, normalizes confidence, and determines final category.
 */
const scoringStep: ClassifierStep<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'score-classification',
  name: 'Score & Arbitrate Classification',
  description: 'Combines multi-factor signals and determines sprite category with confidence.',
  execute: ({ settings, intermediate }) => {
    const vis = intermediate.visualScores || { character: 0.25, object: 0.25, texture: 0.25, background: 0.25 };
    const lex = intermediate.lexicalScores || { character: 0.25, object: 0.25, texture: 0.25, background: 0.25 };

    const useVis = settings.enableVisualAnalysis;
    const useLex = settings.enablePathAnalysis || settings.enableStackAnalysis;

    let wVis = 0.55;
    let wLex = 0.45;

    if (useVis && !useLex) {
      wVis = 1.0;
      wLex = 0.0;
    } else if (!useVis && useLex) {
      wVis = 0.0;
      wLex = 1.0;
    } else if (!useVis && !useLex) {
      intermediate.detectedCategory = 'unclassified';
      intermediate.confidence = 0;
      return;
    }

    const categories = ['character', 'object', 'texture', 'background'] as const;
    const combined: Record<'character' | 'object' | 'texture' | 'background', number> = {
      character: wVis * vis.character + wLex * lex.character,
      object: wVis * vis.object + wLex * lex.object,
      texture: wVis * vis.texture + wLex * lex.texture,
      background: wVis * vis.background + wLex * lex.background,
    };

    intermediate.combinedScores = combined;

    const totalScore = combined.character + combined.object + combined.texture + combined.background;
    let bestCat: SpriteCategory = 'unclassified';
    let maxConf = 0;

    for (const cat of categories) {
      const conf = totalScore > 0 ? combined[cat] / totalScore : 0;
      if (conf > maxConf) {
        maxConf = conf;
        bestCat = cat;
      }
    }

    if (maxConf >= settings.minConfidence) {
      intermediate.detectedCategory = bestCat;
      intermediate.confidence = Math.round(maxConf * 100) / 100;
    } else {
      intermediate.detectedCategory = 'unclassified';
      intermediate.confidence = Math.round(maxConf * 100) / 100;
    }
  },
};

/**
 * Step 5: Apply Metadata
 * Updates SQLite metadata for the classified asset; labels are accessible via sprite: keyword without tag assignments.
 */
const persistStep: ClassifierStep<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'apply-metadata-tags',
  name: 'Persist Metadata',
  description: 'Saves spriteType and spriteConfidence to index.db.',
  execute: ({ asset, settings, intermediate }) => {
    const category = intermediate.detectedCategory;
    const confidence = intermediate.confidence;

    // Update JSON metadata in assets table
    updateAssetMetadata(asset.id, {
      spriteType: category,
      spriteConfidence: confidence,
    });

    // Remove old tags previously generated by this classifier if any
    removeAssetTagsBySource(asset.id, 'classifier:sprite');

    // Dedicated filter sprite: handles queries; do not add tags unless explicitly asked
    const tagsToAdd: { tag: string; source: string }[] = [];
    if (settings.applySpriteTag === true && category !== 'unclassified') {
      const prefix = settings.spriteTagPrefix !== undefined ? settings.spriteTagPrefix : 'sprite:';
      tagsToAdd.push({ tag: `${prefix}${category}`, source: 'classifier:sprite' });
    }

    if (tagsToAdd.length > 0) {
      addAssetTags(asset.id, tagsToAdd);
      intermediate.tagsAdded = tagsToAdd.map((t) => t.tag);
    } else {
      intermediate.tagsAdded = [];
    }
  },
};

export const spriteClassifier: Classifier<SpriteClassifierSettings, SpriteIntermediateState> = {
  id: 'sprite',
  name: 'Sprite Classifier',
  description: 'Classifies 2D game images into character, object, texture, background, or unclassified.',
  category: 'image' as ClassifierCategory,
  defaultSettings: DEFAULT_SPRITE_SETTINGS,
  steps: [probeStep, visualStep, lexicalStep, scoringStep, persistStep],
  createIntermediateState: () => ({
    skipped: false,
    detectedCategory: 'unclassified',
    confidence: 0,
    tagsAdded: [],
  }),
  createAssetResult: (asset: Asset, intermediate: SpriteIntermediateState): ClassifierAssetResult => {
    if (intermediate.skipped) {
      return {
        assetId: asset.id,
        assetPath: asset.path,
        success: false,
        error: intermediate.skipReason || 'Asset skipped',
        tagsAdded: [],
      };
    }

    return {
      assetId: asset.id,
      assetPath: asset.path,
      success: true,
      result: {
        spriteType: intermediate.detectedCategory,
        confidence: intermediate.confidence,
        combinedScores: intermediate.combinedScores,
      },
      tagsAdded: intermediate.tagsAdded,
    };
  },
};
