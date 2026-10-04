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
  AppSettings,
  AssetQueryParams,
  AssetListResponse,
} from '../../shared/types.js';
import { config } from '../config.js';

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
      FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
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

  return {
    libraryPath: map.get('libraryPath') || currentLibraryPath || config.defaultLibraryPath,
    activeProjectPath: map.get('activeProjectPath') || config.defaultActiveProjectPath,
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
    if (settings.libraryPath !== undefined) upsertStmt.run('libraryPath', settings.libraryPath);
    if (settings.activeProjectPath !== undefined) upsertStmt.run('activeProjectPath', settings.activeProjectPath);
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
      is_archive_entry, archive_path, archive_entry_path, thumbnail_path,
      metadata, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
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
      thumbnail_path = excluded.thumbnail_path,
      metadata = excluded.metadata,
      updated_at = excluded.updated_at
  `);

  const deleteTagsStmt = db.prepare('DELETE FROM tags WHERE asset_id = ?');
  const insertTagStmt = db.prepare('INSERT OR IGNORE INTO tags (asset_id, tag, source) VALUES (?, ?, ?)');

  const tx = db.transaction(() => {
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
  const isStackedView = params.isStackedView !== false; // default true
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

  if (params.category && params.category !== 'all') {
    conditions.push('a.category = ?');
    args.push(params.category);
  }

  if (params.format) {
    conditions.push('LOWER(a.extension) = ?');
    args.push(params.format.toLowerCase());
  }

  if (params.tag) {
    conditions.push(`EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND t.tag = ?)`);
    args.push(params.tag);
  }

  if (params.search && params.search.trim()) {
    const s = `%${params.search.trim().toLowerCase()}%`;
    conditions.push(`(
      LOWER(a.name) LIKE ? OR
      LOWER(a.path) LIKE ? OR
      EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) LIKE ?)
    )`);
    args.push(s, s, s);
  }

  // Special stackType filter:
  if (params.stackType === 'animation') {
    conditions.push(`a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM stacks st WHERE st.id = a.stack_id AND st.type = 'animation')`);
  } else if (params.stackType === 'audio_variation') {
    conditions.push(`a.stack_id IS NOT NULL AND EXISTS (SELECT 1 FROM stacks st WHERE st.id = a.stack_id AND st.type = 'audio_variation')`);
  }

  if (isStackedView) {
    // In stacked view:
    // If an asset belongs to a stack, only include it if it is the representative asset!
    // Or we show stack items as stack representations.
    conditions.push(`(a.stack_id IS NULL OR a.stack_index = 0 OR a.stack_index = 1)`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sort clause
  let sortField = 'a.name';
  let sortOrder = params.sortOrder === 'desc' ? 'DESC' : 'ASC';

  switch (params.sortBy) {
    case 'size':
      sortField = 'a.size';
      break;
    case 'mtime':
      sortField = 'a.mtime';
      break;
    case 'resolution':
    case 'duration':
      sortField = 'a.name';
      break;
    case 'name':
    default:
      sortField = 'a.name';
      break;
  }

  const countQuery = `SELECT COUNT(DISTINCT a.id) as count FROM assets a ${whereClause}`;
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

      const stackItem: AssetStack & { isStack: true } = {
        isStack: true,
        id: r.s_id,
        name: r.s_name!,
        type: r.s_type as AssetStack['type'],
        itemCount: r.s_item_count || 1,
        representativeAssetId: r.id,
        representativeAsset: asset,
        metadata: stackMeta,
        tags: asset.tags,
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
