import sharp from 'sharp';
import {
  GltfUnsupportedError,
  collectMeshInstances,
  indexValue,
  isJsonObject,
  objectList,
  readAccessor,
  readBufferView,
  transformPoint,
  type AccessorReader,
  type GltfDocument,
  type JsonObject,
  type Mat4,
} from './gltf.js';
import { MODEL_THUMBNAIL_SPEC } from './processingFingerprint.js';

// A small CPU rasterizer for card thumbnails: flat-shaded triangles in a fixed
// three-quarter orthographic view, base colors only. The server has no GPU,
// and a silhouette with shading is enough to recognize a model in the grid.

const SUPERSAMPLE = 2;
const PADDING = 0.06;
const MAX_RENDER_VERTICES = 4_000_000;
const MAX_RENDER_TRIANGLES = 2_000_000;
const MAX_TEXTURE_SAMPLES = 64;
const MAX_TEXTURE_BYTES = 64 * 1024 * 1024;

const TRIANGLES = 4;
const TRIANGLE_STRIP = 5;
const TRIANGLE_FAN = 6;

// Camera on the front-right, looking down; glTF is Y-up with +Z forward.
const YAW = Math.PI / 4;
const PITCH = Math.PI / 6;
const VIEW_RIGHT = [Math.cos(YAW), 0, -Math.sin(YAW)];
const VIEW_BACK = [Math.sin(YAW) * Math.cos(PITCH), Math.sin(PITCH), Math.cos(YAW) * Math.cos(PITCH)];
const VIEW_UP = [
  VIEW_BACK[1] * VIEW_RIGHT[2] - VIEW_BACK[2] * VIEW_RIGHT[1],
  VIEW_BACK[2] * VIEW_RIGHT[0] - VIEW_BACK[0] * VIEW_RIGHT[2],
  VIEW_BACK[0] * VIEW_RIGHT[1] - VIEW_BACK[1] * VIEW_RIGHT[0],
];
// Key light from the upper left, in view space (+z points at the camera).
const LIGHT = normalize([-0.45, 0.75, 0.5]);

export interface ModelRenderResult {
  /** WebP thumbnail, or null when no triangle could be drawn. */
  thumbnail: Buffer | null;
  drawnTriangles: number;
  /** Distinct reasons some geometry was not drawn. */
  skipped: string[];
}

interface Drawable {
  matrix: Mat4;
  mode: number;
  positions: AccessorReader;
  indices: AccessorReader | null;
  color: [number, number, number];
}

