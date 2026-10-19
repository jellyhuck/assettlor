import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type {
  Asset,
  AssetCategory,
  AssetMetadata,
  AssetStack,
  TagInfo,
  FormatInfo,
  ResolutionInfo,
  BpmInfo,
  FolderInfo,
  AppSettings,
  AssetQueryParams,
  AssetListResponse,
  ClassifierTargetType,
} from '../../../shared/types.js';
import {
  config,
  getDataDir,
  getEffectiveConfig,
  saveConfigFile,
  resolveDataDir,
  resolveConfigPath,
  ConfigValidationError,
  AppYamlConfig,
} from '../config.js';
import {
  compileFilterExpression,
  parseResolutionClause,
  parseBpmClause,
  parseSpriteClause,
  parsePackClause,
  parseFolderClause,
  composePredicates,
  parseWidthClause,
  parseHeightClause,
  parseDurationClause,
} from '../services/filterParser.js';
import { canonicalAssetId } from '../services/assetIdentity.js';
import { requireAssetQuery } from '../services/assetQueryValidation.js';
import {
  InvalidClassifierScopeError,
  isAbsoluteClassifierPath,
  normalizeClassifierPath,
  validateClassifierScope,
} from '../services/classifiers/scope.js';

let dbInstance: Database.Database | null = null;
let currentDataDir: string = '';

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDatabase first.');
  }
  return dbInstance;
}

export function getCurrentDataDir(): string {
  return currentDataDir || getDataDir();
}

export function getThumbnailsDir(): string {
  return path.join(getCurrentDataDir(), 'thumbnails');
}

export function getCurrentLibraryPath(): string {
  return getAppSettings().libraryPath;
}

export function isDatabaseInitialized(): boolean {
  return dbInstance !== null;
}

export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      console.error('Error closing database:', e);
    }
    dbInstance = null;
    currentDataDir = '';
  }
}

export function initDatabase(dataDirInput?: string): Database.Database {
  const resolvedDataDir = dataDirInput
    ? resolveDataDir(dataDirInput)
    : getDataDir();

  if (dbInstance && currentDataDir === resolvedDataDir) {
    return dbInstance;
  }

  const previousDatabase = dbInstance;

  const thumbnailsDir = path.join(resolvedDataDir, 'thumbnails');

  if (!fs.existsSync(resolvedDataDir)) {
    fs.mkdirSync(resolvedDataDir, { recursive: true });
  }
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }

  const dbPath = path.join(resolvedDataDir, 'index.db');
  const db = new Database(dbPath);

  try {
    // High performance pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('temp_store = MEMORY');
    db.pragma('busy_timeout = 5000');

    // Schema creation
    db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      absolute_path TEXT NOT NULL,
      name TEXT NOT NULL,
      extension TEXT NOT NULL,
      category TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime INTEGER NOT NULL,
      hash TEXT NOT NULL,
      is_archive_entry INTEGER NOT NULL DEFAULT 0,
      archive_path TEXT,
      archive_entry_path TEXT,
      source_directory TEXT,
      thumbnail_path TEXT,
      metadata TEXT,
      stack_id TEXT,
      stack_index INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stacks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      item_count INTEGER NOT NULL,
      representative_asset_id TEXT NOT NULL,
      metadata TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      asset_id TEXT NOT NULL,
      tag TEXT NOT NULL COLLATE NOCASE,
      source TEXT NOT NULL,
      PRIMARY KEY (asset_id, tag, source),
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS asset_id_aliases (
      old_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
    CREATE INDEX IF NOT EXISTS idx_assets_extension ON assets(extension);
    CREATE INDEX IF NOT EXISTS idx_assets_stack_id ON assets(stack_id);
    CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    CREATE INDEX IF NOT EXISTS idx_tags_asset_id ON tags(asset_id);
    CREATE INDEX IF NOT EXISTS idx_stacks_type ON stacks(type);
    `);

    const assetColumns = db.pragma('table_info(assets)') as { name: string }[];
    if (!assetColumns.some((column) => column.name === 'source_directory')) {
      db.exec('ALTER TABLE assets ADD COLUMN source_directory TEXT');
    }
    migrateTagProvenance(db);
    migrateCanonicalAssetIds(db);
    migrateAutomatedTags(db);
  } catch (err) {
    db.close();
    throw err;
  }

  if (previousDatabase) {
    try {
      previousDatabase.close();
    } catch (err) {
      db.close();
      throw err;
    }
  }
  dbInstance = db;
  currentDataDir = resolvedDataDir;
  return db;
}

function migrateTagProvenance(db: Database.Database): void {
  const columns = db.pragma('table_info(tags)') as { name: string; pk: number }[];
  if (columns.find((column) => column.name === 'source')?.pk === 3) return;
  db.transaction(() => {
    db.exec(`
      CREATE TABLE tags_next (
        asset_id TEXT NOT NULL,
        tag TEXT NOT NULL COLLATE NOCASE,
        source TEXT NOT NULL,
        PRIMARY KEY (asset_id, tag, source),
        FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE
      );
      INSERT OR IGNORE INTO tags_next (asset_id, tag, source)
      SELECT asset_id, TRIM(tag), source FROM tags WHERE TRIM(tag) <> '';
      DROP TABLE tags;
      ALTER TABLE tags_next RENAME TO tags;
      CREATE INDEX idx_tags_tag ON tags(tag);
      CREATE INDEX idx_tags_asset_id ON tags(asset_id);
    `);
  })();
}

/**
 * Tags are reserved for user assignment. Earlier versions also wrote folder,
 * archive, extension, category, filename-heuristic, and classifier tags; drop
 * them, first recording classifier ownership as metadata provenance so a later
 * inconclusive run still clears the values that classifier wrote.
 */
function migrateAutomatedTags(db: Database.Database): void {
  const automated = "source IN ('folder', 'archive', 'extension', 'category', 'auto') OR source LIKE 'classifier:%'";
  if (!db.prepare(`SELECT 1 FROM tags WHERE ${automated} LIMIT 1`).get()) return;
  db.transaction(() => {
    const owners = db.prepare(`
      SELECT DISTINCT t.asset_id, t.source, a.metadata
      FROM tags t JOIN assets a ON a.id = t.asset_id
      WHERE t.source IN ('classifier:bpm', 'classifier:pack')
    `).all() as { asset_id: string; source: string; metadata: string | null }[];
    const metadataByAsset = new Map<string, AssetMetadata>();
    for (const owner of owners) {
      let metadata = metadataByAsset.get(owner.asset_id);
      if (!metadata) {
        try {
          metadata = owner.metadata ? JSON.parse(owner.metadata) as AssetMetadata : {};
        } catch {
          metadata = {};
        }
        metadataByAsset.set(owner.asset_id, metadata);
      }
      const provenance = metadata.classifierProvenance || {};
      if (owner.source === 'classifier:bpm') {
        provenance.bpm ??= { previousBpm: null, previousTempoDescription: null };
      } else {
        provenance.pack ??= { previousPack: null };
      }
      metadata.classifierProvenance = provenance;
    }
    const updateMetadata = db.prepare('UPDATE assets SET metadata = ? WHERE id = ?');
    for (const [assetId, metadata] of metadataByAsset) updateMetadata.run(JSON.stringify(metadata), assetId);
    db.prepare(`DELETE FROM tags WHERE ${automated}`).run();
  })();
}

function migrateCanonicalAssetIds(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, absolute_path, archive_entry_path, stack_id, stack_index
    FROM assets
    WHERE id LIKE 'file_%' OR id LIKE 'zip_%'
  `).all() as {
    id: string;
    absolute_path: string;
    archive_entry_path: string | null;
    stack_id: string | null;
    stack_index: number | null;
  }[];
  const replaceId = db.prepare('UPDATE assets SET id = ? WHERE id = ?');
  const replaceTagId = db.prepare('UPDATE tags SET asset_id = ? WHERE asset_id = ?');
  const replaceRepresentativeId = db.prepare('UPDATE stacks SET representative_asset_id = ? WHERE representative_asset_id = ?');
  const addAlias = db.prepare('INSERT OR REPLACE INTO asset_id_aliases (old_id, asset_id) VALUES (?, ?)');
  const migrate = db.transaction(() => {
    const affectedStacks = new Set<string>();
    for (const row of rows) {
      const nextId = canonicalAssetId(row.absolute_path, row.archive_entry_path);
      if (row.id === nextId) continue;
      // An older index may contain the same disk file under overlapping roots.
      // Merge that duplicate's curation into the canonical row.
      const duplicate = db.prepare('SELECT id, stack_id FROM assets WHERE id = ?').get(nextId) as
        { id: string; stack_id: string | null } | undefined;
      if (duplicate) {
        if (row.stack_id) affectedStacks.add(row.stack_id);
        if (duplicate.stack_id) affectedStacks.add(duplicate.stack_id);
        if (!duplicate.stack_id && row.stack_id) {
          db.prepare('UPDATE assets SET stack_id = ?, stack_index = ? WHERE id = ?')
            .run(row.stack_id, row.stack_index, nextId);
        }
        db.prepare(`
          INSERT OR IGNORE INTO tags (asset_id, tag, source)
          SELECT ?, tag, source FROM tags WHERE asset_id = ?
        `).run(nextId, row.id);
        db.prepare('DELETE FROM tags WHERE asset_id = ?').run(row.id);
        replaceRepresentativeId.run(nextId, row.id);
        db.prepare('DELETE FROM assets WHERE id = ?').run(row.id);
      } else {
        replaceId.run(nextId, row.id);
        replaceTagId.run(nextId, row.id);
        replaceRepresentativeId.run(nextId, row.id);
      }
      addAlias.run(row.id, nextId);
    }

    // A merged asset can occupy only one stack. Repair stacks that lost a
    // duplicate member so their representatives, counts, and indices agree.
    const membersStmt = db.prepare(`
      SELECT id FROM assets WHERE stack_id = ?
      ORDER BY stack_index IS NULL, stack_index, id
    `);
    const stackStmt = db.prepare('SELECT representative_asset_id FROM stacks WHERE id = ?');
    const updateMember = db.prepare('UPDATE assets SET stack_index = ? WHERE id = ?');
    const unlinkMembers = db.prepare('UPDATE assets SET stack_id = NULL, stack_index = NULL WHERE stack_id = ?');
    const deleteStack = db.prepare('DELETE FROM stacks WHERE id = ?');
    const updateStack = db.prepare('UPDATE stacks SET item_count = ?, representative_asset_id = ? WHERE id = ?');
    for (const stackId of affectedStacks) {
      const stack = stackStmt.get(stackId) as { representative_asset_id: string } | undefined;
      const members = membersStmt.all(stackId) as { id: string }[];
      if (!stack || members.length < 2) {
        unlinkMembers.run(stackId);
        if (stack) deleteStack.run(stackId);
        continue;
      }
      const representative = members.some((member) => member.id === stack.representative_asset_id)
        ? stack.representative_asset_id
        : members[0].id;
      updateStack.run(members.length, representative, stackId);
      members.forEach((member, index) => updateMember.run(index, member.id));
    }
  });
  migrate();
}

