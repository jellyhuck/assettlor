export type AssetCategory = 'image' | 'audio' | 'archive' | 'other';

export interface ImageMetadata {
  width?: number;
  height?: number;
  format?: string;
  colorSpace?: string;
  channels?: number;
  hasAlpha?: boolean;
  density?: number;
}

export interface AudioMetadata {
  duration?: number; // in seconds
  sampleRate?: number;
  numberOfChannels?: number;
  bitrate?: number;
  codec?: string;
  lossless?: boolean;
}

export type AssetMetadata = ImageMetadata & AudioMetadata & {
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

export type ScanStatusType = 'idle' | 'scanning' | 'completed' | 'error';

export interface ScanProgressEvent {
  status: ScanStatusType;
  libraryPath: string;
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
  activeProjectPath: string;
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
  search?: string;
  stackType?: string;
  isStackedView?: boolean;
  sortBy?: 'name' | 'size' | 'mtime' | 'resolution' | 'duration';
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