function normalize(v: number[]): [number, number, number] {
  const length = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function srgbToLinear(value: number): number {
  return Math.pow(value / 255, 2.2);
}

function linearToSrgbByte(value: number): number {
  return Math.round(Math.pow(Math.min(Math.max(value, 0), 1), 1 / 2.2) * 255);
}

function triangleCount(mode: number, elementCount: number): number {
  if (mode === TRIANGLES) return Math.floor(elementCount / 3);
  if (mode === TRIANGLE_STRIP || mode === TRIANGLE_FAN) return Math.max(0, elementCount - 2);
  return 0;
}

/** Average linear color of each base-color texture, sampled at low resolution. */
async function textureColors(doc: GltfDocument): Promise<Map<number, [number, number, number]>> {
  const colors = new Map<number, [number, number, number]>();
  const textures = objectList(doc.json.textures);
  const images = objectList(doc.json.images);
  for (const material of objectList(doc.json.materials)) {
    const pbr = isJsonObject(material.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {};
    const textureInfo = isJsonObject(pbr.baseColorTexture) ? pbr.baseColorTexture : undefined;
    const textureIndex = indexValue(textureInfo?.index);
    if (textureIndex === undefined || colors.has(textureIndex) || colors.size >= MAX_TEXTURE_SAMPLES) continue;
    const texture = textures[textureIndex];
    if (!texture) continue;
    const extensions = isJsonObject(texture.extensions) ? texture.extensions : {};
    const alternate = [extensions.EXT_texture_webp, extensions.EXT_texture_avif].find(isJsonObject);
    const image = images[indexValue(texture.source) ?? indexValue(alternate?.source) ?? -1];
    if (!image || image.bufferView === undefined) continue;
    try {
      const bytes = readBufferView(doc, image.bufferView);
      if (bytes.length > MAX_TEXTURE_BYTES) continue;
      const pixels = await sharp(bytes)
        .resize(16, 16, { fit: 'fill' })
        .removeAlpha()
        .raw()
        .toBuffer();
      const sum = [0, 0, 0];
      for (let i = 0; i < pixels.length; i += 3) {
        sum[0] += srgbToLinear(pixels[i]);
        sum[1] += srgbToLinear(pixels[i + 1]);
        sum[2] += srgbToLinear(pixels[i + 2]);
      }
      const n = pixels.length / 3;
      colors.set(textureIndex, [sum[0] / n, sum[1] / n, sum[2] / n]);
    } catch (error) {
      // An unreadable texture only loses its tint; the base color factor still applies.
      console.warn(`Could not sample model texture ${textureIndex}:`, error);
    }
  }
  return colors;
}

function materialColor(
  material: JsonObject | undefined,
  textures: Map<number, [number, number, number]>
): [number, number, number] {
  const pbr = isJsonObject(material?.pbrMetallicRoughness) ? material.pbrMetallicRoughness : {};
  const factor = Array.isArray(pbr.baseColorFactor) && pbr.baseColorFactor.length === 4 &&
    pbr.baseColorFactor.every((value) => typeof value === 'number' && Number.isFinite(value))
    ? pbr.baseColorFactor as number[]
    : [1, 1, 1, 1];
  const textureInfo = isJsonObject(pbr.baseColorTexture) ? pbr.baseColorTexture : undefined;
  const tint = textures.get(indexValue(textureInfo?.index) ?? -1) ?? [1, 1, 1];
  return [factor[0] * tint[0], factor[1] * tint[1], factor[2] * tint[2]];
}

/** Render the default scene of a parsed GLB into a WebP thumbnail. */
export async function renderGltfThumbnail(doc: GltfDocument, quality: number): Promise<ModelRenderResult> {
  const skipped = new Set<string>();
  const { instances, truncated } = collectMeshInstances(doc.json);
  if (truncated) skipped.add('Scene graph too deep or cyclic');
  const meshes = objectList(doc.json.meshes);
  const materials = objectList(doc.json.materials);
  const textures = await textureColors(doc);

  // Pass 1: decode accessors and find the projected extent of every vertex.
  const drawables: Drawable[] = [];
  let vertexBudget = MAX_RENDER_VERTICES;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const instance of instances) {
    for (const primitive of objectList(meshes[instance.meshIndex].primitives)) {
      const mode = primitive.mode === undefined ? TRIANGLES : indexValue(primitive.mode) ?? -1;
      if (mode !== TRIANGLES && mode !== TRIANGLE_STRIP && mode !== TRIANGLE_FAN) continue;
      const attributes = isJsonObject(primitive.attributes) ? primitive.attributes : {};
      const extensions = isJsonObject(primitive.extensions) ? primitive.extensions : {};
      if (extensions.KHR_draco_mesh_compression !== undefined) {
        skipped.add('Draco-compressed geometry');
        continue;
      }
      let positions: AccessorReader;
      let indices: AccessorReader | null;
      try {
        positions = readAccessor(doc, attributes.POSITION);
        if (positions.components !== 3) throw new GltfUnsupportedError('POSITION is not a VEC3 accessor');
        indices = primitive.indices === undefined ? null : readAccessor(doc, primitive.indices);
        if (indices && indices.components !== 1) throw new GltfUnsupportedError('Indices are not scalar');
      } catch (error) {
        if (!(error instanceof GltfUnsupportedError)) throw error;
        skipped.add(error.message);
        continue;
      }
      if (positions.count > vertexBudget) {
        skipped.add('Vertex budget exceeded');
        continue;
      }
      vertexBudget -= positions.count;
      for (let i = 0; i < positions.count; i++) {
        const [x, y, z] = transformPoint(instance.matrix, positions.get(i, 0), positions.get(i, 1), positions.get(i, 2));
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const vx = x * VIEW_RIGHT[0] + y * VIEW_RIGHT[1] + z * VIEW_RIGHT[2];
        const vy = x * VIEW_UP[0] + y * VIEW_UP[1] + z * VIEW_UP[2];
        minX = Math.min(minX, vx);
        maxX = Math.max(maxX, vx);
        minY = Math.min(minY, vy);
        maxY = Math.max(maxY, vy);
      }
      const material = materials[indexValue(primitive.material) ?? -1];
      drawables.push({ matrix: instance.matrix, mode, positions, indices, color: materialColor(material, textures) });
    }
  }

  const extent = Math.max(maxX - minX, maxY - minY);
  if (drawables.length === 0 || !Number.isFinite(extent) || extent <= 0) {
    return { thumbnail: null, drawnTriangles: 0, skipped: [...skipped] };
  }

  // Pass 2: rasterize with a depth buffer at supersampled resolution.
  const size = MODEL_THUMBNAIL_SPEC.width * SUPERSAMPLE;
  const scale = (size * (1 - 2 * PADDING)) / extent;
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const pixels = Buffer.alloc(size * size * 4);
  const depth = new Float32Array(size * size).fill(-Infinity);
  let triangleBudget = MAX_RENDER_TRIANGLES;
  let drawnTriangles = 0;

  for (const drawable of drawables) {
    const { positions, indices, mode } = drawable;
    const view = new Float32Array(positions.count * 3);
    for (let i = 0; i < positions.count; i++) {
      const [x, y, z] = transformPoint(drawable.matrix, positions.get(i, 0), positions.get(i, 1), positions.get(i, 2));
      view[i * 3] = x * VIEW_RIGHT[0] + y * VIEW_RIGHT[1] + z * VIEW_RIGHT[2];
      view[i * 3 + 1] = x * VIEW_UP[0] + y * VIEW_UP[1] + z * VIEW_UP[2];
      view[i * 3 + 2] = x * VIEW_BACK[0] + y * VIEW_BACK[1] + z * VIEW_BACK[2];
    }
    const elementCount = indices ? indices.count : positions.count;
    let triangles = triangleCount(mode, elementCount);
    if (triangles > triangleBudget) {
      skipped.add('Triangle budget exceeded');
      triangles = triangleBudget;
    }
    triangleBudget -= triangles;
    const vertexAt = (element: number) => (indices ? indices.get(element, 0) : element);

    for (let t = 0; t < triangles; t++) {
      let a: number;
      let b: number;
      let c: number;
      if (mode === TRIANGLES) {
        a = vertexAt(t * 3); b = vertexAt(t * 3 + 1); c = vertexAt(t * 3 + 2);
      } else if (mode === TRIANGLE_STRIP) {
        a = vertexAt(t); b = vertexAt(t + 1); c = vertexAt(t + 2);
      } else {
        a = vertexAt(0); b = vertexAt(t + 1); c = vertexAt(t + 2);
      }
      if (a >= positions.count || b >= positions.count || c >= positions.count) {
        skipped.add('Index outside its vertex range');
        continue;
      }
      if (rasterizeTriangle(view, a, b, c, drawable.color, { size, scale, centerX, centerY, pixels, depth })) {
        drawnTriangles++;
      }
    }
  }

  if (drawnTriangles === 0) return { thumbnail: null, drawnTriangles, skipped: [...skipped] };
  const thumbnail = await sharp(pixels, { raw: { width: size, height: size, channels: 4 } })
    .resize(MODEL_THUMBNAIL_SPEC.width, MODEL_THUMBNAIL_SPEC.height, { fit: 'contain' })
    .webp({ quality })
    .toBuffer();
  return { thumbnail, drawnTriangles, skipped: [...skipped] };
}

interface RasterTarget {
  size: number;
  scale: number;
  centerX: number;
  centerY: number;
  pixels: Buffer;
  depth: Float32Array;
}

/** Fill one flat-shaded triangle; returns false when it is degenerate or invalid. */
function rasterizeTriangle(
  view: Float32Array,
  a: number,
  b: number,
  c: number,
  color: [number, number, number],
  target: RasterTarget
): boolean {
  const ax = view[a * 3], ay = view[a * 3 + 1], az = view[a * 3 + 2];
  const bx = view[b * 3], by = view[b * 3 + 1], bz = view[b * 3 + 2];
  const cx = view[c * 3], cy = view[c * 3 + 1], cz = view[c * 3 + 2];
  if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) return false;

  // Two-sided Lambert lighting, so winding order and backfaces do not matter.
  const normal = normalize([
    (by - ay) * (cz - az) - (bz - az) * (cy - ay),
    (bz - az) * (cx - ax) - (bx - ax) * (cz - az),
    (bx - ax) * (cy - ay) - (by - ay) * (cx - ax),
  ]);
  const diffuse = Math.abs(normal[0] * LIGHT[0] + normal[1] * LIGHT[1] + normal[2] * LIGHT[2]);
  const intensity = 0.28 + 0.55 * diffuse + 0.22 * Math.abs(normal[2]);
  const r = linearToSrgbByte(color[0] * intensity);
  const g = linearToSrgbByte(color[1] * intensity);
  const bl = linearToSrgbByte(color[2] * intensity);

  const { size, scale, centerX, centerY, pixels, depth } = target;
  const half = size / 2;
  const sax = half + (ax - centerX) * scale, say = half - (ay - centerY) * scale;
  const sbx = half + (bx - centerX) * scale, sby = half - (by - centerY) * scale;
  const scx = half + (cx - centerX) * scale, scy = half - (cy - centerY) * scale;
  const area = (sbx - sax) * (scy - say) - (sby - say) * (scx - sax);
  if (Math.abs(area) < 1e-9) return false;

  const x0 = Math.max(0, Math.floor(Math.min(sax, sbx, scx)));
  const x1 = Math.min(size - 1, Math.ceil(Math.max(sax, sbx, scx)));
  const y0 = Math.max(0, Math.floor(Math.min(say, sby, scy)));
  const y1 = Math.min(size - 1, Math.ceil(Math.max(say, sby, scy)));
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      const w0 = ((sbx - px) * (scy - py) - (sby - py) * (scx - px)) / area;
      const w1 = ((scx - px) * (say - py) - (scy - py) * (sax - px)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      const z = w0 * az + w1 * bz + w2 * cz;
      const index = y * size + x;
      if (z <= depth[index]) continue;
      depth[index] = z;
      pixels[index * 4] = r;
      pixels[index * 4 + 1] = g;
      pixels[index * 4 + 2] = bl;
      pixels[index * 4 + 3] = 255;
    }
  }
  return true;
}
