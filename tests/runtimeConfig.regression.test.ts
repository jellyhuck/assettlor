import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { buildServer } from '../server/src/index.js';
import {
  getEffectiveConfig,
  loadConfigFile,
  resetConfigForTesting,
  saveConfigFile,
} from '../server/src/config.js';
import { createTempDir, cleanupTempDir } from './helpers.js';
import { getAppSettings, initDatabase, updateAppSettings } from '../server/src/db/database.js';
import { parseCliConfigArg, resolveConfigPath } from '../server/src/config.js';

describe('durable runtime configuration', () => {
  let root: string;
  let configPath: string;

  beforeEach(() => {
    root = createTempDir('runtime-config-');
    configPath = path.join(root, 'config.yaml');
    loadConfigFile(configPath);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetConfigForTesting();
    cleanupTempDir(root);
  });

  it.each(['write', 'rename'] as const)(
    'keeps the file and active settings when a %s fails',
    (operation) => {
      const beforeFile = fs.readFileSync(configPath, 'utf-8');
      const beforeEffective = structuredClone(getEffectiveConfig());
      vi.spyOn(fs, operation === 'write' ? 'writeFileSync' : 'renameSync')
        .mockImplementationOnce(() => { throw new Error('injected failure'); });

      expect(() => saveConfigFile({ libraries: [path.join(root, 'new-library')] }))
        .toThrow('Failed to save config file');
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeFile);
      expect(getEffectiveConfig()).toEqual(beforeEffective);
      expect(fs.readdirSync(root)).toEqual(['config.yaml']);
    }
  );

  it('reports a failed save through the settings API', async () => {
    const app = await buildServer({ initDb: false, logger: false });
    try {
      const before = fs.readFileSync(configPath, 'utf-8');
      vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
        throw new Error('injected rename failure');
      });
      const response = await app.inject({
        method: 'POST',
        url: '/api/settings',
        headers: { host: 'localhost:3001' },
        payload: { libraryPaths: [path.join(root, 'new-library')] },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error: expect.any(String) });
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
      expect(getEffectiveConfig().libraries).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('reloads successive partial updates without losing earlier fields', () => {
    const library = path.join(root, 'assets');
    saveConfigFile({ libraries: [library] });
    saveConfigFile({ pipeline: { default_fps: 24 } });

    expect(loadConfigFile(configPath).libraries).toEqual([library]);
    expect(getEffectiveConfig().pipeline?.default_fps).toBe(24);
  });

  it('resolves load and save paths from the config directory regardless of cwd contents', () => {
    const expected = path.join(root, 'assets');
    expect(resolveConfigPath('./assets', root)).toBe(expected);
    fs.writeFileSync(configPath, 'data_dir: ./data\nlibraries:\n  - ./assets\nprojects:\n  - ./game\n');
    expect(loadConfigFile(configPath).libraries).toEqual([expected]);
    saveConfigFile({ libraries: ['./other-assets'] });
    expect(getEffectiveConfig().libraries).toEqual([path.join(root, 'other-assets')]);
    expect(loadConfigFile(configPath).libraries).toEqual([path.join(root, 'other-assets')]);
  });

  it('keeps malformed YAML and the previously loaded configuration intact', () => {
    const badPath = path.join(root, 'bad.yaml');
    const invalidYaml = 'libraries: [unclosed';
    fs.writeFileSync(badPath, invalidYaml);
    const before = structuredClone(getEffectiveConfig());

    expect(() => loadConfigFile(badPath)).toThrow('Invalid YAML configuration');
    expect(getEffectiveConfig()).toEqual(before);
    saveConfigFile({ libraries: [path.join(root, 'good-assets')] });
    expect(fs.readFileSync(badPath, 'utf-8')).toBe(invalidYaml);
  });

  it('preserves equals signs in the --config argument', () => {
    const originalArgv = process.argv;
    try {
      process.argv = ['node', 'app', '--config=a=b.yaml'];
      expect(parseCliConfigArg()).toBe('a=b.yaml');
    } finally {
      process.argv = originalArgv;
    }
  });

  it.each([
    { libraryPaths: [12] },
    { projectPaths: 'bad' },
    { libraryPath: null },
    { thumbnailQuality: 0 },
    { thumbnailQuality: 101 },
    { thumbnailQuality: '80' },
    { defaultFps: 0 },
    { defaultFps: 61 },
    { autoStackAnimations: 'false' },
    { autoStackAudio: 1 },
    { catalogPaging: 'infinite' },
    { catalogPaging: true },
  ])('rejects invalid settings update %j without changing state', async (payload) => {
    const app = await buildServer({ initDb: false, logger: false });
    try {
      const beforeFile = fs.readFileSync(configPath, 'utf-8');
      const beforeEffective = structuredClone(getEffectiveConfig());
      const response = await app.inject({
        method: 'POST',
        url: '/api/settings',
        headers: { host: 'localhost:3001' },
        payload,
      });
      expect(response.statusCode).toBe(400);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(beforeFile);
      expect(getEffectiveConfig()).toEqual(beforeEffective);
    } finally {
      await app.close();
    }
  });

  it('rejects null and array settings bodies', async () => {
    const app = await buildServer({ initDb: false, logger: false });
    try {
      for (const payload of ['null', '[]']) {
        const response = await app.inject({
          method: 'POST',
          url: '/api/settings',
          headers: { host: 'localhost:3001', 'content-type': 'application/json' },
          payload,
        });
        expect(response.statusCode).toBe(400);
      }
    } finally {
      await app.close();
    }
  });

  it('rejects invalid YAML settings and non-finite API numbers', () => {
    expect(() => saveConfigFile({ server: { port: 0 } })).toThrow('server.port');
    expect(() => saveConfigFile({ pipeline: { thumbnail_quality: 101 } })).toThrow('pipeline.thumbnail_quality');
    expect(() => saveConfigFile({ pipeline: { auto_stack_audio: 'false' as never } }))
      .toThrow('pipeline.auto_stack_audio');
    expect(() => updateAppSettings({ defaultFps: Infinity })).toThrow('pipeline.default_fps');
  });

  it('keeps an empty library list empty across database startup and reload', () => {
    initDatabase(path.join(root, 'index-data'));
    expect(getAppSettings()).toMatchObject({ libraryPath: '', libraryPaths: [] });

    updateAppSettings({ libraryPaths: [] });
    expect(getAppSettings()).toMatchObject({ libraryPath: '', libraryPaths: [] });
    loadConfigFile(configPath);
    expect(getAppSettings()).toMatchObject({ libraryPath: '', libraryPaths: [] });
  });
});
