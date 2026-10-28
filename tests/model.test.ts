import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import {
  closeDatabase,
  getAllFormats,
  getAssetByPath,
  getDatabase,
  initDatabase,
  queryAssets,
  updateAppSettings,
} from '../server/src/db/database.js';
import {
  isSupportedModelExtension,
  processModelBuffer,
  processModelFile,
} from '../server/src/services/model.js';
import { MODEL_THUMBNAIL_SPEC } from '../server/src/services/processingFingerprint.js';
import { scanLibrary } from '../server/src/services/scanner.js';
import {
  cleanupTempDir,
  createBoxesGlb,
  createTempDir,
  createTestGlbBuffer,
  createTestZipArchive,
} from './helpers.js';

async function rawThumbnail(buffer: Buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (x: number, y: number) => {
    const i = (y * info.width + x) * 4;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };
  return { info, pixel };
}

describe('GLB model processing', () => {
  it('recognizes only binary glTF files', () => {
    expect(isSupportedModelExtension('.glb')).toBe(true);
    expect(isSupportedModelExtension('.GLB')).toBe(true);
    expect(isSupportedModelExtension('.gltf')).toBe(false);
    expect(isSupportedModelExtension('.obj')).toBe(false);
  });

  it('summarizes the default scene and renders a shaded, framed thumbnail', async () => {
    const glb = createTestGlbBuffer({ generator: 'Test Exporter 1.0' });
    const result = await processModelBuffer(glb, 'cube.glb');

    expect(result.metadata).toMatchObject({
      format: 'glb',
      gltfVersion: '2.0',
      generator: 'Test Exporter 1.0',
      sceneCount: 1,
      nodeCount: 2,
      meshCount: 1,
      primitiveCount: 1,
      vertexCount: 24,
      triangleCount: 12,
      materialCount: 1,
      textureCount: 0,
      animationCount: 0,
      modelBounds: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
      modelThumbnailVersion: MODEL_THUMBNAIL_SPEC.rendererVersion,
      modelMetadataStatus: 'complete',
      modelThumbnailStatus: 'rendered',
    });
    expect(result.metadata.modelThumbnailIssue).toBeUndefined();

    const { info, pixel } = await rawThumbnail(result.thumbnailBuffer);
    expect((await sharp(result.thumbnailBuffer).metadata()).format).toBe('webp');
    expect([info.width, info.height]).toEqual([MODEL_THUMBNAIL_SPEC.width, MODEL_THUMBNAIL_SPEC.height]);
    const center = pixel(200, 200);
    expect(center.a).toBe(255);
    expect(center.r).toBeGreaterThan(center.b + 60);
    expect(pixel(2, 2).a).toBe(0);
    expect(pixel(397, 397).a).toBe(0);
  });

  it('applies node transforms and counts instanced meshes once per use', async () => {
    const glb = createBoxesGlb([
      { size: [2, 1, 1], translation: [2, 0, 0], color: [1, 1, 1, 1] },
    ], {
      mutate(json) {
        json.nodes.push({ name: 'Copy', mesh: 0, translation: [0, 3, 0] });
        json.nodes[0].children.push(2);
      },
    });
    const { metadata } = await processModelBuffer(glb, 'pair.glb');
    expect(metadata.meshCount).toBe(1);
    expect(metadata.triangleCount).toBe(24);
    expect(metadata.vertexCount).toBe(48);
    expect(metadata.modelBounds).toEqual({ min: [-0.5, -0.5, -0.5], max: [3, 3.5, 0.5] });
  });

  it('tints the render with the average color of an embedded base-color texture', async () => {
    const texturePng = await sharp({
      create: { width: 4, height: 4, channels: 3, background: { r: 30, g: 200, b: 40 } },
    }).png().toBuffer();
    const glb = createBoxesGlb([{ size: [1, 1, 1], color: [1, 1, 1, 1] }], { texturePng });
    const result = await processModelBuffer(glb, 'textured.glb');
    expect(result.metadata.textureCount).toBe(1);
    const center = (await rawThumbnail(result.thumbnailBuffer)).pixel(200, 200);
    expect(center.g).toBeGreaterThan(center.r + 60);
  });

  it('reads the same result from disk and from memory', async () => {
    const dir = createTempDir('model-disk-');
    try {
      const glb = createTestGlbBuffer();
      const filePath = path.join(dir, 'cube.glb');
      fs.writeFileSync(filePath, glb);
      const fromDisk = await processModelFile(filePath);
      const fromBuffer = await processModelBuffer(glb, 'cube.glb');
      expect(fromDisk.metadata).toEqual(fromBuffer.metadata);
      expect(fromDisk.thumbnailBuffer.equals(fromBuffer.thumbnailBuffer)).toBe(true);
    } finally {
      cleanupTempDir(dir);
    }
  });

  it('marks unreadable containers as failed and still returns a placeholder thumbnail', async () => {
    const glb = createTestGlbBuffer();
    const cases = [
      { name: 'garbage', bytes: Buffer.from('NOT A MODEL FILE AT ALL') },
      { name: 'truncated', bytes: glb.subarray(0, glb.length - 16) },
      { name: 'gltf1', bytes: createTestGlbBuffer({ mutate: (json) => { json.asset.version = '1.0'; } }) },
    ];
    for (const fixture of cases) {
      const result = await processModelBuffer(fixture.bytes, `${fixture.name}.glb`);
      expect(result.metadata.modelMetadataStatus, fixture.name).toBe('failed');
      expect(result.metadata.modelMetadataError, fixture.name).toMatch(/.+/);
      expect(result.metadata.modelThumbnailStatus, fixture.name).toBe('placeholder');
      const meta = await sharp(result.thumbnailBuffer).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', 400, 400]);
    }
  });

  it('keeps metadata but uses the placeholder when geometry cannot be decoded', async () => {
    const cases: { name: string; issue: RegExp; status?: string; mutate: (json: Record<string, any>) => void }[] = [
      {
        name: 'draco',
        issue: /Draco/,
        mutate: (json: Record<string, any>) => {
          json.extensionsUsed = ['KHR_draco_mesh_compression'];
          json.extensionsRequired = ['KHR_draco_mesh_compression'];
          json.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: { bufferView: 0, attributes: {} } };
          delete json.accessors[0].bufferView;
        },
      },
      {
        name: 'overrun',
        issue: /past its buffer view/,
        mutate: (json: Record<string, any>) => { json.accessors[0].count = 100_000; },
      },
      {
        name: 'external',
        issue: /outside the GLB binary chunk/,
        mutate: (json: Record<string, any>) => { json.buffers[0].uri = 'geometry.bin'; },
      },
      {
        name: 'bad-indices',
        status: 'partial',
        issue: /Index outside/,
        mutate: (json: Record<string, any>) => { json.accessors[0].count = 3; },
      },
    ];
    for (const fixture of cases) {
      const result = await processModelBuffer(createTestGlbBuffer({ mutate: fixture.mutate }), `${fixture.name}.glb`);
      expect(result.metadata.modelMetadataStatus, fixture.name).toBe('complete');
      expect(result.metadata.meshCount, fixture.name).toBe(1);
      expect(result.metadata.modelThumbnailStatus, fixture.name).toBe(fixture.status ?? 'placeholder');
      expect(result.metadata.modelThumbnailIssue, fixture.name).toMatch(fixture.issue);
    }
    const draco = await processModelBuffer(
      createTestGlbBuffer({ mutate: cases[0].mutate }), 'draco.glb'
    );
    expect(draco.metadata.gltfExtensionsRequired).toEqual(['KHR_draco_mesh_compression']);
  });

  it('stops at cyclic node graphs', async () => {
    const glb = createTestGlbBuffer({
      mutate(json) { json.nodes[1].children = [0]; },
    });
    const result = await processModelBuffer(glb, 'cycle.glb');
    expect(result.metadata.triangleCount).toBe(12);
    expect(result.metadata.modelThumbnailStatus).toBe('partial');
    expect(result.metadata.modelThumbnailIssue).toMatch(/cyclic/);
  });

  it('summarizes an oversized model from its JSON chunk without rendering', async () => {
    const glb = createTestGlbBuffer();
    const jsonEnd = 20 + glb.readUInt32LE(12);
    const result = await processModelBuffer(glb.subarray(0, jsonEnd), 'huge.glb', 85, { binOmitted: true });
    expect(result.metadata.modelMetadataStatus).toBe('complete');
    expect(result.metadata.triangleCount).toBe(12);
    expect(result.metadata.modelThumbnailStatus).toBe('placeholder');
    expect(result.metadata.modelThumbnailIssue).toMatch(/too large/);
  });
});

