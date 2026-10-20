import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../server/src/index.js';
import {
  ConfigValidationError,
  libraryEntries,
  loadConfigFile,
  resetConfigForTesting,
  saveConfigFile,
} from '../server/src/config.js';
import {
  closeDatabase,
  getAllLibraries,
  getAppSettings,
  initDatabase,
  queryAssets,
  updateAppSettings,
  upsertAsset,
} from '../server/src/db/database.js';
import { compileFilterExpression, parseLibraryClause } from '../server/src/services/filterParser.js';
import type { LibrarySource } from '../server/src/services/librarySources.js';
import { formatFilterToken, parseFiltersFromQuery, updateSearchFilter } from '../shared/filterSync.js';
import { cleanupTempDir, createTempDir } from './helpers.js';

describe('library names in configuration', () => {
  let configDir: string;
  let configPath: string;

  beforeEach(() => {
    configDir = createTempDir('library-names-config-');
    configPath = path.join(configDir, 'config.yaml');
  });

  afterEach(() => {
    resetConfigForTesting();
    cleanupTempDir(configDir);
  });

  it('reads named entries, folds name: into names, and dedupes within an entry', () => {
    fs.writeFileSync(configPath, YAML.stringify({
      libraries: [
        './assets',
        { path: './kenney', names: [' Kenney ', 'CC0', 'kenney', ''] },
        { path: './more', name: 'CC0' },
      ],
    }));
    const loaded = loadConfigFile(configPath);
    expect(libraryEntries(loaded)).toEqual([
      { path: path.join(configDir, 'assets'), names: [] },
      { path: path.join(configDir, 'kenney'), names: ['Kenney', 'CC0'] },
      { path: path.join(configDir, 'more'), names: ['CC0'] },
    ]);
  });

  it('writes unnamed entries as paths and named ones as path and names', () => {
    fs.writeFileSync(configPath, YAML.stringify({ libraries: ['./assets', { path: './kenney', name: 'Kenney' }] }));
    loadConfigFile(configPath);
    saveConfigFile({});
    const written = YAML.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(written.libraries).toEqual(['./assets', { path: './kenney', names: ['Kenney'] }]);
  });

  it('rejects malformed entries', () => {
    for (const libraries of [[{ names: ['x'] }], [{ path: './a', names: 'x' }], [{ path: './a', name: 3 }], [42]]) {
      fs.writeFileSync(configPath, YAML.stringify({ libraries }));
      expect(() => loadConfigFile(configPath)).toThrow(ConfigValidationError);
    }
  });
});

describe('lib: filter compilation', () => {
  const libraries: LibrarySource[] = [
    { path: '/libs/kenney', names: ['Kenney', 'CC0'] },
    { path: '/libs/more', names: ['CC0'] },
    { path: '/libs/assets', names: [] },
    { path: '/libs/sci fi', names: ['Sci-Fi Kit'] },
  ];

  it('matches any alias, ignoring case', () => {
    for (const query of ['lib:kenney', 'library:KENNEY']) {
      const res = compileFilterExpression(query, false, libraries);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('a.source_directory IN (?)');
      expect(res.args).toEqual(['/libs/kenney']);
    }
  });

  it('matches every library sharing a name', () => {
    expect(compileFilterExpression('lib:cc0', false, libraries).args).toEqual(['/libs/kenney', '/libs/more']);
  });

  it('falls back to the folder name for a library without names', () => {
    expect(compileFilterExpression('lib:assets', false, libraries).args).toEqual(['/libs/assets']);
    // A named library no longer goes by its folder name.
    expect(compileFilterExpression('lib:more', false, libraries).sql).toBe('0');
  });

  it('treats unquoted * as a wildcard and quoted values as literals', () => {
    expect(compileFilterExpression('lib:ken*', false, libraries).args).toEqual(['/libs/kenney']);
    expect(compileFilterExpression('lib:"Sci-Fi Kit"', false, libraries).args).toEqual(['/libs/sci fi']);
    expect(parseLibraryClause('ken*', libraries, true)?.sql).toBe('0');
    expect(parseLibraryClause('sci.fi*', libraries)?.sql).toBe('0');
  });

  it('matches nothing for an unknown name instead of searching text', () => {
    expect(compileFilterExpression('lib:nope', false, libraries)).toEqual({ sql: '0', args: [], isParsed: true });
    expect(compileFilterExpression('lib:nope', false).sql).toBe('0');
  });

  it('combines with Boolean operators', () => {
    const res = compileFilterExpression('lib:kenney OR NOT lib:assets', false, libraries);
    expect(res.sql).toBe('((a.source_directory IN (?)) OR (NOT (a.source_directory IN (?))))');
    expect(res.args).toEqual(['/libs/kenney', '/libs/assets']);
    expect(compileFilterExpression('lib:', false, libraries).sql).toBe('');
  });
});