export interface AssetRow {
  id: string;
  path: string;
  absolute_path: string;
  name: string;
  extension: string;
  category: string;
  size: number;
  mtime: number;
  hash: string;
  is_archive_entry: number;
  archive_path: string | null;
  archive_entry_path: string | null;
  source_directory: string | null;
  thumbnail_path: string | null;
  metadata: string | null;
  stack_id: string | null;
  stack_index: number | null;
  created_at: number;
  updated_at: number;
}

export interface StackRow {
  id: string;
  name: string;
  type: string;
  item_count: number;
  representative_asset_id: string;
  metadata: string | null;
  created_at: number;
}

function rowToAsset(row: AssetRow, tags: string[] = []): Asset {
  let meta: AssetMetadata = {};
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      meta = {};
    }
  }

  return {
    id: row.id,
    path: row.path,
    absolutePath: row.absolute_path,
    name: row.name,
    extension: row.extension,
    category: row.category as AssetCategory,
    size: row.size,
    mtime: row.mtime,
    hash: row.hash,
    isArchiveEntry: Boolean(row.is_archive_entry),
    archivePath: row.archive_path,
    archiveEntryPath: row.archive_entry_path,
    sourceDirectory: row.source_directory || undefined,
    thumbnailUrl: row.thumbnail_path ? `/api/assets/${encodeURIComponent(row.id)}/thumbnail?t=${row.updated_at}` : '',
    fileUrl: `/api/assets/${encodeURIComponent(row.id)}/file`,
    metadata: meta,
    stackId: row.stack_id,
    stackIndex: row.stack_index,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAppSettings(): AppSettings {
  const cfg = getEffectiveConfig();
  const libraries = (cfg.libraries || []).map((p) => String(p).trim()).filter(Boolean);
  const projects = (cfg.projects || []).map((p) => String(p).trim()).filter(Boolean);
  const pipeline = cfg.pipeline || {};

  return {
    libraryPath: libraries[0] || '',
    libraryPaths: libraries,
    activeProjectPath: projects.length > 0 ? projects[0] : '',
    projectPaths: projects,
    thumbnailQuality: Number(pipeline.thumbnail_quality ?? 80),
    autoStackAnimations: pipeline.auto_stack_animations !== false,
    autoStackAudio: pipeline.auto_stack_audio !== false,
    defaultFps: Number(pipeline.default_fps ?? 12),
    catalogPaging: cfg.ui?.catalog_paging ?? 'load-more',
  };
}

export function updateAppSettings(settings: Partial<AppSettings>): AppSettings {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new ConfigValidationError('Settings must be an object');
  }
  const updates: Partial<AppYamlConfig> = {};
  const configDir = path.dirname(config.configFilePath);
  const settingPath = (value: unknown, name: string, allowEmpty = false): string => {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim())) {
      throw new ConfigValidationError(`${name} must be a ${allowEmpty ? '' : 'non-empty '}string`);
    }
    const trimmed = value.trim();
    return trimmed ? resolveConfigPath(trimmed, configDir) : '';
  };
  const settingPaths = (value: unknown, name: string): string[] => {
    if (!Array.isArray(value)) {
      throw new ConfigValidationError(`${name} must be an array of paths`);
    }
    return value.map((entry, index) => settingPath(entry, `${name}[${index}]`));
  };

  if (settings.libraryPaths !== undefined) {
    updates.libraries = settingPaths(settings.libraryPaths, 'libraryPaths');
  } else if (settings.libraryPath !== undefined) {
    const single = settingPath(settings.libraryPath, 'libraryPath', true);
    if (single) {
      const current = getAppSettings();
      let paths = [...current.libraryPaths];
      if (!paths.includes(single)) {
        paths = [single, ...paths];
      } else {
        paths = [single, ...paths.filter((p) => p !== single)];
      }
      updates.libraries = paths;
    } else {
      updates.libraries = [];
    }
  }

  if (settings.projectPaths !== undefined) {
    updates.projects = settingPaths(settings.projectPaths, 'projectPaths');
  } else if (settings.activeProjectPath !== undefined) {
    const singleProj = settingPath(settings.activeProjectPath, 'activeProjectPath', true);
    if (singleProj) {
      const current = getAppSettings();
      let pPaths = [...current.projectPaths];
      if (!pPaths.includes(singleProj)) {
        pPaths = [singleProj, ...pPaths];
      } else {
        pPaths = [singleProj, ...pPaths.filter((p) => p !== singleProj)];
      }
      updates.projects = pPaths;
    } else {
      updates.projects = [];
    }
  }

  const currentCfg = getEffectiveConfig();
  const pipeline = { ...(currentCfg.pipeline || {}) };
  let hasPipelineUpdates = false;

  if (settings.thumbnailQuality !== undefined) {
    pipeline.thumbnail_quality = settings.thumbnailQuality;
    hasPipelineUpdates = true;
  }
  if (settings.autoStackAnimations !== undefined) {
    pipeline.auto_stack_animations = settings.autoStackAnimations;
    hasPipelineUpdates = true;
  }
  if (settings.autoStackAudio !== undefined) {
    pipeline.auto_stack_audio = settings.autoStackAudio;
    hasPipelineUpdates = true;
  }
  if (settings.defaultFps !== undefined) {
    pipeline.default_fps = settings.defaultFps;
    hasPipelineUpdates = true;
  }

  if (hasPipelineUpdates) {
    updates.pipeline = pipeline;
  }
  if (settings.catalogPaging !== undefined) {
    updates.ui = { ...currentCfg.ui, catalog_paging: settings.catalogPaging };
  }

  saveConfigFile(updates);
  return getAppSettings();
}

