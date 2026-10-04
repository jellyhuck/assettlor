import { describe, it, expect } from 'vitest';
import { config } from '../server/src/config.js';
import fs from 'fs';

describe('Server Config', () => {
  it('should expose default configuration values', () => {
    expect(config).toBeDefined();
    expect(typeof config.port).toBe('number');
    expect(typeof config.host).toBe('string');
    expect(config.cacheDirName).toBe('.assettlor');
    expect(config.defaultLibraryPath).toContain('sample-assets');
    expect(config.defaultActiveProjectPath).toContain('sample-game-project');
    expect(config.appDataDir).toContain('.assettlor');
  });

  it('should ensure appDataDir exists on system', () => {
    expect(fs.existsSync(config.appDataDir)).toBe(true);
  });
});
