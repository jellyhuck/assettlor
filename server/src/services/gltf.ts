// Defensive reader for binary glTF 2.0 (.glb). Model files are untrusted, so
// every chunk, buffer view, and accessor read is bounds-checked before use.

const GLB_MAGIC = 0x46546c67; // "glTF"
const GLB_HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

/** The JSON chunk is parsed as one string; larger documents are rejected. */
export const MAX_GLTF_JSON_BYTES = 64 * 1024 * 1024;
const MAX_NODE_DEPTH = 64;
const MAX_NODE_VISITS = 100_000;

/** The file is not a readable GLB container. */
export class GltfError extends Error {}

/** The document is valid but uses data this reader cannot decode. */
export class GltfUnsupportedError extends Error {}

export type JsonObject = Record<string, unknown>;

export interface GltfDocument {
  json: JsonObject;
  /** The embedded BIN chunk; null when absent or deliberately not read. */
  bin: Buffer | null;
  /** True when only the header and JSON chunk were read. */
  binOmitted: boolean;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Array members as objects; malformed members become {} to keep indices stable. */
export function objectList(value: unknown): JsonObject[] {
  return Array.isArray(value) ? value.map((item) => (isJsonObject(item) ? item : {})) : [];
}

export function indexValue(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
}

function finiteNumbers(value: unknown, length: number): number[] | undefined {
  if (!Array.isArray(value) || value.length !== length) return undefined;
  return value.every((item) => typeof item === 'number' && Number.isFinite(item)) ? value as number[] : undefined;
}

export function stringList(value: unknown, limit = 50): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').slice(0, limit)
    : [];
}

/**
 * Parse the GLB header and JSON chunk. With binOmitted, the buffer may hold
 * only the header and JSON chunk of a larger file.
 */
export function parseGlb(buffer: Buffer, options: { binOmitted?: boolean } = {}): GltfDocument {
  const binOmitted = options.binOmitted === true;
  if (buffer.length < GLB_HEADER_BYTES + CHUNK_HEADER_BYTES) {
    throw new GltfError('File is too small to be a GLB model');
  }
  if (buffer.readUInt32LE(0) !== GLB_MAGIC) throw new GltfError('Missing glTF binary header');
  const containerVersion = buffer.readUInt32LE(4);
  if (containerVersion !== 2) throw new GltfError(`Unsupported GLB container version ${containerVersion}`);
  const declaredLength = buffer.readUInt32LE(8);
  if (declaredLength < GLB_HEADER_BYTES + CHUNK_HEADER_BYTES) throw new GltfError('Invalid GLB length');
  if (!binOmitted && declaredLength > buffer.length) throw new GltfError('GLB file is truncated');

  const jsonLength = buffer.readUInt32LE(12);
  if (buffer.readUInt32LE(16) !== CHUNK_JSON) throw new GltfError('First GLB chunk is not JSON');
  if (jsonLength > MAX_GLTF_JSON_BYTES) throw new GltfError('GLB JSON chunk is too large');
  const jsonStart = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonEnd > declaredLength || jsonEnd > buffer.length) throw new GltfError('GLB JSON chunk is truncated');

  let json: unknown;
  try {
    json = JSON.parse(buffer.toString('utf8', jsonStart, jsonEnd));
  } catch {
    throw new GltfError('GLB JSON chunk is not valid JSON');
  }
  if (!isJsonObject(json)) throw new GltfError('GLB JSON chunk is not an object');
  const asset = isJsonObject(json.asset) ? json.asset : undefined;
  if (typeof asset?.version !== 'string' || !asset.version.startsWith('2.')) {
    throw new GltfError('Only glTF 2.x models are supported');
  }

  let bin: Buffer | null = null;
  // Chunk lengths include their padding, so the BIN chunk starts right after JSON.
  if (!binOmitted && jsonEnd + CHUNK_HEADER_BYTES <= declaredLength) {
    const binLength = buffer.readUInt32LE(jsonEnd);
    const binStart = jsonEnd + CHUNK_HEADER_BYTES;
    if (buffer.readUInt32LE(jsonEnd + 4) === CHUNK_BIN) {
      if (binStart + binLength > declaredLength) throw new GltfError('GLB binary chunk is truncated');
      bin = buffer.subarray(binStart, binStart + binLength);
    }
  }
  return { json, bin, binOmitted };
}

