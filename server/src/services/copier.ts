import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  getAssetById,
  getStackById,
  getStackAssets,
  getAppSettings,
} from '../db/database.js';
import { getZipEntryBuffer } from './archive.js';
import type {
  Asset,
  CopyAssetRequest,
  CopyAssetResult,
  CopyErrorCode,
  CopyErrorDetails,
} from '../../../shared/types.js';
export type { CopyErrorCode, CopyErrorDetails } from '../../../shared/types.js';

interface PlannedCopy {
  asset: Asset;
  destination: string;
}

export class CopyError extends Error {
  constructor(
    readonly status: number,
    readonly code: CopyErrorCode,
    message: string,
    readonly details?: CopyErrorDetails
  ) {
    super(message);
    this.name = 'CopyError';
  }
}

function invalidCopyRequest(message: string): never {
  throw new CopyError(400, 'INVALID_COPY_REQUEST', message);
}

function copyConflict(message: string): never {
  throw new CopyError(409, 'COPY_CONFLICT', message);
}

function missingSource(message: string): never {
  throw new CopyError(404, 'COPY_SOURCE_MISSING', message);
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
    typeof subfolder !== 'string' ||
    path.isAbsolute(subfolder) ||
    path.win32.isAbsolute(subfolder) ||
    subfolder.includes('\\') ||
    subfolder.includes(':') ||
    subfolder.includes('\0')
  ) {
    invalidCopyRequest('Target subfolder must be a relative path within the project');
  }

  const segments = subfolder.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    invalidCopyRequest('Target subfolder must be a relative path within the project');
  }
  return segments;
}

function validateAssetName(name: string): void {
  if (
    typeof name !== 'string' ||
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
    invalidCopyRequest(`Invalid asset filename: ${name}`);
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
    copyConflict('Copy destination cannot use a symbolic link');
  }
}

async function assertDestinationIsSafe(targetDir: string, destination: string): Promise<void> {
  if (!isWithinDirectory(targetDir, destination)) {
    invalidCopyRequest('Copy destination is outside the selected project');
  }

  const rootStat = await lstatIfExists(targetDir);
  if (rootStat?.isSymbolicLink()) {
    copyConflict('Copy destination cannot use a symbolic link');
  }
  if (rootStat && !rootStat.isDirectory()) {
    copyConflict('Project destination is not a directory');
  }

  const relative = path.relative(targetDir, destination);
  const segments = relative.split(path.sep);
  let current = targetDir;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (stat?.isSymbolicLink()) {
      copyConflict('Copy destination cannot use a symbolic link');
    }
    if (stat && index < segments.length - 1 && !stat.isDirectory()) {
      copyConflict('Copy destination parent is not a directory');
    }
  }
}

async function ensureDestinationDirectory(
  targetDir: string,
  destDir: string,
  requireNewLeaf: boolean
): Promise<void> {
  await fs.promises.mkdir(targetDir, { recursive: true });
  const relative = path.relative(targetDir, destDir);
  if (!relative) return;

  let current = targetDir;
  const segments = relative.split(path.sep);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);
    if (stat?.isSymbolicLink()) {
      copyConflict('Copy destination cannot use a symbolic link');
    }
    if (stat && !stat.isDirectory()) {
      copyConflict('Copy destination parent is not a directory');
    }
    if (stat && requireNewLeaf && index === segments.length - 1) {
      copyConflict(`Stack destination folder already exists: ${destDir}`);
    }
    if (!stat) await fs.promises.mkdir(current);
  }
}

async function planAssetCopy(asset: Asset, destDir: string, targetDir: string): Promise<PlannedCopy> {
  validateAssetName(asset.name);
  const destination = path.resolve(destDir, asset.name);
  if (!isWithinDirectory(targetDir, destination)) {
    invalidCopyRequest('Copy destination is outside the selected project');
  }

  if (asset.isArchiveEntry) {
    if (!asset.archivePath || !asset.archiveEntryPath) {
      missingSource(`Archive entry source is missing: ${asset.id}`);
    }
    let archiveBuffer: Buffer | null;
    try {
      archiveBuffer = getZipEntryBuffer(asset.archivePath, asset.archiveEntryPath);
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        missingSource(`Archive source is missing: ${asset.id}`);
      }
      throw new CopyError(500, 'COPY_IO_ERROR', `Failed to read archive entry: ${asset.id}`);
    }
    if (!archiveBuffer) {
      try {
        await fs.promises.stat(asset.archivePath);
      } catch (error) {
        if (isMissingFilesystemError(error)) {
          missingSource(`Archive source is missing: ${asset.id}`);
        }
        throw new CopyError(500, 'COPY_IO_ERROR', `Failed to inspect archive source: ${asset.id}`);
      }
      missingSource(`Failed to extract entry ${asset.archiveEntryPath} from archive`);
    }
    return { asset, destination };
  }

  let sourceStat: fs.Stats;
  try {
    sourceStat = await fs.promises.stat(asset.absolutePath);
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      missingSource(`Asset source is missing: ${asset.id}`);
    }
    throw new CopyError(500, 'COPY_IO_ERROR', `Failed to read asset source: ${asset.id}`);
  }
  if (!sourceStat.isFile()) {
    missingSource(`Asset source is not a file: ${asset.id}`);
  }
  return { asset, destination };
}

