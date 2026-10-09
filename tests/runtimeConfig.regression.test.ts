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
});
