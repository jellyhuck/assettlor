import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import {
  Asset,
  AssetCategory,
  AssetMetadata,
  AssetStack,
  TagInfo,
  FormatInfo,
  ResolutionInfo,
  BpmInfo,
  AppSettings,
  AssetQueryParams,
  AssetListResponse,
  ClassifierTargetType,
} from '../../shared/types.js';
import { config } from '../config.js';
import {
  compileFilterExpression,
  parseResolutionClause,
  parseBpmClause,
  parseSpriteClause,
  parseWidthClause,
  parseHeightClause,
  parseDurationClause,
} from '../services/filterParser.js';

let dbInstance: Database.Database | null = null;
let currentLibraryPath: string = '';

export function getDatabase(): Database.Database {
  if (!dbInstance) {
    throw new Error('Database has not been initialized. Call initDatabase first.');
  }
  return dbInstance;
}

export function getCurrentLibraryPath(): string {
  return currentLibraryPath;
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
    currentLibraryPath = '';
  }
}

export function initDatabase(libraryPath: string): Database.Database {
  if (dbInstance && currentLibraryPath === libraryPath) {
    return dbInstance;
  }

  if (dbInstance) {
    try {
      dbInstance.close();
    } catch (e) {
      console.error('Error closing previous database:', e);
    }
    dbInstance = null;
  }

  currentLibraryPath = libraryPath;
  const assettlorDir = path.join(libraryPath, config.cacheDirName);
  const thumbnailsDir = path.join(assettlorDir, 'thumbnails');

  if (!fs.existsSync(assettlorDir)) {
    fs.mkdirSync(assettlorDir, { recursive: true });
  }
  if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
  }

  const dbPath = path.join(assettlorDir, 'index.db');
  const db = new Database(dbPath);

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
      tag TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (asset_id, tag),
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE ON UPDATE CASCADE
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_assets_category ON assets(category);
    CREATE INDEX IF NOT EXISTS idx_assets_extension ON assets(extension);
    CREATE INDEX IF NOT EXISTS idx_assets_stack_id ON assets(stack_id);
    CREATE INDEX IF NOT EXISTS idx_assets_name ON assets(name);
    CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
    CREATE INDEX IF NOT EXISTS idx_tags_asset_id ON tags(asset_id);
    CREATE INDEX IF NOT EXISTS idx_stacks_type ON stacks(type);
  `);

  try {
    db.exec('ALTER TABLE assets ADD COLUMN source_directory TEXT');
  } catch {
    // column already exists
  }

  dbInstance = db;
  return db;
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
    thumbnailUrl: row.thumbnail_path ? `/api/assets/${row.id}/thumbnail` : '',
    fileUrl: `/api/assets/${row.id}/file`,
    metadata: meta,
    stackId: row.stack_id,
    stackIndex: row.stack_index,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAppSettings(): AppSettings {
  const db = getDatabase();
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const map = new Map<string, string>();
  for (const r of rows) {
    map.set(r.key, r.value);
  }

  let projectPaths: string[] = [];
  if (map.has('projectPaths')) {
    try {
      const parsed = JSON.parse(map.get('projectPaths')!);
      if (Array.isArray(parsed)) {
        projectPaths = parsed.map((p) => String(p).trim()).filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

  let activeProjectPath: string;
  if (map.has('activeProjectPath')) {
    activeProjectPath = map.get('activeProjectPath')!;
    if (activeProjectPath && projectPaths.length === 0) {
      projectPaths = [activeProjectPath];
    } else if (!activeProjectPath && !map.has('projectPaths')) {
      projectPaths = [];
    }
  } else if (projectPaths.length > 0) {
    activeProjectPath = projectPaths[0];
  } else {
    activeProjectPath = config.defaultActiveProjectPath;
    projectPaths = [config.defaultActiveProjectPath];
  }

  let libraryPaths: string[] = [];
  if (map.has('libraryPaths')) {
    try {
      const parsed = JSON.parse(map.get('libraryPaths')!);
      if (Array.isArray(parsed)) {
        libraryPaths = parsed.map((p) => String(p).trim()).filter(Boolean);
      }
    } catch {
      // ignore
    }
  }

  let libraryPath: string;
  if (map.has('libraryPath')) {
    libraryPath = map.get('libraryPath')!;
    if (libraryPath && libraryPaths.length === 0) {
      libraryPaths = [libraryPath];
    } else if (!libraryPath && !map.has('libraryPaths')) {
      libraryPaths = [];
    }
  } else if (libraryPaths.length > 0) {
    libraryPath = libraryPaths[0];
  } else {
    libraryPath = currentLibraryPath || config.defaultLibraryPath;
    libraryPaths = [libraryPath];
  }

  return {
    libraryPath,
    libraryPaths,
    activeProjectPath,
    projectPaths,
    thumbnailQuality: Number(map.get('thumbnailQuality') || 80),
    autoStackAnimations: map.get('autoStackAnimations') !== 'false',
    autoStackAudio: map.get('autoStackAudio') !== 'false',
    defaultFps: Number(map.get('defaultFps') || 12),
  };
}

export function updateAppSettings(settings: Partial<AppSettings>): AppSettings {
  const db = getDatabase();
  const upsertStmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `);

  const runTx = db.transaction(() => {
    if (settings.libraryPaths !== undefined) {
      const paths = Array.isArray(settings.libraryPaths)
        ? settings.libraryPaths.map((p) => String(p).trim()).filter(Boolean)
        : [];
      upsertStmt.run('libraryPaths', JSON.stringify(paths));
      if (paths.length > 0) {
        upsertStmt.run('libraryPath', paths[0]);
      } else {
        upsertStmt.run('libraryPath', '');
      }
    } else if (settings.libraryPath !== undefined) {
      upsertStmt.run('libraryPath', settings.libraryPath);
      const current = getAppSettings();
      let paths = [...current.libraryPaths];
      if (settings.libraryPath) {
        if (!paths.includes(settings.libraryPath)) {
          paths = [settings.libraryPath, ...paths];
        } else {
          paths = [settings.libraryPath, ...paths.filter((p) => p !== settings.libraryPath)];
        }
      } else {
        paths = [];
      }
      upsertStmt.run('libraryPaths', JSON.stringify(paths));
    }

    if (settings.projectPaths !== undefined) {
      const pPaths = Array.isArray(settings.projectPaths)
        ? settings.projectPaths.map((p) => String(p).trim()).filter(Boolean)
        : [];
      upsertStmt.run('projectPaths', JSON.stringify(pPaths));
      if (pPaths.length > 0) {
        upsertStmt.run('activeProjectPath', pPaths[0]);
      } else {
        upsertStmt.run('activeProjectPath', '');
      }
    } else if (settings.activeProjectPath !== undefined) {
      upsertStmt.run('activeProjectPath', settings.activeProjectPath);
      const current = getAppSettings();
      let pPaths = [...current.projectPaths];
      if (settings.activeProjectPath) {
        if (!pPaths.includes(settings.activeProjectPath)) {
          pPaths = [settings.activeProjectPath, ...pPaths];
        } else {
          pPaths = [settings.activeProjectPath, ...pPaths.filter((p) => p !== settings.activeProjectPath)];
        }
      } else {
        pPaths = [];
      }
      upsertStmt.run('projectPaths', JSON.stringify(pPaths));
    }

    if (settings.thumbnailQuality !== undefined) upsertStmt.run('thumbnailQuality', String(settings.thumbnailQuality));
    if (settings.autoStackAnimations !== undefined) upsertStmt.run('autoStackAnimations', String(settings.autoStackAnimations));
    if (settings.autoStackAudio !== undefined) upsertStmt.run('autoStackAudio', String(settings.autoStackAudio));
    if (settings.defaultFps !== undefined) upsertStmt.run('defaultFps', String(settings.defaultFps));
  });

  runTx();
  return getAppSettings();
}