export function getAssetById(id: string): Asset | null {
  const db = getDatabase();
  const row = db.prepare(`
    SELECT * FROM assets WHERE id = COALESCE(
      (SELECT asset_id FROM asset_id_aliases WHERE old_id = ?), ?
    )
  `).get(id, id) as AssetRow | undefined;
  if (!row) return null;

  const tagRows = db.prepare('SELECT DISTINCT tag FROM tags WHERE asset_id = ?').all(row.id) as { tag: string }[];
  const tags = tagRows.map((t) => t.tag);
  return rowToAsset(row, tags);
}

export function getAssetByPath(assetPath: string): Asset | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM assets WHERE path = ?').get(assetPath) as AssetRow | undefined;
  if (!row) return null;

  const tagRows = db.prepare('SELECT DISTINCT tag FROM tags WHERE asset_id = ?').all(row.id) as { tag: string }[];
  const tags = tagRows.map((t) => t.tag);
  return rowToAsset(row, tags);
}

export interface ScanCacheRecord {
  id: string;
  path: string;
  absolutePath: string;
  archivePath: string | null;
  sourceDirectory: string | null;
  hash: string;
  size: number;
  mtime: number;
  thumbnailPath: string | null;
  metadata: AssetMetadata;
}

export function getScanCacheRecord(id: string): ScanCacheRecord | null {
  const row = getDatabase().prepare(`
    SELECT id, path, absolute_path, archive_path, source_directory, hash, size, mtime,
      thumbnail_path, metadata FROM assets WHERE id = ?
  `).get(id) as Pick<AssetRow,
    'id' | 'path' | 'absolute_path' | 'archive_path' | 'source_directory' |
    'hash' | 'size' | 'mtime' | 'thumbnail_path' | 'metadata'> | undefined;
  if (!row) return null;
  let metadata: AssetMetadata = {};
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as AssetMetadata;
    } catch {
      metadata = {};
    }
  }
  return {
    id: row.id,
    path: row.path,
    absolutePath: row.absolute_path,
    archivePath: row.archive_path,
    sourceDirectory: row.source_directory,
    hash: row.hash,
    size: row.size,
    mtime: row.mtime,
    thumbnailPath: row.thumbnail_path,
    metadata,
  };
}

export function upsertAsset(asset: {
  id: string;
  path: string;
  absolutePath: string;
  name: string;
  extension: string;
  category: string;
  size: number;
  mtime: number;
  hash: string;
  isArchiveEntry: boolean;
  archivePath?: string | null;
  archiveEntryPath?: string | null;
  sourceDirectory?: string | null;
  thumbnailPath?: string | null;
  metadata?: AssetMetadata;
}): void {
  const db = getDatabase();
  const now = Date.now();

  const upsertStmt = db.prepare(`
    INSERT INTO assets (
      id, path, absolute_path, name, extension, category, size, mtime, hash,
      is_archive_entry, archive_path, archive_entry_path, source_directory, thumbnail_path,
      metadata, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      path = excluded.path,
      absolute_path = excluded.absolute_path,
      name = excluded.name,
      extension = excluded.extension,
      category = excluded.category,
      size = excluded.size,
      mtime = excluded.mtime,
      hash = excluded.hash,
      is_archive_entry = excluded.is_archive_entry,
      archive_path = excluded.archive_path,
      archive_entry_path = excluded.archive_entry_path,
      source_directory = excluded.source_directory,
      thumbnail_path = excluded.thumbnail_path,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  const tx = db.transaction(() => {
    const pathOwner = db.prepare('SELECT id, absolute_path, archive_entry_path FROM assets WHERE path = ?').get(asset.path) as
      { id: string; absolute_path: string; archive_entry_path: string | null } | undefined;
    if (pathOwner && pathOwner.id !== asset.id) {
      if (path.resolve(pathOwner.absolute_path) !== path.resolve(asset.absolutePath) ||
          (pathOwner.archive_entry_path || null) !== (asset.archiveEntryPath || null)) {
        throw new Error(`Display path belongs to another source: ${asset.path}`);
      }
      db.prepare('UPDATE stacks SET representative_asset_id = ? WHERE representative_asset_id = ?')
        .run(asset.id, pathOwner.id);
      db.prepare('UPDATE assets SET id = ? WHERE id = ?').run(asset.id, pathOwner.id);
      db.prepare('UPDATE tags SET asset_id = ? WHERE asset_id = ?').run(asset.id, pathOwner.id);
      db.prepare('INSERT OR REPLACE INTO asset_id_aliases (old_id, asset_id) VALUES (?, ?)')
        .run(pathOwner.id, asset.id);
    }
    const previous = db.prepare('SELECT hash, metadata FROM assets WHERE id = ?').get(asset.id) as
      { hash: string; metadata: string | null } | undefined;
    const contentChanged = Boolean(previous && previous.hash !== asset.hash);
    let previousMetadata: AssetMetadata = {};
    if (previous?.metadata && !contentChanged) {
      try {
        previousMetadata = JSON.parse(previous.metadata) as AssetMetadata;
      } catch {
        previousMetadata = {};
      }
    }
    const metadataJson = JSON.stringify({ ...previousMetadata, ...(asset.metadata || {}) });
    upsertStmt.run(
      asset.id,
      asset.path,
      asset.absolutePath,
      asset.name,
      asset.extension,
      asset.category,
      asset.size,
      asset.mtime,
      asset.hash,
      asset.isArchiveEntry ? 1 : 0,
      asset.archivePath || null,
      asset.archiveEntryPath || null,
      asset.sourceDirectory || null,
      asset.thumbnailPath || null,
      metadataJson,
      now,
      now
    );
  });

  tx();
}

export function getAllTags(): TagInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT tag as name, COUNT(DISTINCT asset_id) as count,
      CASE WHEN SUM(CASE WHEN source = 'user' THEN 1 ELSE 0 END) > 0
        THEN 'user' ELSE MIN(source) END as source
    FROM tags
    GROUP BY tag COLLATE NOCASE
    ORDER BY count DESC, name ASC
  `).all() as { name: string; count: number; source: string }[];

  return rows.map((r) => ({
    name: r.name,
    count: r.count,
    source: r.source as TagInfo['source'],
  }));
}

