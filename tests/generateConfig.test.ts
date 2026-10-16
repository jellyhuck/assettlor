import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import {
  config,
  ConfigValidationError,
  DEFAULT_DATA_DIR,
  generateConfigFile,
  loadConfigFile,
  resetConfigForTesting,
} from '../server/src/config.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

const execFileAsync = promisify(execFile);
const BIN_PATH = path.resolve(import.meta.dirname, '../bin/assettlor.js');

describe('config generation', () => {
  let root: string;

  beforeEach(() => {
    root = createTempDir('generate-config-');
    resetConfigForTesting();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetConfigForTesting();
    cleanupTempDir(root);
  });

  function readYaml(file: string) {
    return YAML.parse(fs.readFileSync(file, 'utf-8'));
  }

  it('writes the defaults when no ASSETTLOR_CONF_* variables are set', () => {
    vi.stubEnv('ASSETTLOR_CONF_DATA_DIR', '');
    vi.stubEnv('ASSETTLOR_CONF_PORT', '');
    const target = path.join(root, 'nested', 'config.yaml');

    expect(generateConfigFile(target)).toBe(target);
    const written = readYaml(target);
    expect(written.server.port).toBe(3001);
    expect(written.data_dir).toBe(DEFAULT_DATA_DIR);
    expect(written.classifiers.bpm.enabled).toBe(true);
  });

  it('seeds data_dir and port from ASSETTLOR_CONF_* variables', () => {
    const dataDir = path.join(root, 'catalog');
    vi.stubEnv('ASSETTLOR_CONF_DATA_DIR', dataDir);
    vi.stubEnv('ASSETTLOR_CONF_PORT', '4100');
    const target = path.join(root, 'config.yaml');

    generateConfigFile(target);
    const written = readYaml(target);
    expect(written.data_dir).toBe(dataDir);
    expect(written.server.port).toBe(4100);
  });

  it('resolves a relative ASSETTLOR_CONF_DATA_DIR from the working directory', () => {
    vi.stubEnv('ASSETTLOR_CONF_DATA_DIR', 'relative-data');
    const target = path.join(root, 'config.yaml');

    generateConfigFile(target);
    expect(readYaml(target).data_dir).toBe(path.resolve('relative-data'));
  });

  it('rejects an invalid ASSETTLOR_CONF_PORT without writing a file', () => {
    vi.stubEnv('ASSETTLOR_CONF_PORT', 'not-a-port');
    const target = path.join(root, 'config.yaml');

    expect(() => generateConfigFile(target)).toThrow(ConfigValidationError);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('refuses to replace an existing file', () => {
    const target = path.join(root, 'config.yaml');
    fs.writeFileSync(target, 'server:\n  port: 5000\n');

    expect(() => generateConfigFile(target)).toThrow('already exists');
    expect(fs.readFileSync(target, 'utf-8')).toBe('server:\n  port: 5000\n');
  });

  it('applies ASSETTLOR_CONF_* variables when the initial setup creates a missing config', () => {
    const dataDir = path.join(root, 'catalog');
    vi.stubEnv('ASSETTLOR_CONF_DATA_DIR', dataDir);
    vi.stubEnv('ASSETTLOR_CONF_PORT', '4200');
    const target = path.join(root, 'config.yaml');

    loadConfigFile(target);
    expect(readYaml(target)).toMatchObject({ data_dir: dataDir, server: { port: 4200 } });
    expect(config.port).toBe(4200);
    expect(config.dataDir).toBe(path.join(dataDir, '.assettlor'));
  });

  it('ignores ASSETTLOR_CONF_* variables when the config already exists', () => {
    const target = path.join(root, 'config.yaml');
    fs.writeFileSync(target, 'server:\n  port: 5000\ndata_dir: ./data\n');
    vi.stubEnv('ASSETTLOR_CONF_DATA_DIR', path.join(root, 'other'));
    vi.stubEnv('ASSETTLOR_CONF_PORT', '4300');

    const loaded = loadConfigFile(target);
    expect(loaded.server?.port).toBe(5000);
    expect(loaded.data_dir).toBe(path.join(root, 'data'));
    expect(config.port).toBe(5000);
  });

  describe('--generate-config command line', () => {
    function runBin(args: string[], env: Record<string, string> = {}) {
      const { VITEST: _vitest, PORT: _port, ...baseEnv } = process.env;
      return execFileAsync(process.execPath, [BIN_PATH, ...args], {
        cwd: root,
        env: { ...baseEnv, HOME: root, ...env },
        timeout: 30000,
      });
    }

    it('writes only the requested file and exits', async () => {
      const target = path.join(root, 'out', 'config.yaml');
      const { stdout } = await runBin(['--generate-config', target], {
        ASSETTLOR_CONF_DATA_DIR: 'data',
        ASSETTLOR_CONF_PORT: '4400',
      });

      expect(stdout).toContain(target);
      expect(readYaml(target)).toMatchObject({
        data_dir: path.join(fs.realpathSync(root), 'data'),
        server: { port: 4400 },
      });
      // The default configuration under HOME is neither created nor read.
      expect(fs.existsSync(path.join(root, '.config'))).toBe(false);
    });

    it('fails without touching an existing file', async () => {
      const target = path.join(root, 'config.yaml');
      fs.writeFileSync(target, 'server:\n  port: 5000\n');

      await expect(runBin([`--generate-config=${target}`])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('already exists'),
      });
      expect(fs.readFileSync(target, 'utf-8')).toBe('server:\n  port: 5000\n');
    });

    it('fails when the path is missing', async () => {
      await expect(runBin(['--generate-config'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('requires a path'),
      });
      expect(fs.existsSync(path.join(root, '.config'))).toBe(false);
    });
  });
});
