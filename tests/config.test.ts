import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  config,
  loadConfigFile,
  saveConfigFile,
  getEffectiveConfig,
  resetConfigForTesting,
  resolveConfigPath,
  resolveDataDir,
  DEFAULT_CONFIG_FILE,
  DEFAULT_DATA_DIR,
} from '../server/src/config.js';
import { getAppSettings, updateAppSettings, getClassifierSettings, updateClassifierSettings } from '../server/src/db/database.js';
import { createTempDir, cleanupTempDir } from './helpers.js';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';

describe('Server Config & YAML Persistence', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir('config-test-');
    resetConfigForTesting();
  });

  afterEach(() => {
    resetConfigForTesting();
    cleanupTempDir(tempDir);
  });

  it('should expose default configuration values', () => {
    expect(config).toBeDefined();
    expect(typeof config.port).toBe('number');
    expect(typeof config.host).toBe('string');
    expect(config.cacheDirName).toBe('.assettlor');
    expect(config.defaultLibraryPath).toContain(path.join('sample', 'assets'));
    expect(config.defaultActiveProjectPath).toContain(path.join('sample', 'game-project'));
    expect(config.appDataDir).toContain('.assettlor');
  });

  it('should have default config path pointing to ~/.config/assetlor/config.yaml', () => {
    expect(DEFAULT_CONFIG_FILE).toContain(path.join('.config', 'assetlor', 'config.yaml'));
    expect(DEFAULT_DATA_DIR).toContain(path.join('.config', 'assetlor', 'data'));
  });

  it('should load sample/config.yaml properly with libraries, projects, port, and classifiers', () => {
    const sampleConfigPath = path.join(process.cwd(), 'sample', 'config.yaml');
    expect(fs.existsSync(sampleConfigPath)).toBe(true);

    const loaded = loadConfigFile(sampleConfigPath);
    expect(loaded.server?.port).toBe(3001);
    expect(loaded.server?.host).toBe('0.0.0.0');
    expect(loaded.libraries).toBeDefined();
    expect(loaded.libraries?.length).toBeGreaterThan(0);
    expect(loaded.libraries?.[0]).toContain(path.join('sample', 'assets'));
    expect(loaded.projects?.[0]).toContain(path.join('sample', 'game-project'));
    expect(loaded.data_dir).toContain(path.join('sample', '.assettlor'));
    expect(loaded.classifiers?.bpm?.enabled).toBe(true);
    expect(loaded.pipeline?.thumbnail_quality).toBe(80);
    expect(loaded.pipeline?.default_fps).toBe(12);
  });

  it('should save and persist config updates to a custom YAML file', () => {
    const customConfigPath = path.join(tempDir, 'my-config.yaml');
    loadConfigFile(customConfigPath);

    // Update settings via updateAppSettings
    const libDir = path.join(tempDir, 'custom-assets');
    const projDir = path.join(tempDir, 'custom-game');

    updateAppSettings({
      libraryPaths: [libDir],
      projectPaths: [projDir],
      thumbnailQuality: 90,
      defaultFps: 24,
    });

    // Check YAML file on disk
    expect(fs.existsSync(customConfigPath)).toBe(true);
    const diskContent = fs.readFileSync(customConfigPath, 'utf-8');
    const parsed = YAML.parse(diskContent);

    expect(parsed.libraries).toEqual([libDir]);
    expect(parsed.projects).toEqual([projDir]);
    expect(parsed.pipeline.thumbnail_quality).toBe(90);
    expect(parsed.pipeline.default_fps).toBe(24);

    // Update classifier settings via updateClassifierSettings
    updateClassifierSettings('bpm', { minBpm: 70, maxBpm: 190 });
    const diskAfterClassifier = fs.readFileSync(customConfigPath, 'utf-8');
    const parsedAfter = YAML.parse(diskAfterClassifier);

    expect(parsedAfter.classifiers.bpm.minBpm).toBe(70);
    expect(parsedAfter.classifiers.bpm.maxBpm).toBe(190);
  });

  it('should resolve data_dir correctly whether named .assettlor, data, or custom folder', () => {
    expect(resolveDataDir('/tmp/test-lib/.assettlor')).toBe('/tmp/test-lib/.assettlor');
    expect(resolveDataDir('/tmp/test-lib/data')).toBe('/tmp/test-lib/data');
    expect(resolveDataDir('/tmp/test-lib')).toBe('/tmp/test-lib/.assettlor');
  });

  it('should resolve relative paths relative to config file directory or cwd', () => {
    const configDir = path.join(process.cwd(), 'sample');
    const resolvedAsset = resolveConfigPath('./sample/assets', configDir);
    expect(resolvedAsset).toBe(path.join(process.cwd(), 'sample', 'assets'));

    const resolvedRelative = resolveConfigPath('./assets', configDir);
    expect(resolvedRelative).toBe(path.join(process.cwd(), 'sample', 'assets'));
  });
});
