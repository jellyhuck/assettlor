export type AssetCategory = 'image' | 'audio' | 'model' | 'archive' | 'other';

export type SpriteCategory = 'character' | 'object' | 'texture' | 'background' | 'unclassified';

export interface ImageMetadata {
  width?: number;
  height?: number;
  format?: string;
  colorSpace?: string;
  channels?: number;
  hasAlpha?: boolean;
  density?: number;
  orientation?: number; // Original EXIF orientation, applied to the thumbnail
  // Sprite classification fields
  spriteType?: SpriteCategory;
  spriteConfidence?: number;
}

export interface AudioMetadata {
  duration?: number; // in seconds
  sampleRate?: number;
  numberOfChannels?: number;
  bitrate?: number;
  codec?: string;
  lossless?: boolean;
  bpm?: number;
  tempoDescription?: string;
  audioThumbnailVersion?: number;
  audioMetadataStatus?: 'complete' | 'partial' | 'failed';
  audioMetadataError?: string;
}

export type ModelVector3 = [number, number, number];

export interface ModelMetadata {
  gltfVersion?: string;
  generator?: string;
  sceneCount?: number;
  nodeCount?: number;
  meshCount?: number;
  primitiveCount?: number;
  vertexCount?: number;
  triangleCount?: number;
  materialCount?: number;
  textureCount?: number;
  animationCount?: number;
  skinCount?: number;
  /** World-space axis-aligned bounds of the default scene. */
  modelBounds?: { min: ModelVector3; max: ModelVector3 };
  gltfExtensionsUsed?: string[];
  gltfExtensionsRequired?: string[];
  modelThumbnailVersion?: number;
  modelMetadataStatus?: 'complete' | 'partial' | 'failed';
  modelMetadataError?: string;
  /** 'partial' renders skipped some geometry; 'placeholder' drew none. */
  modelThumbnailStatus?: 'rendered' | 'partial' | 'placeholder';
  modelThumbnailIssue?: string;
}

export type AssetMetadata = ImageMetadata & AudioMetadata & ModelMetadata & {
  pack?: string;
  /** Subfolders of the asset's library-relative path, outermost first (Folder Classifier). */
  folders?: string[];
  classifierProvenance?: {
    bpm?: { previousBpm: number | null; previousTempoDescription: string | null };
    pack?: { previousPack: string | null };
  };
  thumbnailFingerprint?: string;
  metadataProcessingVersion?: string;
  raw?: Record<string, unknown>;
};

export interface Asset {
  id: string;
  path: string; // Relative to scanned library root or virtual path: "path/to/archive.zip#/inner/file.png"
  absolutePath: string;
  name: string;
  extension: string;
  category: AssetCategory;
  size: number;
  mtime: number;
  hash: string;
  isArchiveEntry: boolean;
  archivePath?: string | null;
  archiveEntryPath?: string | null;
  sourceDirectory?: string | null;
  thumbnailUrl: string;
  fileUrl: string;
  metadata: AssetMetadata;
  stackId?: string | null;
  stackIndex?: number | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
}

export type StackType = 'animation' | 'audio_variation';

/**
 * Resolves the appropriate image URL for browser rendering.
 * Formats like TGA (.tga) are not natively supported by web browsers in <img> tags,
 * so their converted WebP thumbnail is used instead. For web-native formats (.png, .jpg, etc.),
 * the full-resolution fileUrl is preferred unless preferThumbnail is requested or an error occurred.
 */
export function getImageDisplayUrl(
  asset?: { extension?: string; fileUrl?: string; thumbnailUrl?: string } | null,
  preferThumbnail = false
): string {
  if (!asset) return '';
  const ext = (asset.extension || '').toLowerCase();
  const isNonBrowserFormat = ext === '.tga';
  if (isNonBrowserFormat || preferThumbnail) {
    return asset.thumbnailUrl || asset.fileUrl || '';
  }
  return asset.fileUrl || asset.thumbnailUrl || '';
}

