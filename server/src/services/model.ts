import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { ModelMetadata, ModelVector3 } from '../../../shared/types.js';
import {
  GltfError,
  MAX_GLTF_JSON_BYTES,
  accessorAt,
  accessorBounds,
  accessorCount,
  collectMeshInstances,
  indexValue,
  isJsonObject,
  objectList,
  parseGlb,
  stringList,
  transformPoint,
  type GltfDocument,
} from './gltf.js';
import { renderGltfThumbnail } from './modelRender.js';
import {
  DEFAULT_THUMBNAIL_QUALITY,
  MODEL_THUMBNAIL_SPEC,
  normalizeThumbnailQuality,
} from './processingFingerprint.js';

export const SUPPORTED_MODEL_EXTENSIONS = new Set(['.glb']);

export function isSupportedModelExtension(ext: string): boolean {
  return SUPPORTED_MODEL_EXTENSIONS.has(ext.toLowerCase());
}

/** Larger files are summarized from their JSON chunk without rendering. */
export const MAX_RENDERED_MODEL_BYTES = 256 * 1024 * 1024;

export interface ModelProcessingResult {
  metadata: ModelMetadata & { format?: string };
  thumbnailBuffer: Buffer;
}

export async function generateModelPlaceholder(quality = DEFAULT_THUMBNAIL_QUALITY): Promise<Buffer> {
  const { width, height } = MODEL_THUMBNAIL_SPEC;
  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#141424" />
          <stop offset="100%" stop-color="#1e1e36" />
        </linearGradient>
        <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="#818cf8" stop-opacity="0.18" />
          <stop offset="100%" stop-color="#818cf8" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrad)" />
      <circle cx="200" cy="190" r="130" fill="url(#glowGrad)" />
      <!-- Isometric cube -->
      <g stroke="#1e293b" stroke-width="5" stroke-linejoin="round">
        <polygon points="200,100 290,150 200,200 110,150" fill="#a5b4fc" />
        <polygon points="110,150 200,200 200,300 110,250" fill="#6366f1" />
        <polygon points="290,150 200,200 200,300 290,250" fill="#4338ca" />
      </g>
      <g stroke="#c7d2fe" stroke-width="2" stroke-dasharray="6 6" fill="none" opacity="0.5">
        <polyline points="110,250 200,200 290,250" />
      </g>
      <text x="24" y="${height - 20}" font-family="monospace" font-size="11" font-weight="700" fill="#a5b4fc">3D MODEL</text>
    </svg>
  `;
  return sharp(Buffer.from(svg))
    .webp({ quality: normalizeThumbnailQuality(quality) })
    .toBuffer();
}

function primitiveTriangles(mode: number, elementCount: number): number {
  if (mode === 4) return Math.floor(elementCount / 3);
  if (mode === 5 || mode === 6) return Math.max(0, elementCount - 2);
  return 0;
}

/**
 * Counts follow the default scene, so instanced meshes count once per use.
 * A document without a scene counts each mesh once.
 */
function summarizeGltf(doc: GltfDocument): ModelMetadata {
  const { json } = doc;
  const asset = isJsonObject(json.asset) ? json.asset : {};
  const meshes = objectList(json.meshes);
  const { instances } = collectMeshInstances(json);

  let primitiveCount = 0;
  let vertexCount = 0;
  let triangleCount = 0;
  let boundsMissing = false;
  const min: ModelVector3 = [Infinity, Infinity, Infinity];
  const max: ModelVector3 = [-Infinity, -Infinity, -Infinity];
  for (const instance of instances) {
    for (const primitive of objectList(meshes[instance.meshIndex].primitives)) {
      const attributes = isJsonObject(primitive.attributes) ? primitive.attributes : {};
      const positions = accessorAt(json, attributes.POSITION);
      const positionCount = accessorCount(positions) ?? 0;
      const indexCount = primitive.indices === undefined
        ? positionCount
        : accessorCount(accessorAt(json, primitive.indices)) ?? 0;
      const mode = primitive.mode === undefined ? 4 : indexValue(primitive.mode) ?? -1;
      primitiveCount++;
      vertexCount += positionCount;
      triangleCount += primitiveTriangles(mode, indexCount);

      const bounds = positions ? accessorBounds(positions) : undefined;
      if (!bounds) {
        if (positionCount > 0) boundsMissing = true;
        continue;
      }
      for (let corner = 0; corner < 8; corner++) {
        const point = transformPoint(
          instance.matrix,
          corner & 1 ? bounds.max[0] : bounds.min[0],
          corner & 2 ? bounds.max[1] : bounds.min[1],
          corner & 4 ? bounds.max[2] : bounds.min[2]
        );
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    }
  }

  const hasBounds = [...min, ...max].every(Number.isFinite);
  const generator = typeof asset.generator === 'string' ? asset.generator.slice(0, 200) : undefined;
  return {
    gltfVersion: typeof asset.version === 'string' ? asset.version.slice(0, 20) : undefined,
    generator: generator || undefined,
    sceneCount: objectList(json.scenes).length,
    nodeCount: objectList(json.nodes).length,
    meshCount: meshes.length,
    primitiveCount,
    vertexCount,
    triangleCount,
    materialCount: objectList(json.materials).length,
    textureCount: objectList(json.textures).length,
    animationCount: objectList(json.animations).length,
    skinCount: objectList(json.skins).length,
    modelBounds: hasBounds ? { min, max } : undefined,
    gltfExtensionsUsed: stringList(json.extensionsUsed),
    gltfExtensionsRequired: stringList(json.extensionsRequired),
    modelThumbnailVersion: MODEL_THUMBNAIL_SPEC.rendererVersion,
    modelMetadataStatus: boundsMissing ? 'partial' : 'complete',
  };
}

function failedModelMetadata(error: unknown): ModelMetadata {
  const detail = error instanceof Error ? error.message : String(error);
  return {
    modelThumbnailVersion: MODEL_THUMBNAIL_SPEC.rendererVersion,
    modelMetadataStatus: 'failed',
    modelMetadataError: detail || 'Model parser failed',
    modelThumbnailStatus: 'placeholder',
  };
}

/**
 * Summarize a GLB and render its thumbnail. Unreadable models still get a
 * placeholder thumbnail and failed metadata, so they stay indexed and cached.
 */
export async function processModelBuffer(
  buffer: Buffer,
  name: string,
  quality = DEFAULT_THUMBNAIL_QUALITY,
  options: { binOmitted?: boolean } = {}
): Promise<ModelProcessingResult> {
  const webpQuality = normalizeThumbnailQuality(quality);
  let doc: GltfDocument;
  let metadata: ModelMetadata;
  try {
    doc = parseGlb(buffer, options);
    metadata = summarizeGltf(doc);
  } catch (error) {
    if (!(error instanceof GltfError)) console.warn(`Could not parse 3D model ${name}:`, error);
    return {
      metadata: { format: 'glb', ...failedModelMetadata(error) },
      thumbnailBuffer: await generateModelPlaceholder(webpQuality),
    };
  }

  let thumbnail: Buffer | null = null;
  let skipped: string[];
  if (doc.binOmitted) {
    skipped = ['Model is too large to render a preview'];
  } else {
    try {
      const rendered = await renderGltfThumbnail(doc, webpQuality);
      thumbnail = rendered.thumbnail;
      skipped = rendered.skipped;
      if (!thumbnail && skipped.length === 0) skipped = ['No triangle geometry to draw'];
    } catch (error) {
      console.warn(`Could not render 3D model ${name}:`, error);
      skipped = [error instanceof Error ? error.message : String(error)];
    }
  }
  metadata.modelThumbnailStatus = !thumbnail ? 'placeholder' : skipped.length > 0 ? 'partial' : 'rendered';
  if (skipped.length > 0) metadata.modelThumbnailIssue = skipped.join('; ').slice(0, 500);
  return {
    metadata: { format: 'glb', ...metadata },
    thumbnailBuffer: thumbnail ?? await generateModelPlaceholder(webpQuality),
  };
}

export async function processModelFile(
  filePath: string,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<ModelProcessingResult> {
  const name = path.basename(filePath);
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    if (size <= MAX_RENDERED_MODEL_BYTES) {
      return await processModelBuffer(await handle.readFile(), name, quality);
    }
    // Read only the header and JSON chunk of a very large model.
    const header = Buffer.alloc(20);
    await handle.read(header, 0, header.length, 0);
    const jsonLength = Math.min(header.readUInt32LE(12), MAX_GLTF_JSON_BYTES);
    const prefix = Buffer.alloc(Math.min(size, header.length + jsonLength));
    await handle.read(prefix, 0, prefix.length, 0);
    return await processModelBuffer(prefix, name, quality, { binOmitted: true });
  } finally {
    await handle.close();
  }
}