export function getAssetById(id: string): Asset | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as AssetRow | undefined;
  if (!row) return null;

  const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(id) as { tag: string }[];
  const tags = tagRows.map((t) => t.tag);
  return rowToAsset(row, tags);
}

export function getAssetByPath(assetPath: string): Asset | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM assets WHERE path = ?').get(assetPath) as AssetRow | undefined;
  if (!row) return null;

  const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(row.id) as { tag: string }[];
  const tags = tagRows.map((t) => t.tag);
  return rowToAsset(row, tags);
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
  tags?: { tag: string; source: string }[];
}): void {
  const db = getDatabase();
  const now = Date.now();
  const metadataJson = JSON.stringify(asset.metadata || {});

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
    ON CONFLICT(path) DO UPDATE SET
      id = excluded.id,
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

  const deleteTagsByPathStmt = db.prepare('DELETE FROM tags WHERE asset_id IN (SELECT id FROM assets WHERE path = ?)');
  const deleteTagsStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');
  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');

  const tx = db.transaction(() => {
    deleteTagsByPathStmt.run(asset.path);
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

    if (asset.tags && asset.tags.length > 0) {
      deleteTagsStmt.run(asset.id);
      for (const t of asset.tags) {
        if (t.tag && t.tag.trim().length > 0) {
          insertTagStmt.run(asset.id, t.tag.trim(), t.source || 'auto');
        }
      }
    }
  });

  tx();
}

