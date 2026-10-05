export type AssetCategory = 'image' | 'audio' | 'archive' | 'other';

export type SpriteCategory = 'character' | 'object' | 'texture' | 'background' | 'unclassified';

export interface ImageMetadata {
  width?: number;
  height?: number;
  format?: string;
  colorSpace?: string;
  channels?: number;
  hasAlpha?: boolean;
  density?: number;
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
}

export type AssetMetadata = ImageMetadata & AudioMetadata & {
  pack?: string;
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
  source?: 'folder' | 'archive' | 'extension' | 'category' | 'user';
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

export type ScanStatusType = 'idle' | 'scanning' | 'completed' | 'error';

export interface ScanProgressEvent {
  status: ScanStatusType;
  libraryPath: string;
  libraryPaths?: string[];
  scannedCount: number;
  indexedCount: number;
  currentFile?: string;
  message?: string;
  startTime?: number;
  elapsedMs?: number;
  error?: string;
}

export interface AppSettings {
  libraryPath: string;
  libraryPaths: string[];
  activeProjectPath: string;
  projectPaths: string[];
  thumbnailQuality: number;
  autoStackAnimations: boolean;
  autoStackAudio: boolean;
  defaultFps: number;
}

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
  message?: string;
}

export interface AssetQueryParams {
  category?: string;
  tag?: string;
  format?: string;
  resolution?: string;
  bpm?: string;
  sprite?: string;
  pack?: string;
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
  applyBpmTag?: boolean;
  applyTempoTag?: boolean;
  tempoTagPrefix?: string;
}

export interface SpriteClassifierSettings {
  enabled: boolean;
  minConfidence: number; // 0.0 - 1.0, default 0.5
  applySpriteTag?: boolean;
  spriteTagPrefix?: string;
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
  applyTag: boolean;
  tagPrefix?: string;
  targetArchives?: string[];
  targetDirectories?: string[];
}

export type ClassifierTargetType = 'all' | 'asset' | 'directory' | 'archive';

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
  tagsAdded?: string[];
  error?: string;
}

export interface ClassifierRunResult {
  classifierId: string;
  targetType: ClassifierTargetType;
  targetValue?: string | string[];
  totalTargeted: number;
  processedCount: number;
  classifiedCount: number;
  failedCount: number;
  details: ClassifierAssetResult[];
  elapsedMs: number;
}

