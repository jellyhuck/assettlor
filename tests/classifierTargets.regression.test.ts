import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import path from 'path';
import { initDatabase, closeDatabase, upsertAsset, getDatabase } from '../server/src/db/database.js';
import { classifiersRoutes } from '../server/src/routes/classifiers.js';
import { createTempDir, cleanupTempDir } from './helpers.js';

describe('classifier target inventory', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = createTempDir('classifier-targets-');
    initDatabase(dataDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(dataDir);
  });

  it('lists every indexed asset and nested directory despite stacking', async () => {
    for (let i = 0; i < 220; i++) {
      const file = `libraryA/outer/inner/asset-${i}.png`;
      upsertAsset({
        id: `asset-${i}`,
        path: file,
        absolutePath: path.join(dataDir, file),
        name: `asset-${i}.png`,
        extension: '.png',
        category: 'image',
        size: 1,
        mtime: 1,
        hash: `hash-${i}`,
        isArchiveEntry: false,
      });
    }
    getDatabase().prepare("UPDATE assets SET stack_id = 'stack-1'").run();

    const app = Fastify();
    await app.register(classifiersRoutes);
    const response = await app.inject('/api/classifiers/targets');
    await app.close();

    expect(response.statusCode).toBe(200);
    const inventory = response.json();
    expect(inventory.assets).toHaveLength(220);
    expect(inventory.directories).toEqual([
      { value: 'libraryA', label: 'libraryA' },
      { value: 'libraryA/outer', label: 'libraryA/outer' },
      { value: 'libraryA/outer/inner', label: 'libraryA/outer/inner' },
    ]);
  });

  it('keeps same-named archives in different libraries distinct', async () => {
    for (const library of ['A', 'B']) {
      const archive = path.join(dataDir, library, 'pack.zip');
      upsertAsset({
        id: `archive-${library}`,
        path: `${library}/pack.zip#/sprite.png`,
        absolutePath: archive,
        name: 'sprite.png',
        extension: '.png',
        category: 'image',
        size: 1,
        mtime: 1,
        hash: `archive-hash-${library}`,
        isArchiveEntry: true,
        archivePath: archive,
        archiveEntryPath: 'sprite.png',
      });
    }

    const app = Fastify();
    await app.register(classifiersRoutes);
    const response = await app.inject('/api/classifiers/targets');
    await app.close();

    expect(response.statusCode).toBe(200);
    const { archives, assets } = response.json();
    expect(archives).toEqual([
      { value: path.join(dataDir, 'A', 'pack.zip'), label: 'A/pack.zip' },
      { value: path.join(dataDir, 'B', 'pack.zip'), label: 'B/pack.zip' },
    ]);
    expect(assets.map((asset: { value: string }) => asset.value)).toEqual(['archive-A', 'archive-B']);
  });

  it('omits invalid root choices and includes directories inside archives', async () => {
    upsertAsset({
      id: 'root-file',
      path: 'root.png',
      absolutePath: path.join(dataDir, 'root.png'),
      name: 'root.png',
      extension: '.png',
      category: 'image',
      size: 1,
      mtime: 1,
      hash: 'root-hash',
      isArchiveEntry: false,
    });
    const archive = path.join(dataDir, 'library', 'pack.zip');
    upsertAsset({
      id: 'nested-archive-entry',
      path: 'library/pack.zip#/art/characters/hero.png',
      absolutePath: archive,
      name: 'hero.png',
      extension: '.png',
      category: 'image',
      size: 1,
      mtime: 1,
      hash: 'entry-hash',
      isArchiveEntry: true,
      archiveEntryPath: 'art/characters/hero.png',
    });

    const app = Fastify();
    await app.register(classifiersRoutes);
    const response = await app.inject('/api/classifiers/targets');
    await app.close();

    expect(response.statusCode).toBe(200);
    expect(response.json().archives).toEqual([
      { value: archive, label: 'library/pack.zip' },
    ]);
    expect(response.json().directories).toEqual([
      { value: 'library', label: 'library' },
      { value: 'library/pack.zip#/art', label: 'library/pack.zip#/art' },
      {
        value: 'library/pack.zip#/art/characters',
        label: 'library/pack.zip#/art/characters',
      },
    ]);
  });
});
