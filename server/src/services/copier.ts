import fs from 'fs';
import path from 'path';
import {
  getAssetById,
  getStackById,
  getStackAssets,
  getAppSettings,
} from '../db/database.js';
import { getZipEntryBuffer } from './archive.js';
import type { Asset, CopyAssetRequest, CopyAssetResult } from '../../../shared/types.js';

interface PlannedCopy {
  asset: Asset;
  destination: string;
  archiveBuffer?: Buffer;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative === '' || (
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function validateSubfolder(subfolder: string): string[] {
  if (
    path.isAbsolute(subfolder) ||
    path.win32.isAbsolute(subfolder) ||
    subfolder.includes('\\') ||
    subfolder.includes(':') ||
    subfolder.includes('\0')
  ) {
    throw new Error('Target subfolder must be a relative path within the project');
  }

  const segments = subfolder.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Target subfolder must be a relative path within the project');
  }
  return segments;
}

function validateAssetName(name: string): void {
  if (
    !name ||
    name === '.' ||
    name === '..' ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('\0') ||
    path.isAbsolute(name) ||
    path.win32.isAbsolute(name) ||
    path.win32.basename(name) !== name
  ) {
    throw new Error(`Invalid asset filename: ${name}`);
  }
}

async function lstatIfExists(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function assertMissingTargetHasNoSymlinkParent(targetDir: string): Promise<void> {
  let current = targetDir;
  while (!(await lstatIfExists(current))) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const stat = await lstatIfExists(current);
  if (stat?.isSymbolicLink()) {
    throw new Error('Copy destination cannot use a symbolic link');
  }
}

async function assertDestinationIsSafe(targetDir: string, destination: string): Promise<void> {
  if (!isWithinDirectory(targetDir, destination)) {
    throw new Error('Copy destination is outside the selected project');
  }

  const rootStat = await lstatIfExists(targetDir);
  if (rootStat?.isSymbolicLink()) {
    throw new Error('Copy destination cannot use a symbolic link');
  }
  if (rootStat && !rootStat.isDirectory()) {
    throw new Error('Project destination is not a directory');
  }

  const relative = path.relative(targetDir, destination);
  const segments = relative.split(path.sep);
  let current = targetDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (stat?.isSymbolicLink()) {
      throw new Error('Copy destination cannot use a symbolic link');
    }
    if (stat && index < segments.length - 1 && !stat.isDirectory()) {
      throw new Error('Copy destination parent is not a directory');
    }
  }
}

async function ensureDestinationDirectory(targetDir: string, destDir: string): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const relative = path.relative(targetDir, destDir);
  if (!relative) return;

  let current = targetDir;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (stat?.isSymbolicLink()) {
      throw new Error('Copy destination cannot use a symbolic link');
    }
    if (stat && !stat.isDirectory()) {
      throw new Error('Copy destination parent is not a directory');
    }
    if (!stat) await fs.promises.mkdir(current);
  }
}

async function planAssetCopy(asset: Asset, destDir: string, targetDir: string): Promise<PlannedCopy> {
  validateAssetName(asset.name);
  const destination = path.resolve(destDir, asset.name);
  if (!isWithinDirectory(targetDir, destination)) {
    throw new Error('Copy destination is outside the selected project');
  }

  if (asset.isArchiveEntry) {
    if (!asset.archivePath || !asset.archiveEntryPath) {
      throw new Error(`Archive entry source is missing: ${asset.id}`);
    }
    const archiveBuffer = getZipEntryBuffer(asset.archivePath, asset.archiveEntryPath);
    if (!archiveBuffer) {
      throw new Error(`Failed to extract entry ${asset.archiveEntryPath} from archive`);
    }
    return { asset, destination, archiveBuffer };
  }

  const sourceStat = await fs.promises.stat(asset.absolutePath);
  if (!sourceStat.isFile()) {
    throw new Error(`Asset source is not a file: ${asset.id}`);
  }
  return { asset, destination };
}

export async function copyAssetToProject(req: CopyAssetRequest): Promise<CopyAssetResult> {
  const settings = getAppSettings();
  const selectedTarget = req.targetPath || (settings.projectPaths && settings.projectPaths[0]) || settings.activeProjectPath;

  if (!selectedTarget) {
    throw new Error('Active game project path is not configured. Please set it in Settings.');
  }

  const targetDir = path.resolve(selectedTarget);
  const copiedFiles: string[] = [];
  let destDir: string;
  let stackName: string | undefined;
  let sourceAssets: Asset[];

  if (req.stackId && req.copyStackAll) {
    const stack = getStackById(req.stackId);
    if (!stack) {
      throw new Error(`Stack not found: ${req.stackId}`);
    }
    stackName = stack.name;
    const stackFolder = req.targetSubfolder || stack.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    destDir = path.resolve(targetDir, ...validateSubfolder(stackFolder));
    sourceAssets = getStackAssets(req.stackId);
  } else if (req.assetId) {
    const asset = getAssetById(req.assetId);
    if (!asset) {
      throw new Error(`Asset not found: ${req.assetId}`);
    }
    destDir = req.targetSubfolder
      ? path.resolve(targetDir, ...validateSubfolder(req.targetSubfolder))
      : targetDir;
    sourceAssets = [asset];
  } else {
    throw new Error('Either assetId or stackId must be provided.');
  }

  if (!isWithinDirectory(targetDir, destDir)) {
    throw new Error('Copy destination is outside the selected project');
  }

  // Finish validating every source and destination before creating directories.
  const planned: PlannedCopy[] = [];
  for (const asset of sourceAssets) {
    planned.push(await planAssetCopy(asset, destDir, targetDir));
  }
  for (const item of planned) {
    await assertDestinationIsSafe(targetDir, item.destination);
  }

  await assertMissingTargetHasNoSymlinkParent(targetDir);

  await ensureDestinationDirectory(targetDir, destDir);

  for (const item of planned) {
    await assertDestinationIsSafe(targetDir, item.destination);
    if (item.archiveBuffer) {
      await fs.promises.writeFile(item.destination, item.archiveBuffer);
    } else {
      await fs.promises.copyFile(item.asset.absolutePath, item.destination);
    }
    copiedFiles.push(item.destination);
  }

  if (stackName) {
    return {
      success: true,
      copiedFiles,
      targetDirectory: destDir,
      message: `Copied ${copiedFiles.length} files from "${stackName}" stack to ${destDir}`,
    };
  }

  return {
    success: true,
    copiedFiles,
    targetDirectory: targetDir,
    message: `Copied ${path.basename(copiedFiles[0])} to ${targetDir}`,
  };
}