describe('library settings and queries', () => {
  let root: string;
  let kenney: string;
  let more: string;
  let assets: string;

  const asset = (id: string, sourceDirectory: string) => upsertAsset({
    id, path: `${id}.png`, absolutePath: path.join(sourceDirectory, `${id}.png`), name: `${id}.png`,
    extension: '.png', category: 'image', size: 10, mtime: 1000, hash: `hash-${id}`,
    isArchiveEntry: false, sourceDirectory, metadata: {},
  });
  const ids = (params: Parameters<typeof queryAssets>[0]) =>
    queryAssets({ limit: 200, ...params }).items.map((item) => item.id).sort();

  beforeEach(() => {
    root = createTempDir('library-names-db-');
    kenney = path.join(root, 'kenney');
    more = path.join(root, 'more');
    assets = path.join(root, 'assets');
    initDatabase(root);
    updateAppSettings({
      libraryPaths: [kenney, more, assets],
      libraryNames: { [kenney]: ['Kenney', 'CC0'], [more]: ['cc0'] },
    });
    asset('coin', kenney);
    asset('gem', more);
    asset('logo', assets);
  });

  afterEach(() => {
    closeDatabase();
    resetConfigForTesting();
    cleanupTempDir(root);
  });

  it('exposes names by path and keeps them when libraries move or are removed', () => {
    expect(getAppSettings().libraryNames).toEqual({ [kenney]: ['Kenney', 'CC0'], [more]: ['cc0'] });
    updateAppSettings({ libraryPaths: [assets, kenney] });
    expect(getAppSettings().libraryPaths).toEqual([assets, kenney]);
    expect(getAppSettings().libraryNames).toEqual({ [kenney]: ['Kenney', 'CC0'] });
    updateAppSettings({ libraryNames: { [assets]: ['Base'] } });
    expect(getAppSettings().libraryNames).toEqual({ [assets]: ['Base'] });
    expect(() => updateAppSettings({ libraryNames: { [assets]: 'Base' } as never })).toThrow(ConfigValidationError);
  });

  it('filters by search token and query parameter', () => {
    expect(ids({ search: 'lib:kenney' })).toEqual(['coin']);
    expect(ids({ search: 'lib:CC0' })).toEqual(['coin', 'gem']);
    expect(ids({ library: 'assets' })).toEqual(['logo']);
    expect(ids({ search: 'lib:nope' })).toEqual([]);
    expect(ids({ search: 'lib:cc0', isStackedView: true })).toEqual(['coin', 'gem']);
  });

  it('lists each name once with its paths and asset count', () => {
    expect(getAllLibraries()).toEqual([
      { name: 'Kenney', paths: [kenney], count: 1 },
      { name: 'CC0', paths: [kenney, more], count: 2 },
      { name: 'assets', paths: [assets], count: 1 },
    ]);
  });

  describe('HTTP routes', () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await buildServer({ initDb: false, logger: false });
      await app.ready();
    });

    afterEach(async () => {
      await app.close();
    });

    it('serves library facets, filters, and names in settings', async () => {
      const libraries = await app.inject({ method: 'GET', url: '/api/libraries' });
      expect(libraries.statusCode).toBe(200);
      expect(libraries.json().map((info: { name: string }) => info.name)).toEqual(['Kenney', 'CC0', 'assets']);

      const bySearch = await app.inject({ method: 'GET', url: `/api/assets?search=${encodeURIComponent('lib:cc0')}` });
      expect(bySearch.json().items.map((item: { id: string }) => item.id).sort()).toEqual(['coin', 'gem']);
      const byParam = await app.inject({ method: 'GET', url: '/api/assets?library=Kenney' });
      expect(byParam.json().items.map((item: { id: string }) => item.id)).toEqual(['coin']);

      const settings = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(settings.json().libraryNames).toEqual({ [kenney]: ['Kenney', 'CC0'], [more]: ['cc0'] });
    });
  });
});

describe('library filter search syncing', () => {
  it('formats sidebar selections as lib tokens', () => {
    expect(formatFilterToken('library', 'Kenney')).toBe('lib:Kenney');
    expect(formatFilterToken('library', 'Sci-Fi Kit')).toBe('lib:"Sci-Fi Kit"');
    expect(formatFilterToken('library', 'any')).toBe('lib:any');
  });

  it('reads and replaces a library selection in the search query', () => {
    expect(parseFiltersFromQuery('coin library:Kenney').library).toBe('kenney');
    expect(parseFiltersFromQuery('lib:"Sci-Fi Kit"').library).toBe('Sci-Fi Kit');
    expect(updateSearchFilter('coin lib:kenney', 'library', 'CC0')).toBe('coin lib:CC0');
    expect(updateSearchFilter('coin lib:kenney', 'library', null)).toBe('coin');
  });
});