export function getAllFormats(): FormatInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT extension, category, COUNT(id) as count
    FROM assets
    GROUP BY extension
    ORDER BY count DESC, extension ASC
  `).all() as { extension: string; category: string; count: number }[];

  return rows.map((r) => ({
    extension: r.extension,
    category: r.category as AssetCategory,
    count: r.count,
  }));
}

export function getAllResolutions(): ResolutionInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      CAST(json_extract(metadata, '$.width') AS INTEGER) as width,
      CAST(json_extract(metadata, '$.height') AS INTEGER) as height,
      COUNT(id) as count
    FROM assets
    WHERE category = 'image'
      AND json_extract(metadata, '$.width') IS NOT NULL
      AND json_extract(metadata, '$.height') IS NOT NULL
      AND CAST(json_extract(metadata, '$.width') AS INTEGER) > 0
      AND CAST(json_extract(metadata, '$.height') AS INTEGER) > 0
    GROUP BY width, height
    ORDER BY count DESC, width DESC, height DESC
    LIMIT 60
  `).all() as { width: number; height: number; count: number }[];

  return rows.map((r) => ({
    width: r.width,
    height: r.height,
    formatted: `${r.width}x${r.height}`,
    count: r.count,
  }));
}

export function getAllBpms(): BpmInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT
      ROUND(CAST(json_extract(metadata, '$.bpm') AS NUMERIC)) as bpm,
      COUNT(id) as count
    FROM assets
    WHERE category = 'audio'
      AND json_extract(metadata, '$.bpm') IS NOT NULL
      AND CAST(json_extract(metadata, '$.bpm') AS NUMERIC) > 0
    GROUP BY bpm
    ORDER BY count DESC, bpm ASC
    LIMIT 30
  `).all() as { bpm: number; count: number }[];

  return rows.map((r) => ({
    bpm: r.bpm,
    formatted: `${r.bpm} BPM`,
    count: r.count,
  }));
}

export function getAllFolders(): FolderInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT MIN(f.value) as name, COUNT(DISTINCT a.id) as count
    FROM assets a, json_each(CASE WHEN json_valid(a.metadata) THEN a.metadata END, '$.folders') f
    WHERE f.type = 'text' AND f.value != ''
    GROUP BY f.value COLLATE NOCASE
    ORDER BY count DESC, name COLLATE NOCASE ASC
  `).all() as { name: string; count: number }[];

  return rows.map((r) => ({ name: r.name, count: r.count }));
}

export function clearStacks(): void {
  const db = getDatabase();
  db.transaction(() => {
    db.prepare('UPDATE assets SET stack_id = NULL, stack_index = NULL').run();
    db.prepare('DELETE FROM stacks').run();
  })();
}