export function getAllTags(): TagInfo[] {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT tag as name, COUNT(asset_id) as count, source
    FROM tags
    GROUP BY tag
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
    const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(ar.id) as { tag: string }[];
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
    const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(ar.id) as { tag: string }[];
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

export function queryAssets(params: AssetQueryParams): AssetListResponse {
  const db = getDatabase();
  const isStackedView = params.isStackedView !== false && String(params.isStackedView) !== 'false';
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.max(1, Math.min(200, Number(params.limit) || 60));
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
      conditions.push('(LOWER(a.extension) = ? OR (a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND LOWER(m.extension) = ?)))');
      args.push(fmt, fmt);
    } else {
      conditions.push('LOWER(a.extension) = ?');
      args.push(fmt);
    }
  }

  if (params.tag) {
    const cleanTag = params.tag.replace(/^#/, '').toLowerCase().trim();
    if (isStackedView) {
      conditions.push('(EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?) OR (a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM assets m JOIN tags mt ON mt.asset_id = m.id WHERE m.stack_id = a.stack_id AND LOWER(mt.tag) = ?)))');
      args.push(cleanTag, cleanTag);
    } else {
      conditions.push('EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)');
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

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

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
    ORDER BY ${sortField} ${sortOrder}
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

  const items = rows.map((r) => {
    const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(r.id) as { tag: string }[];
    const asset = rowToAsset(r, tagRows.map((t) => t.tag));

    if (isStackedView && r.s_id) {
      // It's a stack representative card
      let stackMeta;
      try {
        stackMeta = r.s_metadata ? JSON.parse(r.s_metadata) : {};
      } catch {
        stackMeta = {};
      }

      // Collect unique tags across all stack members
      const stackTagRows = db.prepare(`
        SELECT DISTINCT t.tag FROM tags t
        JOIN assets m ON m.id = t.asset_id
        WHERE m.stack_id = ?
      `).all(r.s_id) as { tag: string }[];

      const stackItem: AssetStack & { isStack: true } = {
        isStack: true,
        id: r.s_id,
        name: r.s_name!,
        type: r.s_type as AssetStack['type'],
        itemCount: r.s_item_count || 1,
        representativeAssetId: r.id,
        representativeAsset: asset,
        metadata: stackMeta,
        tags: stackTagRows.map((t) => t.tag),
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
  const db = getDatabase();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(`classifier:${classifierId}`) as { value: string } | undefined;
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

export function updateClassifierSettings(classifierId: string, settings: Record<string, unknown>): Record<string, unknown> {
  const db = getDatabase();
  const current = getClassifierSettings(classifierId) || {};
  const merged = { ...current, ...settings };
  db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(`classifier:${classifierId}`, JSON.stringify(merged));
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

export function addAssetTags(assetId: string, tags: { tag: string; source: string }[]): void {
  const db = getDatabase();
  const stmt = db.prepare('INSERT OR IGNORE INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');
  const tx = db.transaction(() => {
    for (const t of tags) {
      if (t.tag && t.tag.trim().length > 0) {
        stmt.run(assetId, t.tag.trim(), t.source || 'auto');
      }
    }
  });
  tx();
}

export function removeAssetTagsBySource(assetId: string, source: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM tags WHERE asset_id = ? AND source = ?').run(assetId, source);
}

export function findAssetsByScope(scope: {
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  category?: AssetCategory;
}): Asset[] {
  const db = getDatabase();
  const conditions: string[] = [];
  const args: any[] = [];

  if (scope.category) {
    conditions.push('category = ?');
    args.push(scope.category);
  }

  if (scope.targetType === 'asset') {
    const rawVal = scope.targetValue;
    const ids: string[] = Array.isArray(rawVal) ? rawVal : (rawVal ? [rawVal] : []);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    conditions.push(`id IN (${placeholders})`);
    args.push(...ids);
  } else if (scope.targetType === 'directory') {
    const dir = typeof scope.targetValue === 'string' ? scope.targetValue.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '') : '';
    if (dir) {
      conditions.push("(path = ? OR path LIKE ? || '/%' OR (is_archive_entry = 1 AND (path LIKE ? || '#%' OR path LIKE '%/' || ? || '#%')))");
      args.push(dir, dir, dir, dir);
    }
  } else if (scope.targetType === 'archive') {
    const archive = typeof scope.targetValue === 'string' ? path.basename(scope.targetValue.trim()) : '';
    if (archive) {
      conditions.push("(is_archive_entry = 1 AND (archive_path LIKE '%' || ? OR path LIKE ? || '#%' OR path LIKE '%' || ? || '#%'))");
      args.push(archive, archive, archive);
    } else {
      conditions.push('is_archive_entry = 1');
    }
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM assets ${whereClause} ORDER BY name ASC`).all(...args) as AssetRow[];

  return rows.map((r) => {
    const tagRows = db.prepare('SELECT tag FROM tags WHERE asset_id = ?').all(r.id) as { tag: string }[];
    return rowToAsset(r, tagRows.map((t) => t.tag));
  });
}