function isMissingFilesystemError(error: unknown): boolean {
  const code = error && typeof error === 'object'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isExistingFilesystemError(error: unknown): boolean {
  return error !== null && typeof error === 'object' &&
    (error as NodeJS.ErrnoException).code === 'EEXIST';
}

interface PublishedFile {
  destination: string;
  dev: number;
  ino: number;
}

async function rollbackPublishedFiles(published: PublishedFile[]): Promise<{
  rolledBackFiles: string[];
  remainingFiles: string[];
}> {
  const rolledBackFiles: string[] = [];
  const remainingFiles: string[] = [];

  for (const file of [...published].reverse()) {
    try {
      const stat = await lstatIfExists(file.destination);
      if (stat && stat.dev === file.dev && stat.ino === file.ino) {
        await fs.promises.unlink(file.destination);
        rolledBackFiles.push(file.destination);
      }
    } catch {
      // Keep the path in remainingFiles if this operation still owns it.
    }

    try {
      const stat = await lstatIfExists(file.destination);
      if (stat && stat.dev === file.dev && stat.ino === file.ino) {
        remainingFiles.push(file.destination);
      }
    } catch {
      remainingFiles.push(file.destination);
    }
  }

  return { rolledBackFiles, remainingFiles };
}

function classifyExecutionError(error: unknown, failedFile: string | undefined): CopyError {
  if (error instanceof CopyError) return error;
  if (isExistingFilesystemError(error)) {
    return new CopyError(409, 'COPY_CONFLICT', `Copy destination already exists: ${failedFile}`);
  }
  const message = error instanceof Error ? error.message : String(error);
  return new CopyError(500, 'COPY_IO_ERROR', `Copy failed: ${message}`);
}

async function stageDiskSource(asset: Asset, stagePath: string): Promise<void> {
  try {
    await fs.promises.copyFile(asset.absolutePath, stagePath, fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      try {
        await fs.promises.stat(asset.absolutePath);
      } catch (sourceError) {
        if (isMissingFilesystemError(sourceError)) {
          missingSource(`Asset source disappeared: ${asset.id}`);
        }
      }
    }
    throw error;
  }
}

async function readArchiveSource(asset: Asset): Promise<Buffer> {
  let buffer: Buffer | null;
  try {
    buffer = getZipEntryBuffer(asset.archivePath!, asset.archiveEntryPath!);
  } catch (error) {
    if (isMissingFilesystemError(error)) {
      missingSource(`Archive source disappeared: ${asset.id}`);
    }
    throw error;
  }
  if (!buffer) {
    try {
      await fs.promises.stat(asset.archivePath!);
    } catch (error) {
      if (isMissingFilesystemError(error)) {
        missingSource(`Archive source disappeared: ${asset.id}`);
      }
      throw error;
    }
    missingSource(`Archive entry source disappeared: ${asset.id}`);
  }
  return buffer;
}

export async function copyAssetToProject(req: CopyAssetRequest): Promise<CopyAssetResult> {
  if (!req || typeof req !== 'object') {
    invalidCopyRequest('Copy request must be an object');
  }
  if (
    (req.assetId !== undefined && typeof req.assetId !== 'string') ||
    (req.stackId !== undefined && typeof req.stackId !== 'string') ||
    (req.targetPath !== undefined && typeof req.targetPath !== 'string') ||
    (req.targetSubfolder !== undefined && typeof req.targetSubfolder !== 'string') ||
    (req.copyStackAll !== undefined && typeof req.copyStackAll !== 'boolean')
  ) {
    invalidCopyRequest('Copy request has invalid field types');
  }
  const settings = getAppSettings();
  const selectedTarget = req.targetPath || (settings.projectPaths && settings.projectPaths[0]) || settings.activeProjectPath;

  if (typeof selectedTarget !== 'string' || !selectedTarget.trim()) {
    invalidCopyRequest('Active game project path is not configured. Please set it in Settings.');
  }

  const targetDir = path.resolve(selectedTarget);
  const copiedFiles: string[] = [];
  let destDir: string;
  let stackName: string | undefined;
  let sourceAssets: Asset[];

  if (req.stackId && req.copyStackAll) {
    const stack = getStackById(req.stackId);
    if (!stack) {
      missingSource(`Stack not found: ${req.stackId}`);
    }
    stackName = stack.name;
    const stackFolder = req.targetSubfolder || stack.name.replace(/[^a-zA-Z0-9_-]/g, '_');
    destDir = path.resolve(targetDir, ...validateSubfolder(stackFolder));
    sourceAssets = getStackAssets(req.stackId);
  } else if (req.assetId) {
    const asset = getAssetById(req.assetId);
    if (!asset) {
      missingSource(`Asset not found: ${req.assetId}`);
    }
    destDir = req.targetSubfolder
      ? path.resolve(targetDir, ...validateSubfolder(req.targetSubfolder))
      : targetDir;
    sourceAssets = [asset];
  } else {
    invalidCopyRequest('Either assetId or stackId must be provided.');
  }

  if (!isWithinDirectory(targetDir, destDir)) {
    invalidCopyRequest('Copy destination is outside the selected project');
  }
  if (sourceAssets.length === 0) {
    missingSource('Stack has no assets to copy');
  }

  // Resolve every source and destination before making any project changes.
  const planned: PlannedCopy[] = [];
  const plannedDestinations = new Set<string>();
  for (const asset of sourceAssets) {
    const item = await planAssetCopy(asset, destDir, targetDir);
    const destinationKey = item.destination.normalize('NFC').toLowerCase();
    if (plannedDestinations.has(destinationKey)) {
      copyConflict(`Multiple assets would use the same destination: ${item.destination}`);
    }
    plannedDestinations.add(destinationKey);
    planned.push(item);
  }
  for (const item of planned) {
    await assertDestinationIsSafe(targetDir, item.destination);
    if (await lstatIfExists(item.destination)) {
      copyConflict(`Copy destination already exists: ${item.destination}`);
    }
  }

  await assertMissingTargetHasNoSymlinkParent(targetDir);

  // A generated stack folder is owned by one copy operation. Two different
  // names can sanitize to the same folder even when member names differ.
  if (stackName && !req.targetSubfolder && await lstatIfExists(destDir)) {
    copyConflict(`Stack destination folder already exists: ${destDir}`);
  }

  const published: PublishedFile[] = [];
  const unclearedStages = new Set<string>();
  let failedFile: string | undefined;
  try {
    await ensureDestinationDirectory(targetDir, destDir, Boolean(stackName && !req.targetSubfolder));

    for (const item of planned) {
      failedFile = item.destination;
      await assertDestinationIsSafe(targetDir, item.destination);
      const stagePath = path.join(destDir, `.assettlor-copy-${crypto.randomUUID()}.tmp`);
      let stageError: unknown;

      try {
        if (item.asset.isArchiveEntry) {
          const buffer = await readArchiveSource(item.asset);
          await fs.promises.writeFile(stagePath, buffer, { flag: 'wx' });
        } else {
          await stageDiskSource(item.asset, stagePath);
        }

        const stageStat = await fs.promises.lstat(stagePath);
        await assertDestinationIsSafe(targetDir, item.destination);
        await fs.promises.link(stagePath, item.destination);
        published.push({
          destination: item.destination,
          dev: stageStat.dev,
          ino: stageStat.ino,
        });
      } catch (error) {
        stageError = error;
      }

      try {
        await fs.promises.unlink(stagePath);
      } catch (error) {
        if (!isMissingFilesystemError(error)) {
          unclearedStages.add(stagePath);
          if (!stageError) stageError = error;
        }
      }
      if (stageError) throw stageError;
    }
  } catch (error) {
    const { rolledBackFiles, remainingFiles } = await rollbackPublishedFiles(published);
    for (const stagePath of unclearedStages) {
      try {
        await fs.promises.unlink(stagePath);
      } catch {
        // A failed cleanup is reported by its exact path below.
      }
      try {
        if (await lstatIfExists(stagePath)) remainingFiles.push(stagePath);
      } catch {
        // The path may still exist but cannot be inspected; report it.
        remainingFiles.push(stagePath);
      }
    }
    const classified = classifyExecutionError(error, failedFile);
    throw new CopyError(classified.status, classified.code, classified.message, {
      copiedFiles: published.map((file) => file.destination),
      rolledBackFiles,
      remainingFiles,
      failedFile,
      targetDirectory: destDir,
    });
  }

  copiedFiles.push(...published.map((file) => file.destination));

  if (stackName) {
    return {
      success: true,
      copiedFiles,
      targetDirectory: destDir,
      copyMode: 'stack',
      copiedCount: copiedFiles.length,
      message: `Copied ${copiedFiles.length} files from "${stackName}" stack to ${destDir}`,
    };
  }

  return {
    success: true,
    copiedFiles,
    targetDirectory: destDir,
    copyMode: 'asset',
    copiedCount: copiedFiles.length,
    message: `Copied ${path.basename(copiedFiles[0])} to ${destDir}`,
  };
}
