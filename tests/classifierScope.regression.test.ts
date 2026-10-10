import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'path';
import Fastify from 'fastify';
import {
  closeDatabase,
  findAssetsByScope,
  initDatabase,
  upsertAsset,
} from '../server/src/db/database.js';
import { classifiersRoutes } from '../server/src/routes/classifiers.js';
import { bpmClassifier } from '../server/src/services/classifiers/bpmClassifier.js';
import { runClassifier } from '../server/src/services/classifiers/engine.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('Classifier target scope', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('classifier-scope-');
    initDatabase(tempDir);
  });

  afterEach(() => {
    closeDatabase();
    cleanupTempDir(tempDir);
  });

  function addAsset(
    id: string,
    displayPath: string,
    absolutePath: string,
    archivePath?: string,
  ): void {
    upsertAsset({
      id,
      path: displayPath,
      absolutePath,
      name: path.posix.basename(displayPath),
      extension: '.wav',
      category: 'audio',
      size: 1,
      mtime: 1,
      hash: id,
      isArchiveEntry: archivePath !== undefined,
      archivePath,
      archiveEntryPath: archivePath ? 'inner/track.wav' : undefined,
      metadata: {},
    });
  }

  it('resolves archive identity without basename or suffix collisions', () => {
    const first = path.join(tempDir, 'libA', 'pack.zip');
    const second = path.join(tempDir, 'libB', 'pack.zip');
    const suffix = path.join(tempDir, 'libB', 'otherpack.zip');
    addAsset('a', 'libA/pack.zip#/inner/track.wav', first, first);
    addAsset('b', 'libB/pack.zip#/inner/track.wav', second, second);
    addAsset('c', 'libB/otherpack.zip#/inner/track.wav', suffix, suffix);

    expect(findAssetsByScope({ targetType: 'archive', targetValue: first }).map((asset) => asset.id)).toEqual(['a']);
    expect(findAssetsByScope({ targetType: 'archive', targetValue: 'libB/pack.zip' }).map((asset) => asset.id)).toEqual(['b']);
    expect(() => findAssetsByScope({ targetType: 'archive', targetValue: 'pack.zip' })).toThrow(/ambiguous/i);
    expect(findAssetsByScope({ targetType: 'archive', targetValue: 'missing.zip' })).toEqual([]);
  });

  it('matches literal relative catalog directories on component boundaries', () => {
    const root = path.join(tempDir, 'lib');
    addAsset('foo', 'foo/one.wav', path.join(root, 'foo', 'one.wav'));
    addAsset('nested', 'foo/sub/two.wav', path.join(root, 'foo', 'sub', 'two.wav'));
    addAsset('foobar', 'foobar/three.wav', path.join(root, 'foobar', 'three.wav'));
    addAsset('literal', 'sounds%_/four.wav', path.join(root, 'sounds%_', 'four.wav'));
    addAsset('wildcard', 'soundsXX/five.wav', path.join(root, 'soundsXX', 'five.wav'));

    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'foo' }).map((asset) => asset.id).sort())
      .toEqual(['foo', 'nested']);
    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'foo\\sub' }).map((asset) => asset.id))
      .toEqual(['nested']);
    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'sounds%_' }).map((asset) => asset.id))
      .toEqual(['literal']);
  });

  it('distinguishes absolute source directories from relative catalog paths', () => {
    const firstRoot = path.join(tempDir, 'libA');
    const secondRoot = path.join(tempDir, 'libB');
    addAsset('a', 'catalogA/music/one.wav', path.join(firstRoot, 'music', 'one.wav'));
    addAsset('b', 'catalogB/music/two.wav', path.join(secondRoot, 'music', 'two.wav'));
    addAsset('c', 'music/three.wav', path.join(secondRoot, 'other', 'three.wav'));

    expect(findAssetsByScope({ targetType: 'directory', targetValue: path.join(firstRoot, 'music') })
      .map((asset) => asset.id)).toEqual(['a']);
    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'music' })
      .map((asset) => asset.id)).toEqual(['c']);
  });

  it('normalizes Windows separators for both directory and archive identities', () => {
    addAsset('disk', 'windows\\music\\song.wav', 'C:\\library\\music\\song.wav');
    addAsset('zip', 'windows\\pack.zip#/inner/track.wav', 'C:\\library\\pack.zip', 'C:\\library\\pack.zip');

    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'windows/music' })
      .map((asset) => asset.id)).toEqual(['disk']);
    expect(findAssetsByScope({ targetType: 'directory', targetValue: 'C:\\library\\music' })
      .map((asset) => asset.id)).toEqual(['disk']);
    expect(findAssetsByScope({ targetType: 'archive', targetValue: 'C:\\library\\pack.zip' })
      .map((asset) => asset.id)).toEqual(['zip']);
  });

  it('never expands an invalid or missing selector into the entire catalog', async () => {
    addAsset('one', 'music/one.wav', path.join(tempDir, 'music', 'one.wav'));

    for (const [targetType, targetValue] of [
      ['asset', undefined], ['asset', '   '], ['asset', []], ['asset', ['one', '']],
      ['directory', undefined], ['directory', '  '], ['directory', ['music']],
      ['archive', undefined], ['archive', '\t'], ['archive', ['pack.zip']],
      [undefined, undefined], ['unknown', 'one'],
    ] as const) {
      expect(() => findAssetsByScope({ targetType: targetType as never, targetValue: targetValue as never }))
        .toThrow();
      await expect(runClassifier(bpmClassifier, {
        targetType: targetType as never,
        targetValue: targetValue as never,
      })).rejects.toThrow();
    }

    expect(findAssetsByScope({ targetType: 'asset', targetValue: 'missing-id' })).toEqual([]);
    expect(findAssetsByScope({ targetType: 'all' })).toHaveLength(1);
  });

  it('returns HTTP 400 for invalid run scopes and targets no missing asset IDs', async () => {
    addAsset('one', 'music/one.wav', path.join(tempDir, 'music', 'one.wav'));
    const firstArchive = path.join(tempDir, 'libA', 'pack.zip');
    const secondArchive = path.join(tempDir, 'libB', 'pack.zip');
    addAsset('archive-a', 'libA/pack.zip#/inner/track.wav', firstArchive, firstArchive);
    addAsset('archive-b', 'libB/pack.zip#/inner/track.wav', secondArchive, secondArchive);
    const app = Fastify();
    await app.register(classifiersRoutes);
    await app.ready();

    try {
      for (const payload of [
        {},
        { targetType: 'asset', targetValue: '' },
        { targetType: 'directory', targetValue: [] },
        { targetType: 'archive', targetValue: null },
        { targetType: 'archive', targetValue: 'pack.zip' },
        { targetType: 'all', targetValue: '' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/api/classifiers/bpm/run', payload });
        expect(response.statusCode).toBe(400);
      }

      const response = await app.inject({
        method: 'POST',
        url: '/api/classifiers/bpm/run',
        payload: { targetType: 'asset', targetValue: 'missing-id' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().totalTargeted).toBe(0);
    } finally {
      await app.close();
    }
  });
});
