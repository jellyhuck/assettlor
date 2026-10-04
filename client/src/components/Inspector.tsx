import React, { useState, useEffect } from 'react';
import { Asset, AssetStack, AppSettings } from '../types';
import {
  X,
  Copy,
  Download,
  Folder,
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  FileText,
  Volume2,
  Image as ImageIcon,
  Check,
  Tag,
} from 'lucide-react';
import { FlipbookPlayer } from './FlipbookPlayer';
import { AudioWaveformPlayer } from './AudioWaveformPlayer';
import { useToast } from './Toast';
import { CopyModal } from './CopyModal';

interface InspectorProps {
  item: Asset | (AssetStack & { isStack: true }) | null;
  onClose: () => void;
  settings: AppSettings;
  onTagClick?: (tag: string) => void;
  selectedTag?: string | null;
}

export function Inspector({ item, onClose, settings, onTagClick, selectedTag }: InspectorProps) {
  const { showToast } = useToast();

  const [pixelated, setPixelated] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [stackAssets, setStackAssets] = useState<Asset[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Asset | null>(null);
  const [loadingStack, setLoadingStack] = useState(false);
  const [showCopyModal, setShowCopyModal] = useState(false);

  const isStack = Boolean(item && 'isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;
  const asset = !isStack
    ? (item as Asset)
    : selectedVariant || stack?.representativeAsset || null;

  // Load stack frames / variations if item is a stack
  useEffect(() => {
    setZoomLevel(1);
    setSelectedVariant(null);

    if (stack) {
      setLoadingStack(true);
      fetch(`/api/stacks/${stack.id}/assets`)
        .then((res) => res.json())
        .then((assets: Asset[]) => {
          setStackAssets(assets);
          if (assets.length > 0) {
            setSelectedVariant(assets[0]);
          }
        })
        .catch((err) => {
          console.warn('Failed to load stack assets:', err);
        })
        .finally(() => setLoadingStack(false));
    } else {
      setStackAssets([]);
    }
  }, [item, stack?.id]);

  if (!item || !asset) return null;

  const isImage = asset.category === 'image';
  const isAudio = asset.category === 'audio';

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const copyPathToClipboard = () => {
    navigator.clipboard.writeText(asset.absolutePath);
    showToast('success', 'Path Copied', asset.absolutePath);
  };

  return (
    <>
      <div className="w-96 shrink-0 h-full bg-[#161626] border-l border-[#26263c] flex flex-col overflow-hidden text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#242438] bg-[#131320]">
          <div className="flex items-center gap-2 truncate">
            {isStack ? (
              <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
            ) : isImage ? (
              <ImageIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <Volume2 className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span className="text-xs font-semibold text-slate-100 truncate">
              {isStack ? stack?.name : asset.name}
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Main Visual/Audio Player */}
          {isStack && stack?.type === 'animation' && stackAssets.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Animation Flipbook</span>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => setPixelated(!pixelated)}
                    title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
                    className={`px-2 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                      pixelated
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    {pixelated ? 'Pixelated' : 'Smooth'}
                  </button>
                  <button
                    onClick={() => setCheckerboard(!checkerboard)}
                    title="Toggle Checkerboard Background"
                    className={`p-1 rounded border transition-colors cursor-pointer ${
                      checkerboard
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    <Grid className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <FlipbookPlayer
                frames={stackAssets}
                pixelated={pixelated}
                checkerboard={checkerboard}
                initialFps={settings.defaultFps}
              />
            </div>
          ) : isImage ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-300">Preview</span>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => setZoomLevel((z) => Math.max(0.25, z - 0.25))}
                    title="Zoom Out"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <ZoomOut className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-[10px] font-mono text-slate-400 w-8 text-center">
                    {Math.round(zoomLevel * 100)}%
                  </span>
                  <button
                    onClick={() => setZoomLevel((z) => Math.min(4, z + 0.25))}
                    title="Zoom In"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <ZoomIn className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setZoomLevel(1)}
                    title="Reset Zoom"
                    className="p-1 rounded hover:bg-[#252538] text-slate-400 hover:text-white cursor-pointer"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => setPixelated(!pixelated)}
                    title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
                    className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono border transition-colors cursor-pointer ${
                      pixelated
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    {pixelated ? 'Pixel' : 'Smooth'}
                  </button>
                  <button
                    onClick={() => setCheckerboard(!checkerboard)}
                    title="Toggle Checkerboard"
                    className={`p-1 rounded border transition-colors cursor-pointer ${
                      checkerboard
                        ? 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300'
                        : 'bg-[#202033] border-[#2f2f48] text-slate-400'
                    }`}
                  >
                    <Grid className="w-3 h-3" />
                  </button>
                </div>
              </div>
              <div
                className={`relative flex items-center justify-center rounded-lg overflow-auto border border-[#2b2b42] h-60 p-2 ${
                  checkerboard ? 'checkerboard-bg' : 'bg-[#11111d]'
                }`}
              >
                <img
                  src={asset.fileUrl || asset.thumbnailUrl}
                  alt={asset.name}
                  style={{ transform: `scale(${zoomLevel})` }}
                  className={`max-w-full max-h-full object-contain origin-center transition-transform ${
                    pixelated ? 'pixelated' : 'smooth-render'
                  }`}
                />
              </div>
            </div>
          ) : isAudio ? (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer
                asset={asset}
                variants={isStack ? stackAssets : []}
                onSelectVariant={(v) => setSelectedVariant(v)}
              />
            </div>
          ) : null}

          {/* Quick Action Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer"
            >
              <Copy className="w-3.5 h-3.5" />
              Copy to Project
            </button>
            <button
              onClick={copyPathToClipboard}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#202033] hover:bg-[#2b2b44] text-slate-200 border border-[#30304a] rounded-lg text-xs font-medium transition-all cursor-pointer"
            >
              <Folder className="w-3.5 h-3.5 text-indigo-400" />
              Copy Path
            </button>
          </div>

          {/* Metadata Section */}
          <div className="space-y-3 pt-3 border-t border-[#25253c]">
            <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Asset Metadata
            </h4>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Name</span>
                <span className="font-mono text-slate-200 select-text truncate max-w-[200px]" title={asset.name}>
                  {asset.name}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">Format</span>
                <span className="font-mono uppercase font-semibold text-indigo-400">
                  {asset.extension.replace('.', '')}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Size</span>
                <span className="font-mono text-slate-200">{formatBytes(asset.size)}</span>
              </div>

              {isImage && asset.metadata.width && asset.metadata.height && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Dimensions</span>
                  <span className="font-mono font-medium text-cyan-300">
                    {asset.metadata.width} × {asset.metadata.height} px
                  </span>
                </div>
              )}

              {isImage && asset.metadata.colorSpace && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Color Space</span>
                  <span className="font-mono text-slate-300">{asset.metadata.colorSpace}</span>
                </div>
              )}

              {isAudio && asset.metadata.duration && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Duration</span>
                  <span className="font-mono font-medium text-cyan-300">
                    {asset.metadata.duration.toFixed(2)} seconds
                  </span>
                </div>
              )}

              {isAudio && asset.metadata.sampleRate && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Sample Rate</span>
                  <span className="font-mono text-slate-300">
                    {(asset.metadata.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                </div>
              )}

              {isAudio && asset.metadata.numberOfChannels && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Channels</span>
                  <span className="font-mono text-slate-300">
                    {asset.metadata.numberOfChannels === 1 ? 'Mono' : 'Stereo'}
                  </span>
                </div>
              )}

              {asset.isArchiveEntry && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Archive Source</span>
                  <span className="font-mono text-amber-400 truncate max-w-[180px]">
                    {asset.archivePath?.split('/').pop()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Tags Section */}
          {asset.tags && asset.tags.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-[#25253c]">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <Tag className="w-3.5 h-3.5 text-indigo-400" />
                Tags ({asset.tags.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {asset.tags.map((tag) => {
                  const cleanTag = tag.replace(/^#/, '');
                  const isSelected = selectedTag === cleanTag || selectedTag === `#${cleanTag}`;
                  return (
                    <button
                      key={tag}
                      onClick={() => onTagClick && onTagClick(tag)}
                      title={`Filter by tag #${cleanTag}`}
                      className={`px-2 py-0.5 text-xs rounded-md border transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-indigo-600 text-white border-indigo-400 font-semibold shadow-xs ring-1 ring-indigo-400/50'
                          : 'bg-[#202035] hover:bg-indigo-900/50 border-[#2d2d46] hover:border-indigo-500/50 text-slate-300 hover:text-white'
                      }`}
                    >
                      #{cleanTag}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Filesystem Path */}
          <div className="space-y-1.5 pt-2 border-t border-[#25253c]">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
              Filesystem Location
            </span>
            <div className="p-2 bg-[#12121d] border border-[#28283e] rounded text-[11px] font-mono text-slate-400 break-all select-text">
              {asset.absolutePath}
            </div>
          </div>
        </div>
      </div>

      {/* Copy Modal */}
      {showCopyModal && (
        <CopyModal
          isOpen={showCopyModal}
          onClose={() => setShowCopyModal(false)}
          asset={asset}
          stack={stack}
          targetDir={settings.activeProjectPath}
        />
      )}
    </>
  );
}