export interface AssetStack {
  id: string;
  name: string;
  type: StackType;
  itemCount: number;
  representativeAssetId: string;
  representativeAsset?: Asset;
  assets?: Asset[];
  metadata?: {
    fps?: number;
    framePattern?: string;
    durationRange?: { min: number; max: number };
  };
  tags: string[];
  createdAt: number;
}

export interface TagInfo {
  name: string;
  count: number;
  source?: string;
}

export interface FormatInfo {
  extension: string;
  count: number;
  category: AssetCategory;
}

export interface ResolutionInfo {
  width: number;
  height: number;
  formatted: string;
  count: number;
}

export interface BpmInfo {
  bpm: number;
  formatted: string;
  count: number;
}

export interface FolderInfo {
  name: string;
  count: number;
}

/** One library name and the configured library paths that carry it. */
export interface LibraryInfo {
  name: string;
  paths: string[];
  count: number;
}

export type ScanStatusType = 'idle' | 'scanning' | 'completed' | 'error';

/** Stage of a running scan: enumerating files, processing them, or classifying. */
export type ScanPhase = 'counting' | 'indexing' | 'classifying';

export interface ScanProgressEvent {
  status: ScanStatusType;
  libraryPath: string;
  libraryPaths?: string[];
  scannedCount: number;
  indexedCount: number;
  phase?: ScanPhase;
  /** Indexable items known so far; grows by each ZIP's entries when it is opened. */
  totalCount?: number;
  /** Items handled so far (cache hit, indexed, or failed), out of `totalCount`. */
  processedCount?: number;
  /** Assets published to the index so far during this scan (mini-batch commits). */
  committedCount?: number;
  currentFile?: string;
  message?: string;
  startTime?: number;
  elapsedMs?: number;
  error?: string;
  failedScopes?: string[];
  /** True while the scan rebuilds its libraries' index from scratch. */
  reindexing?: boolean;
}

export interface AppSettings {
  libraryPath: string;
  libraryPaths: string[];
  /** Optional names (aliases) by library path, for lib: filters. */
  libraryNames: Record<string, string[]>;
  activeProjectPath: string;
  projectPaths: string[];
  thumbnailQuality: number;
  autoStackAnimations: boolean;
  autoStackAudio: boolean;
  defaultFps: number;
  /** How the main catalog reaches results past the first page. */
  catalogPaging: CatalogPaging;
}

export type CatalogPaging = 'load-more' | 'pages';

export interface CopyAssetRequest {
  assetId?: string;
  stackId?: string;
  targetPath?: string;
  copyStackAll?: boolean;
  targetSubfolder?: string;
}

export interface CopyAssetResult {
  success: boolean;
  copiedFiles: string[];
  targetDirectory: string;
  copyMode: 'asset' | 'stack';
  copiedCount: number;
  message?: string;
}

export type CopyErrorCode =
  | 'INVALID_COPY_REQUEST'
  | 'COPY_SOURCE_MISSING'
  | 'COPY_CONFLICT'
  | 'COPY_IO_ERROR';

export interface CopyErrorDetails {
  /** Final paths published before failure, including those rolled back. */
  copiedFiles: string[];
  rolledBackFiles: string[];
  /** Paths still left by this operation; may include a temporary staging file. */
  remainingFiles: string[];
  failedFile?: string;
  targetDirectory?: string;
}

export interface CopyErrorResponse {
  error: string;
  code: CopyErrorCode;
  details?: CopyErrorDetails;
}

export interface AssetQueryParams {
  category?: string;
  tag?: string;
  format?: string;
  resolution?: string;
  bpm?: string;
  sprite?: string;
  pack?: string;
  folder?: string;
  library?: string;
  width?: string;
  height?: string;
  duration?: string;
  search?: string;
  stackType?: string;
  isStackedView?: boolean;
  sortBy?: 'name' | 'size' | 'mtime' | 'resolution' | 'duration' | 'bpm' | 'width' | 'height';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  limit?: number;
}