describe('GLB model indexing', () => {
  let libraryDir: string;

  beforeEach(() => {
    libraryDir = createTempDir('lib-models-');
    initDatabase(libraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(libraryDir);
  });

  it('indexes models on disk and inside ZIP archives, then reuses them on rescan', async () => {
    fs.mkdirSync(path.join(libraryDir, 'props'));
    fs.writeFileSync(path.join(libraryDir, 'props', 'crate.glb'), createTestGlbBuffer());
    fs.writeFileSync(path.join(libraryDir, 'props', 'broken.glb'), Buffer.from('not a model'));
    createTestZipArchive(path.join(libraryDir, 'pack.zip'), [
      { name: 'models/barrel.glb', content: createTestGlbBuffer() },
    ]);

    const first = await scanLibrary(libraryDir);
    expect(first.status).toBe('completed');
    expect(first.indexedCount).toBe(3);

    const crate = getAssetByPath(path.join('props', 'crate.glb'));
    expect(crate?.category).toBe('model');
    expect(crate?.metadata.modelThumbnailStatus).toBe('rendered');
    expect(getAssetByPath(path.join('props', 'broken.glb'))?.metadata.modelMetadataStatus).toBe('failed');
    const barrel = getAssetByPath('pack.zip#/models/barrel.glb');
    expect(barrel).toMatchObject({ category: 'model', isArchiveEntry: true });
    expect(barrel?.metadata.triangleCount).toBe(12);

    const models = queryAssets({ category: 'model' });
    expect(models.total).toBe(3);
    expect(models.summary.modelCount).toBe(3);
    expect(queryAssets({ search: 'is:model' }).total).toBe(3);
    expect(queryAssets({ search: 'is:3d', isStackedView: true }).total).toBe(3);
    expect(getAllFormats()).toContainEqual({ extension: '.glb', category: 'model', count: 3 });

    const second = await scanLibrary(libraryDir);
    expect(second.status).toBe('completed');
    expect(second.indexedCount).toBe(0);
  });
});

describe('GLB models in archives scanned before model support', () => {
  let libraryDir: string;

  beforeEach(() => {
    libraryDir = createTempDir('lib-models-upgrade-');
    initDatabase(libraryDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(libraryDir);
  });

  it('lists an unchanged archive again when the indexable formats change', async () => {
    const archivePath = createTestZipArchive(path.join(libraryDir, 'pack.zip'), [
      { name: 'models/barrel.glb', content: createTestGlbBuffer() },
      { name: 'models/notes.txt', content: 'not indexed' },
    ]);
    await scanLibrary(libraryDir);
    // Recreate the record an earlier version left: no model rows and a
    // signature without the indexable-format suffix.
    const db = getDatabase();
    db.prepare("DELETE FROM assets WHERE category = 'model'").run();
    const record = db.prepare('SELECT signature FROM archives WHERE absolute_path = ?')
      .get(archivePath) as { signature: string };
    db.prepare('UPDATE archives SET signature = ?, entry_count = 0 WHERE absolute_path = ?')
      .run(record.signature.split(':').slice(0, 4).join(':'), archivePath);

    const rescan = await scanLibrary(libraryDir);
    expect(rescan.status).toBe('completed');
    expect(rescan.indexedCount).toBe(1);
    expect(getAssetByPath('pack.zip#/models/barrel.glb')?.category).toBe('model');
  });
});

describe('GLB model HTTP delivery', () => {
  let app: FastifyInstance;
  let libraryDir: string;

  beforeEach(async () => {
    libraryDir = createTempDir('routes-models-');
    initDatabase(libraryDir);
    updateAppSettings({ libraryPath: libraryDir });
    app = await buildServer({ initDb: false, logger: false });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    closeDatabase();
    cleanupTempDir(libraryDir);
  });

  it('serves disk and ZIP models as model/gltf-binary with their thumbnails', async () => {
    const glb = createTestGlbBuffer();
    fs.writeFileSync(path.join(libraryDir, 'crate.glb'), glb);
    createTestZipArchive(path.join(libraryDir, 'pack.zip'), [{ name: 'barrel.glb', content: glb }]);
    await scanLibrary(libraryDir);

    for (const assetPath of ['crate.glb', 'pack.zip#/barrel.glb']) {
      const asset = getAssetByPath(assetPath)!;
      const file = await app.inject({ method: 'GET', url: asset.fileUrl });
      expect(file.statusCode, assetPath).toBe(200);
      expect(file.headers['content-type'], assetPath).toBe('model/gltf-binary');
      expect(file.rawPayload.equals(glb), assetPath).toBe(true);

      const thumbnail = await app.inject({ method: 'GET', url: asset.thumbnailUrl });
      expect(thumbnail.statusCode, assetPath).toBe(200);
      expect(thumbnail.headers['content-type'], assetPath).toBe('image/webp');
    }
  });
});
