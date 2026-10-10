import path from 'path';
import type { AssetCategory, ClassifierTargetInventory } from '../../../../shared/types.js';
import { getDatabase } from '../../db/database.js';

interface TargetRow {
  id: string;
  path: string;
  category: AssetCategory;
  is_archive_entry: number;
  archive_path: string | null;
  absolute_path: string;
}

/** Read only the catalog fields needed for scope choices, including stacked assets. */
export function getClassifierTargets(): ClassifierTargetInventory {
  const rows = getDatabase().prepare(`
    SELECT id, path, category, is_archive_entry, archive_path, absolute_path
    FROM assets ORDER BY path COLLATE NOCASE, id
  `).all() as TargetRow[];
  const directories = new Set<string>();
  const archives = new Map<string, string>();
  const assets: ClassifierTargetInventory['assets'] = [];

  for (const row of rows) {
    const displayPath = row.path.replace(/\\/g, '/');
    const sourcePath = displayPath.split('#/')[0];
    const sourceDirectory = path.posix.dirname(sourcePath);
    const parts = sourceDirectory === '.' ? [] : sourceDirectory.split('/').filter(Boolean);
    for (let depth = 1; depth <= parts.length; depth++) {
      const prefix = sourcePath.startsWith('/') ? '/' : '';
      const directory = `${prefix}${parts.slice(0, depth).join('/')}`;
      if (!/^[A-Za-z]:$/.test(directory)) directories.add(directory);
    }
    if (row.is_archive_entry && displayPath.includes('#/')) {
      const entryDirectory = path.posix.dirname(displayPath.slice(sourcePath.length + 2));
      const entryParts = entryDirectory === '.' ? [] : entryDirectory.split('/').filter(Boolean);
      for (let depth = 1; depth <= entryParts.length; depth++) {
        directories.add(`${sourcePath}#/${entryParts.slice(0, depth).join('/')}`);
      }
    }

    if (row.is_archive_entry) {
      archives.set(row.archive_path || row.absolute_path, sourcePath);
    }
    assets.push({
      value: row.id,
      label: displayPath,
      category: row.category,
    });
  }

  return {
    directories: [...directories].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value })),
    archives: [...archives].sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]))
      .map(([value, label]) => ({ value, label })),
    assets,
  };
}
