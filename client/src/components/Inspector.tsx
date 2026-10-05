import React, { useState, useEffect } from 'react';
import { Asset, AssetStack, AppSettings } from '../types';
import {
  X,
  Copy,
  Folder,
  Layers,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid,
  Volume2,
  Image as ImageIcon,
  Tag,
  Play,
  ChevronLeft,
  ChevronRight,
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
  initialViewMode?: 'stack' | 'assets';
  onSelectStack?: (stack: AssetStack & { isStack: true }) => void;
}

export function Inspector({
  item,
  onClose,
  settings,
  onTagClick,
  selectedTag,
  initialViewMode = 'stack',
  onSelectStack,
}: InspectorProps) {
  const { showToast } = useToast();

  const [pixelated, setPixelated] = useState(true);
  const [checkerboard, setCheckerboard] = useState(true);
  const [zoomLevel, setZoomLevel] = useState(1);
  const [stackAssets, setStackAssets] = useState<Asset[]>([]);
  const [selectedVariant, setSelectedVariant] = useState<Asset | null>(null);
  const [selectedFrameIndex, setSelectedFrameIndex] = useState(0);
  const [stackViewMode, setStackViewMode] = useState<'stack' | 'assets'>(initialViewMode);
  const [showCopyModal, setShowCopyModal] = useState(false);
  const [parentStack, setParentStack] = useState<(AssetStack & { isStack: true }) | null>(null);

  const isStack = Boolean(item && 'isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;

  // Sync initial view mode when prop changes
  useEffect(() => {
    if (initialViewMode) {
      setStackViewMode(initialViewMode);
    }
  }, [initialViewMode]);

  // Load stack frames / variations if item is a stack
  useEffect(() => {
    setZoomLevel(1);
    setSelectedFrameIndex(0);

    if (stack) {
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
        });
    } else {
      setStackAssets([]);
      setSelectedVariant(null);
    }
  }, [item?.id, stack?.id]);

  // If item is an individual asset that has a stackId, fetch its parent stack details
  useEffect(() => {
    if (!isStack && item && (item as Asset).stackId) {
      fetch(`/api/stacks/${(item as Asset).stackId}`)
        .then((res) => res.json())
        .then((data) => {
          if (data && data.id) {
            setParentStack({ ...data, isStack: true });
          }
        })
        .catch(() => setParentStack(null));
    } else {
      setParentStack(null);
    }
  }, [item?.id, isStack]);

  if (!item) return null;

  // Active content asset when browsing stack members separately or viewing selected frame
  const currentSeparateAsset =
    isStack && stackAssets.length > 0
      ? stackAssets[selectedFrameIndex] || stackAssets[0]
      : selectedVariant || stack?.representativeAsset || (item as Asset);

  // Asset to display in metadata section and single preview
  const displayedAsset =
    !isStack
      ? (item as Asset)
      : currentSeparateAsset || selectedVariant || stack?.representativeAsset;

  if (!displayedAsset) return null;

  const isDisplayedImage = displayedAsset.category === 'image';
  const isDisplayedAudio = displayedAsset.category === 'audio';

  const formatBytes = (bytes?: number) => {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  };

  const copyPathToClipboard = () => {
    navigator.clipboard.writeText(displayedAsset.absolutePath);
    showToast('success', 'Path Copied', displayedAsset.absolutePath);
  };

  return (
    <>
      <div className="w-96 shrink-0 h-full bg-[#161626] border-l border-[#26263c] flex flex-col overflow-hidden text-slate-200">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#242438] bg-[#131320]">
          <div className="flex items-center gap-2 truncate">
            {isStack ? (
              <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
            ) : isDisplayedImage ? (
              <ImageIcon className="w-4 h-4 text-cyan-400 shrink-0" />
            ) : (
              <Volume2 className="w-4 h-4 text-rose-400 shrink-0" />
            )}
            <span className="text-xs font-semibold text-slate-100 truncate">
              {isStack && stackViewMode === 'stack' ? stack?.name : displayedAsset.name}
            </span>
            {isStack && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-indigo-950/70 text-indigo-300 border border-indigo-500/30 shrink-0">
                {stack?.itemCount} items
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded text-slate-400 hover:text-slate-200 hover:bg-[#252538] transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Parent stack breadcrumb link for individual asset */}
        {parentStack && (
          <div className="px-4 py-2 border-b border-[#242438] bg-indigo-950/30 flex items-center justify-between text-xs">
            <div className="flex items-center gap-1.5 truncate">
              <Layers className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="text-slate-300 truncate">
                Part of: <strong className="text-white">{parentStack.name}</strong>
              </span>
            </div>
            <button
              onClick={() => onSelectStack && onSelectStack(parentStack)}
              className="px-2 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px] font-medium transition-colors cursor-pointer shrink-0 ml-2"
            >
              View Stack
            </button>
          </div>
        )}

        {/* Stack Mode Switcher Tabs */}
        {isStack && (
          <div className="px-4 pt-3 pb-1 border-b border-[#242438] bg-[#141423]">
            <div className="flex items-center p-1 bg-[#10101b] rounded-lg border border-[#232338] text-xs">
              <button
                onClick={() => setStackViewMode('stack')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all cursor-pointer ${
                  stackViewMode === 'stack'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a1a2e]'
                }`}
              >
                {stack?.type === 'animation' ? (
                  <>
                    <Play className="w-3.5 h-3.5" />
                    <span>Animation Controls</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="w-3.5 h-3.5" />
                    <span>Audio Player</span>
                  </>
                )}
              </button>
              <button
                onClick={() => setStackViewMode('assets')}
                className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md font-medium transition-all cursor-pointer ${
                  stackViewMode === 'assets'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-[#1a1a2e]'
                }`}
              >
                <Grid className="w-3.5 h-3.5" />
                <span>
                  {stack?.type === 'animation' ? 'Content Frames' : 'Content Assets'} (
                  {stackAssets.length || stack?.itemCount})
                </span>
              </button>
            </div>
          </div>
        )}

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* Stack View: Animation Flipbook controls */}
          {isStack && stackViewMode === 'stack' && stack?.type === 'animation' && stackAssets.length > 0 ? (
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
                initialFrameIndex={selectedFrameIndex}
                selectedFrameIndex={selectedFrameIndex}
                onSelectFrame={(idx, frame) => {
                  setSelectedFrameIndex(idx);
                  setSelectedVariant(frame);
                }}
                onViewFrameSeparately={(frame, idx) => {
                  setSelectedFrameIndex(idx);
                  setSelectedVariant(frame);
                  setStackViewMode('assets');
                }}
              />
            </div>
          ) : isStack && stackViewMode === 'stack' && stack?.type === 'audio_variation' ? (
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer
                asset={displayedAsset}
                variants={stackAssets}
                onSelectVariant={(v) => {
                  setSelectedVariant(v);
                  const idx = stackAssets.findIndex((a) => a.id === v.id);
                  if (idx >= 0) setSelectedFrameIndex(idx);
                }}
              />
            </div>
          ) : isStack && stackViewMode === 'assets' ? (
            /* Separate Content Assets View */
            <div className="space-y-3">
              {/* Frame navigation & carousel strip */}
              <div className="space-y-2 bg-[#12121e] p-2.5 rounded-lg border border-[#252538]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs font-semibold text-slate-200 shrink-0">
                      {stack?.type === 'animation' ? 'Frame' : 'Asset'} {selectedFrameIndex + 1} of{' '}
                      {stackAssets.length}
                    </span>
                    <span
                      className="text-[11px] font-mono text-indigo-300 truncate"
                      title={currentSeparateAsset.name}
                    >
                      • {currentSeparateAsset.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      onClick={() => {
                        const nextIdx =
                          selectedFrameIndex > 0 ? selectedFrameIndex - 1 : stackAssets.length - 1;
                        setSelectedFrameIndex(nextIdx);
                        setSelectedVariant(stackAssets[nextIdx]);
                      }}
                      title="Previous asset"
                      className="p-1 rounded bg-[#202033] hover:bg-[#2b2b44] text-slate-400 hover:text-white border border-[#2d2d46] transition-colors cursor-pointer"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => {
                        const nextIdx =
                          selectedFrameIndex + 1 < stackAssets.length ? selectedFrameIndex + 1 : 0;
                        setSelectedFrameIndex(nextIdx);
                        setSelectedVariant(stackAssets[nextIdx]);
                      }}
                      title="Next asset"
                      className="p-1 rounded bg-[#202033] hover:bg-[#2b2b44] text-slate-400 hover:text-white border border-[#2d2d46] transition-colors cursor-pointer"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Thumbnails strip */}
                <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5">
                  {stackAssets.map((assetItem, index) => {
                    const isCurrent = index === selectedFrameIndex;
                    return (
                      <button
                        key={assetItem.id}
                        onClick={() => {
                          setSelectedFrameIndex(index);
                          setSelectedVariant(assetItem);
                        }}
                        className={`relative shrink-0 w-12 h-12 rounded-lg border overflow-hidden p-0.5 transition-all cursor-pointer ${
                          isCurrent
                            ? 'border-indigo-500 ring-2 ring-indigo-500/50 bg-[#25253e]'
                            : 'border-[#2d2d44] hover:border-slate-500 bg-[#161625]'
                        }`}
                        title={`${assetItem.name} (${formatBytes(assetItem.size)})`}
                      >
                        <img
                          src={assetItem.thumbnailUrl || assetItem.fileUrl}
                          alt={assetItem.name}
                          className={`w-full h-full object-contain ${
                            pixelated ? 'pixelated' : 'smooth-render'
                          }`}
                        />
                        <span className="absolute bottom-0 right-0 px-1 text-[9px] font-mono bg-black/85 text-slate-200 rounded-tl">
                          {index + 1}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Single visual or audio preview for this separate asset */}
              {isDisplayedImage ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-300">Asset Preview</span>
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
                      src={currentSeparateAsset.fileUrl || currentSeparateAsset.thumbnailUrl}
                      alt={currentSeparateAsset.name}
                      style={{ transform: `scale(${zoomLevel})` }}
                      className={`max-w-full max-h-full object-contain origin-center transition-transform ${
                        pixelated ? 'pixelated' : 'smooth-render'
                      }`}
                    />
                  </div>
                </div>
              ) : isDisplayedAudio ? (
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-slate-300">Audio Preview</span>
                  <AudioWaveformPlayer asset={currentSeparateAsset} variants={[]} />
                </div>
              ) : null}
            </div>
          ) : isDisplayedImage ? (
            /* Standalone image preview */
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
                  src={displayedAsset.fileUrl || displayedAsset.thumbnailUrl}
                  alt={displayedAsset.name}
                  style={{ transform: `scale(${zoomLevel})` }}
                  className={`max-w-full max-h-full object-contain origin-center transition-transform ${
                    pixelated ? 'pixelated' : 'smooth-render'
                  }`}
                />
              </div>
            </div>
          ) : isDisplayedAudio ? (
            /* Standalone audio waveform */
            <div className="space-y-2">
              <span className="text-xs font-semibold text-slate-300">Audio Waveform</span>
              <AudioWaveformPlayer asset={displayedAsset} variants={[]} />
            </div>
          ) : null}

          {/* Quick Action Buttons */}
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() => setShowCopyModal(true)}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg text-xs font-semibold shadow-sm transition-all cursor-pointer truncate"
            >
              <Copy className="w-3.5 h-3.5 shrink-0" />
              <span className="truncate">
                {isStack && stackViewMode === 'assets'
                  ? 'Copy Frame'
                  : isStack
                  ? 'Copy Stack'
                  : 'Copy to Project'}
              </span>
            </button>
            <button
              onClick={copyPathToClipboard}
              className="flex items-center justify-center gap-1.5 px-3 py-2 bg-[#202033] hover:bg-[#2b2b44] text-slate-200 border border-[#30304a] rounded-lg text-xs font-medium transition-all cursor-pointer truncate"
            >
              <Folder className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
              <span className="truncate">Copy Path</span>
            </button>
          </div>

          {/* Metadata Section */}
          <div className="space-y-3 pt-3 border-t border-[#25253c]">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                {isStack ? 'Frame Metadata' : 'Asset Metadata'}
              </h4>
              {isStack && stackAssets.length > 0 && (
                <span className="text-[10px] font-mono text-indigo-400">
                  Frame {selectedFrameIndex + 1}/{stackAssets.length}
                </span>
              )}
            </div>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Name</span>
                <span
                  className="font-mono text-slate-200 select-text truncate max-w-[200px]"
                  title={displayedAsset.name}
                >
                  {displayedAsset.name}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">Format</span>
                <span className="font-mono uppercase font-semibold text-indigo-400">
                  {displayedAsset.extension.replace('.', '')}
                </span>
              </div>

              <div className="flex justify-between py-1 border-b border-[#202033]">
                <span className="text-slate-400">File Size</span>
                <span className="font-mono text-slate-200">{formatBytes(displayedAsset.size)}</span>
              </div>

              {isDisplayedImage &&
                displayedAsset.metadata.width &&
                displayedAsset.metadata.height && (
                  <div className="flex justify-between py-1 border-b border-[#202033]">
                    <span className="text-slate-400">Dimensions</span>
                    <span className="font-mono font-medium text-cyan-300">
                      {displayedAsset.metadata.width} × {displayedAsset.metadata.height} px
                    </span>
                  </div>
                )}

              {isDisplayedImage && displayedAsset.metadata.colorSpace && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Color Space</span>
                  <span className="font-mono text-slate-300">
                    {displayedAsset.metadata.colorSpace}
                  </span>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.duration && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Duration</span>
                  <span className="font-mono font-medium text-cyan-300">
                    {displayedAsset.metadata.duration.toFixed(2)} seconds
                  </span>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.sampleRate && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Sample Rate</span>
                  <span className="font-mono text-slate-300">
                    {(displayedAsset.metadata.sampleRate / 1000).toFixed(1)} kHz
                  </span>
                </div>
              )}

              {isDisplayedAudio && displayedAsset.metadata.numberOfChannels && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Channels</span>
                  <span className="font-mono text-slate-300">
                    {displayedAsset.metadata.numberOfChannels === 1 ? 'Mono' : 'Stereo'}
                  </span>
                </div>
              )}

              {displayedAsset.isArchiveEntry && (
                <div className="flex justify-between py-1 border-b border-[#202033]">
                  <span className="text-slate-400">Archive Source</span>
                  <span className="font-mono text-amber-400 truncate max-w-[180px]">
                    {displayedAsset.archivePath?.split('/').pop()}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* Tags Section */}
          {displayedAsset.tags && displayedAsset.tags.length > 0 && (
            <div className="space-y-2 pt-2 border-t border-[#25253c]">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 uppercase tracking-wider">
                <Tag className="w-3.5 h-3.5 text-indigo-400" />
                Tags ({displayedAsset.tags.length})
              </div>
              <div className="flex flex-wrap gap-1.5">
                {displayedAsset.tags.map((tag) => {
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
              {displayedAsset.absolutePath}
            </div>
          </div>
        </div>
      </div>

      {/* Copy Modal */}
      {showCopyModal && (
        <CopyModal
          isOpen={showCopyModal}
          onClose={() => setShowCopyModal(false)}
          asset={displayedAsset}
          stack={isStack ? stack : undefined}
          targetDir={settings.activeProjectPath}
        />
      )}
    </>
  );
}