// --- Column-major 4×4 matrices, as stored by glTF ---

export type Mat4 = Float64Array;

export function identityMatrix(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

export function multiplyMatrices(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row] * b[col * 4 + k];
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

export function nodeMatrix(node: JsonObject): Mat4 {
  const matrix = finiteNumbers(node.matrix, 16);
  if (matrix) return Float64Array.from(matrix);
  const [tx, ty, tz] = finiteNumbers(node.translation, 3) ?? [0, 0, 0];
  const [qx, qy, qz, qw] = finiteNumbers(node.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = finiteNumbers(node.scale, 3) ?? [1, 1, 1];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (qy * qy + qz * qz)) * sx;
  m[1] = 2 * (qx * qy + qz * qw) * sx;
  m[2] = 2 * (qx * qz - qy * qw) * sx;
  m[4] = 2 * (qx * qy - qz * qw) * sy;
  m[5] = (1 - 2 * (qx * qx + qz * qz)) * sy;
  m[6] = 2 * (qy * qz + qx * qw) * sy;
  m[8] = 2 * (qx * qz + qy * qw) * sz;
  m[9] = 2 * (qy * qz - qx * qw) * sz;
  m[10] = (1 - 2 * (qx * qx + qy * qy)) * sz;
  m[12] = tx;
  m[13] = ty;
  m[14] = tz;
  m[15] = 1;
  return m;
}

export function transformPoint(m: Mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

// --- Scene traversal ---

export interface MeshInstance {
  meshIndex: number;
  matrix: Mat4;
}

export interface SceneInstances {
  /** False when the document has no scene; instances then list each mesh once. */
  fromScene: boolean;
  instances: MeshInstance[];
  truncated: boolean;
}

/**
 * List the meshes the default scene draws with their world matrices. Cycles,
 * excessive depth, and runaway instancing are cut off and reported.
 */
export function collectMeshInstances(json: JsonObject): SceneInstances {
  const nodes = objectList(json.nodes);
  const meshCount = objectList(json.meshes).length;
  const scenes = objectList(json.scenes);
  const sceneIndex = indexValue(json.scene) ?? 0;
  const scene = scenes[sceneIndex];
  if (!scene) {
    return {
      fromScene: false,
      instances: Array.from({ length: meshCount }, (_, meshIndex) => ({ meshIndex, matrix: identityMatrix() })),
      truncated: false,
    };
  }

  const instances: MeshInstance[] = [];
  const ancestors = new Set<number>();
  let visits = 0;
  let truncated = false;
  const visit = (nodeIndex: number, parent: Mat4, depth: number): void => {
    const node = nodes[nodeIndex];
    if (!node || ancestors.has(nodeIndex) || depth > MAX_NODE_DEPTH || ++visits > MAX_NODE_VISITS) {
      if (node) truncated = true;
      return;
    }
    const world = multiplyMatrices(parent, nodeMatrix(node));
    const meshIndex = indexValue(node.mesh);
    if (meshIndex !== undefined && meshIndex < meshCount) instances.push({ meshIndex, matrix: world });
    if (!Array.isArray(node.children)) return;
    ancestors.add(nodeIndex);
    for (const child of node.children) {
      const childIndex = indexValue(child);
      if (childIndex !== undefined) visit(childIndex, world, depth + 1);
    }
    ancestors.delete(nodeIndex);
  };
  const root = identityMatrix();
  for (const rootNode of Array.isArray(scene.nodes) ? scene.nodes : []) {
    const nodeIndex = indexValue(rootNode);
    if (nodeIndex !== undefined) visit(nodeIndex, root, 0);
  }
  return { fromScene: true, instances, truncated };
}

// --- Accessors and buffer views ---

const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const NORMALIZED_DIVISOR: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16,
};

export function accessorAt(json: JsonObject, index: unknown): JsonObject | undefined {
  const accessorIndex = indexValue(index);
  return accessorIndex === undefined ? undefined : objectList(json.accessors)[accessorIndex];
}

export function accessorCount(accessor: JsonObject | undefined): number | undefined {
  return accessor ? indexValue(accessor.count) : undefined;
}

/** Accessor min/max as stored values, normalized for integer accessors. */
export function accessorBounds(accessor: JsonObject): { min: number[]; max: number[] } | undefined {
  const min = finiteNumbers(accessor.min, 3);
  const max = finiteNumbers(accessor.max, 3);
  if (!min || !max) return undefined;
  const divisor = accessor.normalized === true ? NORMALIZED_DIVISOR[accessor.componentType as number] : undefined;
  if (!divisor) return { min, max };
  const scale = (value: number) => Math.max(value / divisor, -1);
  return { min: min.map(scale), max: max.map(scale) };
}

/** Bytes of a buffer view stored in the GLB binary chunk. */
export function readBufferView(doc: GltfDocument, viewIndex: unknown): Buffer {
  const index = indexValue(viewIndex);
  const view = index === undefined ? undefined : objectList(doc.json.bufferViews)[index];
  if (!view) throw new GltfUnsupportedError('Missing buffer view');
  const bufferIndex = indexValue(view.buffer);
  const buffer = bufferIndex === undefined ? undefined : objectList(doc.json.buffers)[bufferIndex];
  if (bufferIndex !== 0 || !buffer || buffer.uri !== undefined) {
    throw new GltfUnsupportedError('Geometry stored outside the GLB binary chunk');
  }
  if (!doc.bin) {
    throw new GltfUnsupportedError(doc.binOmitted ? 'Binary chunk was not read' : 'GLB has no binary chunk');
  }
  const start = indexValue(view.byteOffset ?? 0);
  const length = indexValue(view.byteLength);
  if (start === undefined || length === undefined || start + length > doc.bin.length) {
    throw new GltfUnsupportedError('Buffer view lies outside the binary chunk');
  }
  return doc.bin.subarray(start, start + length);
}

export interface AccessorReader {
  count: number;
  components: number;
  /** Component value, normalized to [-1, 1] or [0, 1] for normalized integers. */
  get(element: number, component: number): number;
}

export function readAccessor(doc: GltfDocument, accessorIndex: unknown): AccessorReader {
  const accessor = accessorAt(doc.json, accessorIndex);
  if (!accessor) throw new GltfUnsupportedError('Missing accessor');
  if (accessor.sparse !== undefined) throw new GltfUnsupportedError('Sparse accessors');
  if (accessor.bufferView === undefined) throw new GltfUnsupportedError('Compressed or empty accessor');
  const componentType = accessor.componentType as number;
  const componentBytes = COMPONENT_BYTES[componentType];
  const components = TYPE_COMPONENTS[accessor.type as string];
  const count = indexValue(accessor.count);
  const offset = indexValue(accessor.byteOffset ?? 0);
  if (!componentBytes || !components || count === undefined || offset === undefined) {
    throw new GltfUnsupportedError('Malformed accessor');
  }

  const viewBytes = readBufferView(doc, accessor.bufferView);
  const view = objectList(doc.json.bufferViews)[accessor.bufferView as number];
  const elementBytes = componentBytes * components;
  const stride = view.byteStride === undefined ? elementBytes : indexValue(view.byteStride);
  if (stride === undefined || stride < elementBytes || stride > 252) {
    throw new GltfUnsupportedError('Invalid buffer view stride');
  }
  if (count > 0 && offset + stride * (count - 1) + elementBytes > viewBytes.length) {
    throw new GltfUnsupportedError('Accessor reads past its buffer view');
  }

  const data = new DataView(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength);
  const divisor = accessor.normalized === true ? NORMALIZED_DIVISOR[componentType] : undefined;
  const readRaw = (byte: number): number => {
    switch (componentType) {
      case 5120: return data.getInt8(byte);
      case 5121: return data.getUint8(byte);
      case 5122: return data.getInt16(byte, true);
      case 5123: return data.getUint16(byte, true);
      case 5125: return data.getUint32(byte, true);
      default: return data.getFloat32(byte, true);
    }
  };
  return {
    count,
    components,
    get(element, component) {
      const value = readRaw(offset + element * stride + component * componentBytes);
      return divisor ? Math.max(value / divisor, -1) : value;
    },
  };
}