export function createStack(stack: {
  id: string;
  name: string;
  type: string;
  itemCount: number;
  representativeAssetId: string;
  metadata?: Record<string, unknown>;
  assetIdsWithIndex: { assetId: string; index: number }[];
}): void {
  const db = getDatabase();
  const now = Date.now();
  const metaJson = JSON.stringify(stack.metadata || {});

  const insertStackStmt = db.prepare(`
    INSERT INTO stacks (id, name, type, item_count, representative_asset_id, metadata, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const updateAssetStmt = db.prepare(`
    UPDATE assets SET stack_id = ?, stack_index = ? WHERE id = ?
  `);

  const tx = db.transaction(() => {
    insertStackStmt.run(
      stack.id,
      stack.name,
      stack.type,
      stack.itemCount,
      stack.representativeAssetId,
      metaJson,
      now
    );

    for (const item of stack.assetIdsWithIndex) {
      updateAssetStmt.run(stack.id, item.index, item.assetId);
    }
  });

  tx();
}

export function getStackById(id: string): AssetStack | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM stacks WHERE id = ?').get(id) as StackRow | undefined;
  if (!row) return null;

  const repAsset = getAssetById(row.representative_asset_id);
  const assetRows = db.prepare('SELECT * FROM assets WHERE stack_id = ? ORDER BY stack_index ASC').all(id) as AssetRow[];
  const assets = assetRows.map((ar) => {
    const tagRows = db.prepare('SELECT DISTINCT tag FROM tags WHERE asset_id = ?').all(ar.id) as { tag: string }[];
    return rowToAsset(ar, tagRows.map((t) => t.tag));
  });

  let meta;
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      meta = {};
    }
  }

  // Collect unique tags across stack assets
  const tagSet = new Set<string>();
  assets.forEach((a) => a.tags.forEach((t) => tagSet.add(t)));

  return {
    id: row.id,
    name: row.name,
    type: row.type as AssetStack['type'],
    itemCount: row.item_count,
    representativeAssetId: row.representative_asset_id,
    representativeAsset: repAsset || undefined,
    assets,
    metadata: meta,
    tags: Array.from(tagSet),
    createdAt: row.created_at,
  };
}

export function getStackAssets(stackId: string): Asset[] {
  const db = getDatabase();
  const assetRows = db.prepare('SELECT * FROM assets WHERE stack_id = ? ORDER BY stack_index ASC').all(stackId) as AssetRow[];
  return assetRows.map((ar) => {
    const tagRows = db.prepare('SELECT DISTINCT tag FROM tags WHERE asset_id = ?').all(ar.id) as { tag: string }[];
    return rowToAsset(ar, tagRows.map((t) => t.tag));
  });
}

export function removeDeletedAssets(existingPaths: Set<string>): number {
  if (!dbInstance) return 0;
  const db = getDatabase();
  const allRows = db.prepare('SELECT id, path, thumbnail_path FROM assets').all() as { id: string; path: string; thumbnail_path: string | null }[];
  let removedCount = 0;

  const deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');
  const deleteTagsStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');

  const tx = db.transaction(() => {
    for (const r of allRows) {
      if (!existingPaths.has(r.path)) {
        deleteTagsStmt.run(r.id);
        deleteStmt.run(r.id);
        removedCount++;
        // Delete thumbnail file if present
        if (r.thumbnail_path && fs.existsSync(r.thumbnail_path)) {
          try {
            fs.unlinkSync(r.thumbnail_path);
          } catch {
            // ignore
          }
        }
      }
    }
  });

  tx();
  return removedCount;
}

export function removeDeletedAssetsForSourceDirectory(
  sourceDir: string,
  existingPathsInSource: Set<string>
): number {
  if (!dbInstance) return 0;
  const db = getDatabase();
  const normalized = path.resolve(sourceDir);
  const rows = db.prepare(`
    SELECT id, path, thumbnail_path FROM assets
    WHERE source_directory = ? OR source_directory = ?
  `).all(sourceDir, normalized) as { id: string; path: string; thumbnail_path: string | null }[];

  let removedCount = 0;
  const deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');
  const deleteTagsStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');

  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!existingPathsInSource.has(r.path)) {
        deleteTagsStmt.run(r.id);
        deleteStmt.run(r.id);
        removedCount++;
        if (r.thumbnail_path && fs.existsSync(r.thumbnail_path)) {
          try {
            fs.unlinkSync(r.thumbnail_path);
          } catch {
            // ignore
          }
        }
      }
    }
  });
  tx();
  return removedCount;
}

export function removeAssetsForSourceDirectory(sourceDir: string): { removedCount: number; thumbnailPaths: string[] } {
  if (!dbInstance) return { removedCount: 0, thumbnailPaths: [] };
  const db = getDatabase();
  const normalized = path.resolve(sourceDir);
  const rows = db.prepare(`
    SELECT id, thumbnail_path FROM assets
    WHERE source_directory = ? OR source_directory = ?
  `).all(sourceDir, normalized) as { id: string; thumbnail_path: string | null }[];

  const deleteStmt = db.prepare('DELETE FROM assets WHERE id = ?');
  const deleteTagsStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');
  const deleteEmptyStacks = db.prepare(`
    DELETE FROM stacks WHERE id NOT IN (
      SELECT DISTINCT stack_id FROM assets WHERE stack_id IS NOT NULL
    )
  `);

  const thumbPaths: string[] = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      deleteTagsStmt.run(r.id);
      deleteStmt.run(r.id);
      if (r.thumbnail_path) {
        thumbPaths.push(r.thumbnail_path);
      }
    }
    deleteEmptyStacks.run();
  });
  tx();

  for (const p of thumbPaths) {
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
      } catch {
        // ignore
      }
    }
  }

  return { removedCount: rows.length, thumbnailPaths: thumbPaths };
}

export interface CompletedScanScope {
  sourceDirectory: string;
  completedDirectories: string[];
  failedPaths: string[];
}

function pathIsWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Called inside the scan commit transaction after all media work succeeds. */
export function reconcileScannedAssets(
  scopes: CompletedScanScope[],
  seenAssetIds: Set<string>,
  removedConfiguredSources: string[] = []
): { removedIds: string[]; thumbnailPaths: string[] } {
  const db = getDatabase();
  const removedSources = new Set(removedConfiguredSources.map((source) => path.resolve(source)));
  const rows = db.prepare('SELECT id, absolute_path, source_directory, thumbnail_path FROM assets').all() as
    { id: string; absolute_path: string; source_directory: string | null; thumbnail_path: string | null }[];
  const deleteTags = db.prepare('DELETE FROM tags WHERE asset_id = ?');
  const deleteAliases = db.prepare('DELETE FROM asset_id_aliases WHERE asset_id = ?');
  const deleteAsset = db.prepare('DELETE FROM assets WHERE id = ?');
  const removedIds: string[] = [];
  const thumbnailPaths: string[] = [];

  for (const row of rows) {
    if (seenAssetIds.has(row.id)) continue;
    const source = row.source_directory ? path.resolve(row.source_directory) : null;
    const removedSource = source !== null && removedSources.has(source);
    const scope = source !== null
      ? scopes.find((candidate) => candidate.sourceDirectory === source)
      : scopes
        .filter((candidate) => pathIsWithin(row.absolute_path, candidate.sourceDirectory))
        .sort((left, right) => right.sourceDirectory.length - left.sourceDirectory.length)[0];
    const observed = scope?.completedDirectories.some((directory) => pathIsWithin(row.absolute_path, directory)) ?? false;
    const failed = scopes.some((candidate) => candidate.failedPaths.some((failedPath) =>
      pathIsWithin(row.absolute_path, failedPath)));
    if (!removedSource && (!observed || failed)) continue;
    deleteTags.run(row.id);
    deleteAliases.run(row.id);
    deleteAsset.run(row.id);
    removedIds.push(row.id);
    if (row.thumbnail_path) thumbnailPaths.push(row.thumbnail_path);
  }
  return { removedIds, thumbnailPaths };
}

export function queryAssets(params: AssetQueryParams): AssetListResponse {
  const query = requireAssetQuery(params);
  params = query;
  const db = getDatabase();
  const isStackedView = params.isStackedView !== false;
  const page = query.page;
  const limit = query.limit;
  const offset = (page - 1) * limit;

  // Compute summary stats first
  const summaryRow = db.prepare(`
    SELECT
      COUNT(id) as totalAssets,
      COALESCE(SUM(size), 0) as totalSize,
      COALESCE(SUM(CASE WHEN category = 'image' THEN 1 ELSE 0 END), 0) as imageCount,
      COALESCE(SUM(CASE WHEN category = 'audio' THEN 1 ELSE 0 END), 0) as audioCount
    FROM assets
  `).get() as { totalAssets: number; totalSize: number; imageCount: number; audioCount: number };

  const stackSummaryRow = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'animation' THEN 1 ELSE 0 END), 0) as animationStackCount,
      COALESCE(SUM(CASE WHEN type = 'audio_variation' THEN 1 ELSE 0 END), 0) as audioStackCount
    FROM stacks
  `).get() as { animationStackCount: number; audioStackCount: number };

  const summary = {
    totalAssets: summaryRow.totalAssets,
    totalSize: summaryRow.totalSize,
    imageCount: summaryRow.imageCount,
    audioCount: summaryRow.audioCount,
    animationStackCount: stackSummaryRow.animationStackCount,
    audioStackCount: stackSummaryRow.audioStackCount,
  };

  // Build filters
  const conditions: string[] = [];
  const args: any[] = [];

  if (isStackedView) {
    // In stacked view, each item (stack or standalone asset) is represented by exactly one row.
    // For stacks, only include the representative asset row!
    conditions.push('(a.stack_id IS NULL OR a.id = s.representative_asset_id)');
  }

  if (params.category && params.category !== 'all') {
    if (isStackedView) {
      if (params.category === 'image') {
        conditions.push("(a.category = 'image' OR s.type = 'animation')");
      } else if (params.category === 'audio') {
        conditions.push("(a.category = 'audio' OR s.type = 'audio_variation')");
      } else {
        conditions.push('a.category = ?');
        args.push(params.category);
      }
    } else {
      conditions.push('a.category = ?');
      args.push(params.category);
    }
  }

  if (params.format) {
    const fmt = params.format.toLowerCase();
    if (isStackedView) {
      conditions.push('(LOWER(a.extension) = ? OR (a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND (LOWER(m.extension) = ?))))');
      args.push(fmt, fmt);
    } else {
      conditions.push('LOWER(a.extension) = ?');
      args.push(fmt);
    }
  }

  if (params.tag) {
    const cleanTag = params.tag.replace(/^#/, '').trim();
    if (isStackedView) {
      conditions.push('(EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND t.tag = ? COLLATE NOCASE) OR (a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM assets m JOIN tags mt ON mt.asset_id = m.id WHERE m.stack_id = a.stack_id AND (mt.tag = ? COLLATE NOCASE))))');
      args.push(cleanTag, cleanTag);
    } else {
      conditions.push('EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND t.tag = ? COLLATE NOCASE)');
      args.push(cleanTag);
    }
  }

  if (params.resolution && params.resolution.trim()) {
    const resClause = parseResolutionClause(params.resolution.trim(), isStackedView);
    if (resClause && resClause.sql) {
      conditions.push(resClause.sql);
      args.push(...resClause.args);
    }
  }

  if (params.bpm && params.bpm.trim()) {
    const bpmClause = parseBpmClause(params.bpm.trim(), isStackedView);
    if (bpmClause && bpmClause.sql) {
      conditions.push(bpmClause.sql);
      args.push(...bpmClause.args);
    }
  }

  if (params.sprite && params.sprite.trim()) {
    const spriteClause = parseSpriteClause(params.sprite.trim(), isStackedView);
    if (spriteClause && spriteClause.sql) {
      conditions.push(spriteClause.sql);
      args.push(...spriteClause.args);
    }
  }

  if (params.pack && params.pack.trim()) {
    const packClause = parsePackClause(params.pack.trim(), isStackedView);
    if (packClause && packClause.sql) {
      conditions.push(packClause.sql);
      args.push(...packClause.args);
    }
  }

  if (params.folder && params.folder.trim()) {
    const folderClause = parseFolderClause(params.folder.trim(), isStackedView);
    if (folderClause && folderClause.sql) {
      conditions.push(folderClause.sql);
      args.push(...folderClause.args);
    }
  }

  if (params.width && params.width.trim()) {
    const widthClause = parseWidthClause(params.width.trim(), isStackedView);
    if (widthClause && widthClause.sql) {
      conditions.push(widthClause.sql);
      args.push(...widthClause.args);
    }
  }

  if (params.height && params.height.trim()) {
    const heightClause = parseHeightClause(params.height.trim(), isStackedView);
    if (heightClause && heightClause.sql) {
      conditions.push(heightClause.sql);
      args.push(...heightClause.args);
    }
  }

  if (params.duration && params.duration.trim()) {
    const durClause = parseDurationClause(params.duration.trim(), isStackedView);
    if (durClause && durClause.sql) {
      conditions.push(durClause.sql);
      args.push(...durClause.args);
    }
  }

  if (params.search && params.search.trim()) {
    const filterRes = compileFilterExpression(params.search, isStackedView);
    if (filterRes.sql) {
      conditions.push(filterRes.sql);
      args.push(...filterRes.args);
    }
  }

  // Special stackType filter:
  if (params.stackType === 'animation') {
    conditions.push("s.type = 'animation'");
  } else if (params.stackType === 'audio_variation') {
    conditions.push("s.type = 'audio_variation'");
  }

  const whereClause = conditions.length > 0 ? `WHERE ${composePredicates(conditions, 'AND')}` : '';

  // Sort clause
  let sortField = isStackedView ? 'COALESCE(s.name, a.name)' : 'a.name';
  let sortOrder = params.sortOrder === 'desc' ? 'DESC' : 'ASC';

  switch (params.sortBy) {
    case 'size':
      sortField = 'a.size';
      break;
    case 'mtime':
      sortField = 'a.mtime';
      break;
    case 'resolution':
      sortField = '(COALESCE(CAST(json_extract(a.metadata, \'$.width\') AS INTEGER), 0) * COALESCE(CAST(json_extract(a.metadata, \'$.height\') AS INTEGER), 0))';
      break;
    case 'duration':
      sortField = 'COALESCE(CAST(json_extract(a.metadata, \'$.duration\') AS NUMERIC), 0)';
      break;
    case 'bpm':
      sortField = 'COALESCE(CAST(json_extract(a.metadata, \'$.bpm\') AS NUMERIC), 0)';
      break;
    case 'width':
      sortField = 'COALESCE(CAST(json_extract(a.metadata, \'$.width\') AS NUMERIC), 0)';
      break;
    case 'height':
      sortField = 'COALESCE(CAST(json_extract(a.metadata, \'$.height\') AS NUMERIC), 0)';
      break;
    case 'name':
    default:
      sortField = isStackedView ? 'COALESCE(s.name, a.name)' : 'a.name';
      break;
  }

  const countQuery = `
    SELECT COUNT(DISTINCT ${isStackedView ? 'COALESCE(s.id, a.id)' : 'a.id'}) as count
    FROM assets a
    LEFT JOIN stacks s ON a.stack_id = s.id
    ${whereClause}
  `;
  const totalCount = (db.prepare(countQuery).get(...args) as { count: number }).count;

  const dataQuery = `
    SELECT
      a.*,
      s.id as s_id, s.name as s_name, s.type as s_type, s.item_count as s_item_count,
      s.representative_asset_id as s_rep_id, s.metadata as s_metadata
    FROM assets a
    LEFT JOIN stacks s ON a.stack_id = s.id
    ${whereClause}
    ORDER BY ${sortField} ${sortOrder}, a.id ASC
    LIMIT ? OFFSET ?
  `;

  const rows = db.prepare(dataQuery).all(...args, limit, offset) as (AssetRow & {
    s_id: string | null;
    s_name: string | null;
    s_type: string | null;
    s_item_count: number | null;
    s_rep_id: string | null;
    s_metadata: string | null;
  })[];

  const tagsByAsset = new Map<string, string[]>();
  if (rows.length > 0) {
    const assetIds = rows.map((row) => row.id);
    const placeholders = assetIds.map(() => '?').join(', ');
    const tagRows = db.prepare(`
      SELECT DISTINCT asset_id, tag FROM tags WHERE asset_id IN (${placeholders})
    `).all(...assetIds) as { asset_id: string; tag: string }[];
    for (const tagRow of tagRows) {
      const tags = tagsByAsset.get(tagRow.asset_id) || [];
      tags.push(tagRow.tag);
      tagsByAsset.set(tagRow.asset_id, tags);
    }
  }

  const tagsByStack = new Map<string, string[]>();
  const stackIds = isStackedView
    ? rows.flatMap((row) => row.s_id ? [row.s_id] : [])
    : [];
  if (stackIds.length > 0) {
    const placeholders = stackIds.map(() => '?').join(', ');
    const stackTagRows = db.prepare(`
      SELECT DISTINCT m.stack_id, t.tag FROM tags t
      JOIN assets m ON m.id = t.asset_id
      WHERE m.stack_id IN (${placeholders})
    `).all(...stackIds) as { stack_id: string; tag: string }[];
    for (const tagRow of stackTagRows) {
      const tags = tagsByStack.get(tagRow.stack_id) || [];
      tags.push(tagRow.tag);
      tagsByStack.set(tagRow.stack_id, tags);
    }
  }

  const items = rows.map((r) => {
    const asset = rowToAsset(r, tagsByAsset.get(r.id) || []);

    if (isStackedView && r.s_id) {
      // It's a stack representative card
      let stackMeta;
      try {
        stackMeta = r.s_metadata ? JSON.parse(r.s_metadata) : {};
      } catch {
        stackMeta = {};
      }

      const stackItem: AssetStack & { isStack: true } = {
        isStack: true,
        id: r.s_id,
        name: r.s_name!,
        type: r.s_type as AssetStack['type'],
        itemCount: r.s_item_count || 1,
        representativeAssetId: r.id,
        representativeAsset: asset,
        metadata: stackMeta,
        tags: tagsByStack.get(r.s_id) || [],
        createdAt: r.created_at,
      };
      return stackItem;
    }

    return asset;
  });

  return {
    items,
    total: totalCount,
    page,
    limit,
    totalPages: Math.ceil(totalCount / limit) || 1,
    summary,
  };
}

export function getClassifierSettings(classifierId: string): Record<string, unknown> | null {
  const cfg = getEffectiveConfig();
  const classifiers = cfg.classifiers || {};
  return (classifiers[classifierId] as Record<string, unknown>) || null;
}

export function updateClassifierSettings(classifierId: string, settings: Record<string, unknown>): Record<string, unknown> {
  const cfg = getEffectiveConfig();
  const classifiers = { ...(cfg.classifiers || {}) };
  const current = (classifiers[classifierId] || {}) as Record<string, unknown>;
  const merged = { ...current, ...settings };
  classifiers[classifierId] = merged;

  saveConfigFile({ classifiers });
  return merged;
}

export function updateAssetMetadata(assetId: string, metadataUpdates: Partial<AssetMetadata>): Asset | null {
  const db = getDatabase();
  const row = db.prepare('SELECT metadata FROM assets WHERE id = ?').get(assetId) as { metadata: string | null } | undefined;
  if (!row) return null;

  let meta: AssetMetadata = {};
  if (row.metadata) {
    try {
      meta = JSON.parse(row.metadata);
    } catch {
      meta = {};
    }
  }

  const newMeta = { ...meta, ...metadataUpdates };
  const now = Date.now();
  db.prepare('UPDATE assets SET metadata = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(newMeta), now, assetId);

  return getAssetById(assetId);
}

/** Finalize one classifier result only if the indexed asset is still the revision analyzed. */
export function finalizeClassifierAsset(
  asset: Asset,
  classifierId: 'bpm' | 'sprite' | 'pack' | 'folder',
  outcome: 'classified' | 'no-result',
  metadataUpdates: Partial<AssetMetadata>
): boolean {
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT hash, path, absolute_path, archive_entry_path, source_directory,
        size, mtime, updated_at, metadata
      FROM assets WHERE id = ?
    `).get(asset.id) as {
      hash: string; path: string; absolute_path: string;
      archive_entry_path: string | null; source_directory: string | null;
      size: number; mtime: number; updated_at: number; metadata: string | null;
    } | undefined;
    if (!row || row.hash !== asset.hash || row.path !== asset.path ||
        row.absolute_path !== asset.absolutePath ||
        row.archive_entry_path !== (asset.archiveEntryPath || null) ||
        row.source_directory !== (asset.sourceDirectory || null) ||
        row.size !== asset.size || row.mtime !== asset.mtime ||
        row.updated_at !== asset.updatedAt) return false;

    let metadata: AssetMetadata = {};
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata) as AssetMetadata;
      } catch {
        metadata = {};
      }
    }
    if (classifierId === 'bpm') {
      const provenance = { ...(metadata.classifierProvenance || {}) };
      if (outcome === 'classified' && !provenance.bpm) {
        provenance.bpm = {
          previousBpm: metadata.bpm ?? null,
          previousTempoDescription: metadata.tempoDescription ?? null,
        };
      } else if (outcome === 'no-result') {
        if (provenance.bpm) {
          if (provenance.bpm.previousBpm === null) delete metadata.bpm;
          else metadata.bpm = provenance.bpm.previousBpm;
          if (provenance.bpm.previousTempoDescription === null) delete metadata.tempoDescription;
          else metadata.tempoDescription = provenance.bpm.previousTempoDescription;
          delete provenance.bpm;
        }
      }
      if (Object.keys(provenance).length) metadata.classifierProvenance = provenance;
      else delete metadata.classifierProvenance;
    } else if (classifierId === 'pack') {
      const provenance = { ...(metadata.classifierProvenance || {}) };
      if (outcome === 'classified' && !provenance.pack) {
        provenance.pack = { previousPack: metadata.pack ?? null };
      } else if (outcome === 'no-result') {
        if (provenance.pack) {
          if (provenance.pack.previousPack === null) delete metadata.pack;
          else metadata.pack = provenance.pack.previousPack;
          delete provenance.pack;
        }
      }
      if (Object.keys(provenance).length) metadata.classifierProvenance = provenance;
      else delete metadata.classifierProvenance;
    } else if (classifierId === 'folder') {
      // The classifier owns the folder list; a rerun replaces or clears it.
      delete metadata.folders;
    } else if (outcome === 'no-result') {
      delete metadata.spriteType;
      delete metadata.spriteConfidence;
    }
    Object.assign(metadata, metadataUpdates);

    db.prepare('UPDATE assets SET metadata = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(metadata), Math.max(Date.now(), row.updated_at + 1), asset.id);
    return true;
  })();
}

function normalizeTagsInput(
  tags: (string | { tag: string; source?: string })[],
  defaultSource = 'user'
): { tag: string; source: string }[] {
  const result: { tag: string; source: string }[] = [];
  for (const item of tags) {
    if (typeof item === 'string') {
      const clean = item.replace(/^#/, '').trim();
      if (clean.length > 0) {
        result.push({ tag: clean, source: defaultSource });
      }
    } else if (item && typeof item.tag === 'string') {
      const clean = item.tag.replace(/^#/, '').trim();
      if (clean.length > 0) {
        result.push({ tag: clean, source: item.source || defaultSource });
      }
    }
  }
  return result;
}

export function addAssetTags(
  assetId: string,
  tags: (string | { tag: string; source?: string })[],
  defaultSource = 'user'
): Asset | null {
  const db = getDatabase();
  const normalized = normalizeTagsInput(tags, defaultSource);
  if (normalized.length === 0) {
    return getAssetById(assetId);
  }

  const existingRows = db.prepare('SELECT tag, source FROM tags WHERE asset_id = ?').all(assetId) as
    { tag: string; source: string }[];
  const existingSourceSet = new Set(existingRows.map((r) => `${r.tag.toLowerCase()}\0${r.source}`));

  const insertStmt = db.prepare('INSERT OR IGNORE INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');
  const updateAssetStmt = db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?');
  const now = Date.now();

  const tx = db.transaction(() => {
    let inserted = 0;
    for (const t of normalized) {
      const key = `${t.tag.toLowerCase()}\0${t.source}`;
      if (!existingSourceSet.has(key)) {
        insertStmt.run(assetId, t.tag, t.source);
        existingSourceSet.add(key);
        inserted++;
      }
    }
    if (inserted > 0) {
      updateAssetStmt.run(now, assetId);
    }
  });

  tx();
  return getAssetById(assetId);
}

export function removeAssetTag(assetId: string, tag: string): boolean {
  const db = getDatabase();
  const cleanTag = tag.replace(/^#/, '').trim();
  if (!cleanTag) return false;

  const stmt = db.prepare('DELETE FROM tags WHERE asset_id = ? AND LOWER(tag) = LOWER(?)');
  const updateAssetStmt = db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?');

  let changes = 0;
  const tx = db.transaction(() => {
    const res = stmt.run(assetId, cleanTag);
    changes = res.changes;
    if (changes > 0) {
      updateAssetStmt.run(Date.now(), assetId);
    }
  });
  tx();

  return changes > 0;
}

export function removeAssetTags(assetId: string, tags: string[]): number {
  const db = getDatabase();
  const cleanTags = tags.map((t) => t.replace(/^#/, '').trim()).filter((t) => t.length > 0);
  if (cleanTags.length === 0) return 0;

  const stmt = db.prepare('DELETE FROM tags WHERE asset_id = ? AND LOWER(tag) = LOWER(?)');
  const updateAssetStmt = db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?');

  let totalChanges = 0;
  const tx = db.transaction(() => {
    for (const tag of cleanTags) {
      const res = stmt.run(assetId, tag);
      totalChanges += res.changes;
    }
    if (totalChanges > 0) {
      updateAssetStmt.run(Date.now(), assetId);
    }
  });
  tx();

  return totalChanges;
}

export function setAssetTags(
  assetId: string,
  tags: (string | { tag: string; source?: string })[],
  defaultSource = 'user'
): Asset | null {
  const db = getDatabase();
  const normalized = normalizeTagsInput(tags, defaultSource);
  const deleteStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');
  const insertStmt = db.prepare('INSERT OR IGNORE INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');
  const updateAssetStmt = db.prepare('UPDATE assets SET updated_at = ? WHERE id = ?');
  const now = Date.now();

  const seenSources = new Set<string>();
  const tx = db.transaction(() => {
    deleteStmt.run(assetId);
    for (const t of normalized) {
      const key = `${t.tag.toLowerCase()}\0${t.source}`;
      if (!seenSources.has(key)) {
        insertStmt.run(assetId, t.tag, t.source);
        seenSources.add(key);
      }
    }
    updateAssetStmt.run(now, assetId);
  });
  tx();

  return getAssetById(assetId);
}

export function addTagsToAssets(
  assetIds: string[],
  tags: (string | { tag: string; source?: string })[],
  source = 'user'
): { assetId: string; tags: string[] }[] {
  const result: { assetId: string; tags: string[] }[] = [];
  const db = getDatabase();
  const tx = db.transaction(() => {
    for (const id of assetIds) {
      const asset = addAssetTags(id, tags, source);
      if (asset) {
        result.push({ assetId: id, tags: asset.tags });
      }
    }
  });
  tx();
  return result;
}

export function removeTagsFromAssets(
  assetIds: string[],
  tags: string[]
): { assetId: string; tags: string[] }[] {
  const result: { assetId: string; tags: string[] }[] = [];
  const db = getDatabase();
  const tx = db.transaction(() => {
    for (const id of assetIds) {
      removeAssetTags(id, tags);
      const asset = getAssetById(id);
      if (asset) {
        result.push({ assetId: id, tags: asset.tags });
      }
    }
  });
  tx();
  return result;
}

export function addTagsToStack(
  stackId: string,
  tags: (string | { tag: string; source?: string })[],
  source = 'user'
): AssetStack | null {
  const memberAssets = getStackAssets(stackId);
  if (memberAssets.length === 0) return null;

  const memberIds = memberAssets.map((a) => a.id);
  addTagsToAssets(memberIds, tags, source);
  return getStackById(stackId);
}

export function removeTagsFromStack(
  stackId: string,
  tags: string[]
): AssetStack | null {
  const memberAssets = getStackAssets(stackId);
  if (memberAssets.length === 0) return null;

  const memberIds = memberAssets.map((a) => a.id);
  removeTagsFromAssets(memberIds, tags);
  return getStackById(stackId);
}

export function findAssetsByScope(scope: {
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  category?: AssetCategory;
}): Asset[] {
  // This check is also the service-side guard for direct runClassifier calls.
  const target = validateClassifierScope(scope);
  const db = getDatabase();
  let rows: AssetRow[];

  if (target.targetType === 'asset') {
    const ids = Array.isArray(target.targetValue) ? target.targetValue : [target.targetValue];
    const placeholders = ids.map(() => '?').join(',');
    rows = db.prepare(`SELECT * FROM assets WHERE id IN (${placeholders}) ORDER BY name ASC`)
      .all(...ids) as AssetRow[];
  } else if (target.targetType === 'archive') {
    const archiveRows = db.prepare('SELECT * FROM assets WHERE is_archive_entry = 1 ORDER BY name ASC')
      .all() as AssetRow[];
    const archives = new Map<string, Set<string>>();
    for (const row of archiveRows) {
      const source = normalizeClassifierPath(row.archive_path || row.absolute_path);
      const display = normalizeClassifierPath(row.path.split('#/')[0]);
      const displays = archives.get(source) || new Set<string>();
      displays.add(display);
      archives.set(source, displays);
    }

    const selector = target.targetValue;
    const isBareName = !selector.includes('/') && !isAbsoluteClassifierPath(selector);
    const matches = [...archives.entries()]
      .filter(([source, displays]) => isBareName
        ? path.posix.basename(source) === selector || [...displays].some((display) => path.posix.basename(display) === selector)
        : source === selector || displays.has(selector))
      .map(([source]) => source);
    if (matches.length > 1) {
      throw new InvalidClassifierScopeError(`Archive target "${selector}" is ambiguous; select its full path`);
    }
    rows = matches.length === 0 ? [] : archiveRows.filter((row) =>
      normalizeClassifierPath(row.archive_path || row.absolute_path) === matches[0]);
  } else if (target.targetType === 'directory') {
    const directory = target.targetValue;
    const absolute = isAbsoluteClassifierPath(directory);
    // Component comparisons keep % and _ literal and avoid SQL LIKE wildcard behavior.
    rows = (db.prepare('SELECT * FROM assets ORDER BY name ASC').all() as AssetRow[])
      .filter((row) => {
        const candidate = absolute
          ? normalizeClassifierPath(row.is_archive_entry ? row.archive_path || row.absolute_path : row.absolute_path)
          : normalizeClassifierPath(row.path);
        return candidate === directory || candidate.startsWith(directory.endsWith('/') ? directory : `${directory}/`);
      });
  } else {
    rows = db.prepare('SELECT * FROM assets ORDER BY name ASC').all() as AssetRow[];
  }

  if (scope.category) rows = rows.filter((row) => row.category === scope.category);

  return rows.map((r) => {
    const tagRows = db.prepare('SELECT DISTINCT tag FROM tags WHERE asset_id = ?').all(r.id) as { tag: string }[];
    return rowToAsset(r, tagRows.map((t) => t.tag));
  });
}
