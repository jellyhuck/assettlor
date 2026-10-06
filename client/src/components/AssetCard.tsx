import React, { useState, useEffect, useRef } from 'react';
import { Asset, AssetStack, ViewMode, CardZoom } from '../types';
import {
  Layers,
  Copy,
  Volume2,
  Play,
  Pause,
  Image as ImageIcon,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
} from 'lucide-react';
import { useToast } from './Toast';
import { AudioAssetIcon } from './AudioIcons';

interface AssetCardProps {
  item: Asset | (AssetStack & { isStack: true });
  isSelected: boolean;
  onSelect: () => void;
  viewMode: ViewMode;
  cardZoom: CardZoom;
  onQuickCopy?: () => void;
  onSelectAsset?: (asset: Asset) => void;
  onViewStackAssets?: () => void;
}

export function AssetCard({
  item,
  isSelected,
  onSelect,
  viewMode,
  cardZoom,
  onQuickCopy,
  onSelectAsset,
  onViewStackAssets,
}: AssetCardProps) {
  const { showToast } = useToast();
  const [isHovered, setIsHovered] = useState(false);
  const [hoverFrameIndex, setHoverFrameIndex] = useState(0);
  const [stackFrames, setStackFrames] = useState<Asset[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showMiniDrawer, setShowMiniDrawer] = useState(false);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const [thumbnailError, setThumbnailError] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isStack = Boolean('isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;
  const asset = !isStack ? (item as Asset) : stack?.representativeAsset;

  // Reset frame cache if card identity changes
  useEffect(() => {
    setStackFrames([]);
    setHoverFrameIndex(0);
    setIsExpanded(false);
    setShowMiniDrawer(false);
    setThumbnailError(false);
  }, [item.id]);

  // Format file size
  const formatBytes = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(0)} ${sizes[i]}`;
  };

  // Hover flipbook cycle for animation stacks or fetch for expansion
  useEffect(() => {
    if (isStack && (isHovered || isExpanded || showMiniDrawer)) {
      if (stackFrames.length === 0) {
        fetch(`/api/stacks/${stack!.id}/assets`)
          .then((res) => res.json())
          .then((assets: Asset[]) => setStackFrames(assets))
          .catch(() => {});
      }
    }

    if (isStack && stack?.type === 'animation' && isHovered && stackFrames.length > 1) {
      const timer = setInterval(() => {
        setHoverFrameIndex((prev) => (prev + 1) % stackFrames.length);
      }, 120);
      return () => clearInterval(timer);
    } else if (!isHovered) {
      setHoverFrameIndex(0);
    }
  }, [isHovered, isStack, stack?.id, stack?.type, isExpanded, showMiniDrawer, stackFrames.length]);

  // Audio preview on hover
  const toggleCardAudio = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!asset) return;

    if (isPlayingAudio) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
      }
      setIsPlayingAudio(false);
    } else {
      if (!audioRef.current) {
        audioRef.current = new Audio(asset.fileUrl);
        audioRef.current.onended = () => setIsPlayingAudio(false);
      }
      audioRef.current.play().then(() => setIsPlayingAudio(true)).catch(() => {});
    }
  };

  // Cleanup audio
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  if (!asset) return null;

  const currentDisplayAsset =
    isStack && stack?.type === 'animation' && stackFrames[hoverFrameIndex]
      ? stackFrames[hoverFrameIndex]
      : asset;

  const title = isStack ? stack!.name : asset.name;
  const isImage = asset.category === 'image';
  const isAudio = asset.category === 'audio';

  // Card dimensions based on zoom
  let cardWidthClass = 'w-full';
  let thumbnailHeight = 'h-36';
  if (cardZoom === 'small') thumbnailHeight = 'h-28';
  if (cardZoom === 'large') thumbnailHeight = 'h-48';

  // List View Rendering
  if (viewMode === 'list') {
    return (
      <div className="flex flex-col gap-1 w-full">
        <div
          onClick={onSelect}
          className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-pointer group ${
            isSelected
              ? 'bg-[#22223a] border-indigo-500 shadow-md ring-1 ring-indigo-500/40'
              : 'bg-[#181829] border-[#26263a] hover:bg-[#1f1f33] hover:border-[#363654]'
          }`}
        >
          {/* Expand chevron for stacks */}
          {isStack ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setIsExpanded(!isExpanded);
              }}
              title={isExpanded ? 'Collapse content assets' : 'Expand to view content assets'}
              className="p-1 rounded text-slate-400 hover:text-white hover:bg-[#252538] transition-colors cursor-pointer shrink-0"
            >
              {isExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-indigo-400" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
              )}
            </button>
          ) : (
            <div className="w-4 shrink-0" />
          )}

          {/* Small thumbnail */}
          <div className="w-10 h-10 rounded bg-[#12121d] border border-[#2b2b40] overflow-hidden shrink-0 flex items-center justify-center checkerboard-bg">
            {currentDisplayAsset.thumbnailUrl && !thumbnailError ? (
              <img
                src={currentDisplayAsset.thumbnailUrl}
                alt={title}
                className="w-full h-full object-contain pixelated"
                loading="lazy"
                onError={() => setThumbnailError(true)}
              />
            ) : isAudio ? (
              <AudioAssetIcon
                duration={currentDisplayAsset.metadata.duration}
                bpm={currentDisplayAsset.metadata.bpm}
                className="w-6 h-6"
              />
            ) : (
              <img
                src={currentDisplayAsset.fileUrl}
                alt={title}
                className="w-full h-full object-contain pixelated"
                loading="lazy"
              />
            )}
          </div>

          {/* Title & Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-200 truncate">{title}</span>
              {isStack && (
                <span className="px-1.5 py-0.2 rounded text-[10px] font-medium bg-indigo-950/70 text-indigo-300 border border-indigo-500/30 shrink-0">
                  {stack?.type === 'animation' ? `🎬 ${stack?.itemCount} frames` : `🎵 ${stack?.itemCount} vars`}
                </span>
              )}
            </div>
            <span className="text-[11px] font-mono text-slate-400 truncate block">
              {asset.path}
            </span>
          </div>

          {/* Badges */}
          <div className="flex items-center gap-2 text-[11px] font-mono text-slate-400 shrink-0">
            <span className="px-1.5 py-0.5 rounded bg-[#252538] text-slate-300 uppercase">
              {asset.extension.replace('.', '')}
            </span>
            <span>{formatBytes(asset.size)}</span>
          </div>

          {/* View assets action for stacks */}
          {isStack && onViewStackAssets && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onViewStackAssets();
              }}
              title="View each content asset separately"
              className="p-1.5 rounded hover:bg-indigo-600 hover:text-white text-slate-400 transition-all cursor-pointer shrink-0 text-xs flex items-center gap-1"
            >
              <Eye className="w-3.5 h-3.5 text-indigo-400 group-hover:text-white" />
            </button>
          )}

          {/* Action button */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (onQuickCopy) onQuickCopy();
            }}
            title="Copy to Game Project"
            className="opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-indigo-600 hover:text-white text-slate-400 transition-all cursor-pointer shrink-0"
          >
            <Copy className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Expanded child content assets in list view */}
        {isStack && isExpanded && (
          <div className="pl-6 ml-4 border-l-2 border-indigo-500/30 space-y-1 my-1">
            {stackFrames.length === 0 ? (
              <div className="text-xs text-slate-500 p-2">Loading content assets...</div>
            ) : (
              stackFrames.map((frame, index) => (
                <div
                  key={frame.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (onSelectAsset) {
                      onSelectAsset(frame);
                    }
                  }}
                  className="flex items-center gap-3 px-3 py-1.5 rounded-md bg-[#141423] border border-[#222238] hover:bg-[#1c1c30] hover:border-indigo-500/50 cursor-pointer group transition-all"
                >
                  <span className="text-[10px] font-mono font-semibold text-indigo-400 w-6">
                    #{index + 1}
                  </span>
                  <div className="w-7 h-7 rounded bg-[#10101a] border border-[#26263a] overflow-hidden shrink-0 flex items-center justify-center checkerboard-bg">
                    <img
                      src={frame.thumbnailUrl || frame.fileUrl}
                      alt={frame.name}
                      className="w-full h-full object-contain pixelated"
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="text-xs font-mono text-slate-200 truncate block">
                      {frame.name}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 shrink-0">
                    <span>{formatBytes(frame.size)}</span>
                    {frame.metadata.width && frame.metadata.height && (
                      <span>
                        {frame.metadata.width}×{frame.metadata.height}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    );
  }

  // Grid View Rendering
  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`group relative flex flex-col rounded-xl border overflow-hidden transition-all duration-150 cursor-pointer ${
        cardWidthClass
      } ${
        isSelected
          ? 'bg-[#212136] border-indigo-500 shadow-xl ring-2 ring-indigo-500/40'
          : 'bg-[#181828] border-[#26263a] hover:border-[#383856] hover:bg-[#1d1d30] hover:shadow-lg'
      }`}
    >
      {/* Thumbnail Area */}
      <div
        className={`relative w-full ${thumbnailHeight} flex items-center justify-center overflow-hidden border-b border-[#232338] ${
          isImage ? 'checkerboard-bg' : 'bg-[#12121e]'
        }`}
      >
        {currentDisplayAsset.thumbnailUrl && !thumbnailError ? (
          <img
            src={currentDisplayAsset.thumbnailUrl}
            alt={title}
            className="max-w-full max-h-full object-contain pixelated p-2 transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
            onError={() => setThumbnailError(true)}
          />
        ) : isAudio ? (
          <div className="flex flex-col items-center justify-center gap-1.5 p-3">
            <AudioAssetIcon
              duration={currentDisplayAsset.metadata.duration}
              bpm={currentDisplayAsset.metadata.bpm}
              className="w-12 h-12"
            />
            <span className="text-[10px] font-mono text-slate-400">
              {currentDisplayAsset.metadata.duration !== undefined && currentDisplayAsset.metadata.duration <= 5
                ? 'Sound FX'
                : 'Music Track'}
            </span>
          </div>
        ) : (
          <img
            src={currentDisplayAsset.fileUrl}
            alt={title}
            className="max-w-full max-h-full object-contain pixelated p-2 transition-transform duration-200 group-hover:scale-105"
            loading="lazy"
          />
        )}

        {/* Stack Badge & View Action */}
        {isStack && (
          <div className="absolute top-2 left-2 flex items-center gap-1 z-10">
            <div className="px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-xs border border-white/10 text-[10px] font-mono font-semibold text-cyan-300 flex items-center gap-1 shadow-sm">
              <Layers className="w-3 h-3 text-indigo-400" />
              {stack?.type === 'animation'
                ? `${stack?.itemCount} frames`
                : `${stack?.itemCount} vars`}
            </div>
            {onViewStackAssets && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onViewStackAssets();
                }}
                title="View content assets separately"
                className="opacity-0 group-hover:opacity-100 px-1.5 py-0.5 rounded-md bg-indigo-900/90 hover:bg-indigo-600 border border-indigo-500/40 text-[10px] font-medium text-indigo-200 hover:text-white shadow-sm transition-all cursor-pointer flex items-center gap-1"
              >
                <Eye className="w-3 h-3" />
                <span>Frames</span>
              </button>
            )}
          </div>
        )}

        {/* Archive Badge */}
        {asset.isArchiveEntry && (
          <div className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-amber-950/80 border border-amber-500/30 text-[9px] font-mono font-bold text-amber-300">
            ZIP
          </div>
        )}

        {/* Audio Quick Preview Play Button */}
        {isAudio && (
          <button
            onClick={toggleCardAudio}
            title={isPlayingAudio ? 'Pause preview' : 'Play audio preview'}
            className="absolute bottom-2 left-2 p-1.5 rounded-full bg-black/80 hover:bg-indigo-600 border border-white/20 text-white transition-all shadow-md cursor-pointer"
          >
            {isPlayingAudio ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 ml-0.5" />}
          </button>
        )}

        {/* Hover Quick Copy Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (onQuickCopy) onQuickCopy();
          }}
          title="Quick Copy to Game Project"
          className="absolute bottom-2 right-2 p-1.5 rounded-md bg-black/80 hover:bg-indigo-600 border border-white/20 text-slate-300 hover:text-white opacity-0 group-hover:opacity-100 transition-all shadow-md cursor-pointer"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Card Info Details */}
      <div className="p-3 flex flex-col gap-1.5 min-w-0">
        <div className="flex items-center justify-between gap-1.5">
          <span className="text-xs font-semibold text-slate-100 truncate" title={title}>
            {title}
          </span>
          <span className="px-1.5 py-0.5 rounded bg-[#25253a] border border-[#32324e] text-[10px] font-mono font-semibold text-indigo-300 uppercase shrink-0">
            {asset.extension.replace('.', '')}
          </span>
        </div>

        <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
          <span>{formatBytes(asset.size)}</span>
          {isImage && asset.metadata.width && asset.metadata.height && (
            <span className="text-slate-400">
              {asset.metadata.width}×{asset.metadata.height}
            </span>
          )}
          {isAudio && asset.metadata.duration && (
            <span className="text-slate-400">
              {asset.metadata.duration.toFixed(1)}s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
