import fs from 'fs';
import path from 'path';
import {
  getAssetById,
  getStackById,
  getStackAssets,
  getAppSettings,
} from '../db/database.js';
import { getZipEntryBuffer } from './archive.js';
import type { CopyAssetRequest, CopyAssetResult } from '../../../shared/types.js';

export async function copyAssetToProject(req: CopyAssetRequest): Promise<CopyAssetResult> {
  const settings = getAppSettings();
  const targetDir = req.targetPath || (settings.projectPaths && settings.projectPaths[0]) || settings.activeProjectPath;

  if (!targetDir) {
    throw new Error('Active game project path is not configured. Please set it in Settings.');
  }

  // Ensure target directory exists
  if (!fs.existsSync(targetDir)) {
    await fs.promises.mkdir(targetDir, { recursive: true });
  }

  const copiedFiles: string[] = [];

  // Helper to copy a single asset item
  async function copySingleAsset(assetId: string, subfolder?: string): Promise<string> {
    const asset = getAssetById(assetId);
    if (!asset) {
      throw new Error(`Asset not found: ${assetId}`);
    }

    const destDir = subfolder ? path.join(targetDir, subfolder) : targetDir;
    if (!fs.existsSync(destDir)) {
      await fs.promises.mkdir(destDir, { recursive: true });
    }

    const destFile = path.join(destDir, asset.name);

    if (asset.isArchiveEntry && asset.archivePath && asset.archiveEntryPath) {
      // Extract from zip directly to destination
      const buffer = getZipEntryBuffer(asset.archivePath, asset.archiveEntryPath);
      if (!buffer) {
        throw new Error(`Failed to extract entry ${asset.archiveEntryPath} from archive`);
      }
      await fs.promises.writeFile(destFile, buffer);
    } else {
      // Copy from filesystem
      await fs.promises.copyFile(asset.absolutePath, destFile);
    }

    return destFile;
  }

  if (req.stackId && req.copyStackAll) {
    // Copy the entire stack
    const stack = getStackById(req.stackId);
    if (!stack) {
      throw new Error(`Stack not found: ${req.stackId}`);
    }

    const stackFolder = req.targetSubfolder || stack.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    const stackAssets = getStackAssets(req.stackId);

    for (const a of stackAssets) {
      const dest = await copySingleAsset(a.id, stackFolder);
      copiedFiles.push(dest);
    }

    return {
      success: true,
      copiedFiles,
      targetDirectory: path.join(targetDir, stackFolder),
      message: `Copied ${copiedFiles.length} files from "${stack.name}" stack to ${path.join(targetDir, stackFolder)}`,
    };
  }

  if (req.assetId) {
    const dest = await copySingleAsset(req.assetId, req.targetSubfolder);
    copiedFiles.push(dest);

    return {
      success: true,
      copiedFiles,
      targetDirectory: targetDir,
      message: `Copied ${path.basename(dest)} to ${targetDir}`,
    };
  }

  throw new Error('Either assetId or stackId must be provided.');
}