export interface AssetListResponse {
  items: (Asset | (AssetStack & { isStack: true }))[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  summary: {
    totalAssets: number;
    totalSize: number;
    imageCount: number;
    audioCount: number;
    modelCount: number;
    animationStackCount: number;
    audioStackCount: number;
  };
}

export interface AddAssetTagsRequest {
  tag?: string;
  tags?: string[];
  source?: string;
}

export interface RemoveAssetTagsRequest {
  tag?: string;
  tags?: string[];
}

export interface SetAssetTagsRequest {
  tags: string[];
  source?: string;
}

export interface BatchAssetTagsRequest {
  assetIds: string[];
  tags: string[];
  action?: 'add' | 'remove';
  source?: string;
}

export interface AssetTagsResponse {
  success: boolean;
  asset: Asset;
  tags: string[];
}

export interface StackTagsResponse {
  success: boolean;
  stack: AssetStack;
  tags: string[];
}

// -------------------------------------------------------------
// Classifier Framework & BPM Classifier Contracts
// -------------------------------------------------------------

export type ClassifierCategory = 'audio' | 'image' | 'archive' | 'general';

export interface ClassifierStepInfo {
  id: string;
  name: string;
  description: string;
}

export interface ClassifierInfo {
  id: string;
  name: string;
  description: string;
  category: ClassifierCategory;
  steps: ClassifierStepInfo[];
  settings: Record<string, unknown>;
}

export interface BpmClassifierSettings {
  enabled: boolean;
  minBpm: number;
  maxBpm: number;
  minDurationSeconds: number;
  maxAnalysisSeconds: number;
}

export interface SpriteClassifierSettings {
  enabled: boolean;
  minConfidence: number; // 0.0 - 1.0, default 0.5
  enableVisualAnalysis: boolean;
  enablePathAnalysis: boolean;
  enableStackAnalysis: boolean;
}

export interface PackClassifierSettings {
  enabled: boolean;
  inferFromArchive: boolean;
  inferFromDirectory: boolean;
  directoryStrategy: 'top' | 'enclosing' | 'pattern';
  directoryDepth: number;
  cleanSeparators: boolean;
  stripVersionSuffix: boolean;
  stripAffixes: boolean;
  caseConvention: 'as-is' | 'title' | 'lower' | 'upper';
  targetArchives?: string[];
  targetDirectories?: string[];
}

export interface FolderClassifierSettings {
  enabled: boolean;
  /** Include folders inside ZIP archives in addition to the folders leading to the archive. */
  includeArchiveFolders: boolean;
}

export type ClassifierTargetType = 'all' | 'asset' | 'directory' | 'archive';

export interface ClassifierTargetChoice {
  value: string;
  label: string;
}

export interface ClassifierAssetTargetChoice extends ClassifierTargetChoice {
  category: AssetCategory;
}

export interface ClassifierTargetInventory {
  directories: ClassifierTargetChoice[];
  archives: ClassifierTargetChoice[];
  assets: ClassifierAssetTargetChoice[];
}

export interface RunClassifierRequest {
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  settingsOverride?: Record<string, unknown>;
}

export interface ClassifierStepProgress {
  stepId: string;
  stepIndex: number;
  totalSteps: number;
  stepName: string;
  message?: string;
}

export interface ClassifierAssetResult {
  assetId: string;
  assetPath: string;
  success: boolean;
  result?: Record<string, unknown>;
  error?: string;
  retryable?: boolean;
  outcome?: 'classified' | 'no-result' | 'error';
  stale?: boolean;
}

export interface ClassifierRunResult {
  classifierId: string;
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  totalTargeted: number;
  processedCount: number;
  classifiedCount: number;
  failedCount: number;
  noResultCount?: number;
  errorCount?: number;
  details: ClassifierAssetResult[];
  elapsedMs: number;
}
