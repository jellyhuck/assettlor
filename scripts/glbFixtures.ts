// Builds small, valid binary glTF (.glb) files from colored boxes. Used by the
// sample generator and the tests; it is not part of the server runtime.

type Vec3 = [number, number, number];
type Rgba = [number, number, number, number];

export interface GlbBox {
  name?: string;
  /** Edge lengths, applied as the node scale of a unit cube. */
  size: Vec3;
  translation?: Vec3;
  /** Quaternion [x, y, z, w]. */
  rotation?: [number, number, number, number];
  /** Linear base color factor. */
  color: Rgba;
}

export interface GlbBuildOptions {
  generator?: string;
  /** PNG bytes used as the first box's base-color texture. */
  texturePng?: Buffer;
  /** Adjust the glTF JSON before encoding, e.g. to build malformed fixtures. */
  mutate?: (json: Record<string, any>) => void;
}

function align4(length: number): number {
  return (length + 3) & ~3;
}

/** Wrap a glTF JSON document and optional binary chunk in a GLB container. */
export function encodeGlb(json: unknown, bin?: Buffer): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.alloc(align4(jsonBytes.length), 0x20);
  jsonBytes.copy(jsonChunk);
  const binChunk = bin ? Buffer.alloc(align4(bin.length)) : null;
  if (bin && binChunk) bin.copy(binChunk);

  const total = 12 + 8 + jsonChunk.length + (binChunk ? 8 + binChunk.length : 0);
  const out = Buffer.alloc(total);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonChunk.copy(out, 20);
  if (binChunk) {
    const offset = 20 + jsonChunk.length;
    out.writeUInt32LE(binChunk.length, offset);
    out.writeUInt32LE(0x004e4942, offset + 4);
    binChunk.copy(out, offset + 8);
  }
  return out;
}

// Unit cube centered on the origin: four vertices per face for flat normals.
const FACES: { normal: Vec3; corners: Vec3[] }[] = [
  { normal: [1, 0, 0], corners: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
  { normal: [0, 1, 0], corners: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
  { normal: [0, 0, -1], corners: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
];

function cubeGeometry(): { positions: Buffer; normals: Buffer; uvs: Buffer; indices: Buffer } {
  const positions = Buffer.alloc(24 * 12);
  const normals = Buffer.alloc(24 * 12);
  const uvs = Buffer.alloc(24 * 8);
  const indices = Buffer.alloc(36 * 2);
  const faceUvs = [[0, 1], [1, 1], [1, 0], [0, 0]];
  FACES.forEach((face, f) => {
    face.corners.forEach((corner, c) => {
      const v = f * 4 + c;
      corner.forEach((value, axis) => {
        positions.writeFloatLE(value * 0.5, v * 12 + axis * 4);
        normals.writeFloatLE(face.normal[axis], v * 12 + axis * 4);
      });
      uvs.writeFloatLE(faceUvs[c][0], v * 8);
      uvs.writeFloatLE(faceUvs[c][1], v * 8 + 4);
    });
    [0, 1, 2, 0, 2, 3].forEach((corner, i) => indices.writeUInt16LE(f * 4 + corner, (f * 6 + i) * 2));
  });
  return { positions, normals, uvs, indices };
}

/** A GLB scene with one node and material per box, sharing cube geometry. */
export function createBoxesGlb(boxes: GlbBox[], options: GlbBuildOptions = {}): Buffer {
  const geometry = cubeGeometry();
  const parts = [geometry.positions, geometry.normals, geometry.uvs, geometry.indices];
  if (options.texturePng) parts.push(options.texturePng);
  const bufferViews: Record<string, unknown>[] = [];
  let offset = 0;
  for (const [i, part] of parts.entries()) {
    bufferViews.push({
      buffer: 0,
      byteOffset: offset,
      byteLength: part.length,
      ...(i < 3 ? { target: 34962 } : i === 3 ? { target: 34963 } : {}),
    });
    offset = align4(offset + part.length);
  }
  const bin = Buffer.alloc(offset);
  let cursor = 0;
  for (const part of parts) {
    part.copy(bin, cursor);
    cursor = align4(cursor + part.length);
  }

  const json: Record<string, any> = {
    asset: { version: '2.0', generator: options.generator ?? 'Assettlor fixtures' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'Root', children: boxes.map((_, i) => i + 1) },
      ...boxes.map((box, i) => ({
        name: box.name ?? `Box${i + 1}`,
        mesh: i,
        scale: box.size,
        ...(box.translation ? { translation: box.translation } : {}),
        ...(box.rotation ? { rotation: box.rotation } : {}),
      })),
    ],
    meshes: boxes.map((box, i) => ({
      name: box.name ?? `Box${i + 1}`,
      primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: i }],
    })),
    materials: boxes.map((box, i) => ({
      name: `${box.name ?? `Box${i + 1}`}Material`,
      pbrMetallicRoughness: {
        baseColorFactor: box.color,
        metallicFactor: 0,
        roughnessFactor: 0.8,
        ...(i === 0 && options.texturePng ? { baseColorTexture: { index: 0 } } : {}),
      },
    })),
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC2' },
      { bufferView: 3, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: bin.length }],
  };
  if (options.texturePng) {
    json.images = [{ bufferView: 4, mimeType: 'image/png' }];
    json.textures = [{ source: 0 }];
  }
  options.mutate?.(json);
  return encodeGlb(json, bin);
}
