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
} from 'lucide-react';
import { useToast } from './Toast';

interface AssetCardProps {
  item: Asset | (AssetStack & { isStack: true });
  isSelected: boolean;
  onSelect: () => void;
  viewMode: ViewMode;
  cardZoom: CardZoom;
  onQuickCopy?: () => void;
}

export function AssetCard({
  item,
  isSelected,
  onSelect,
  viewMode,
  cardZoom,
  onQuickCopy,
}: AssetCardProps) {
  const { showToast } = useToast();
  const [isHovered, setIsHovered] = useState(false);
  const [hoverFrameIndex, setHoverFrameIndex] = useState(0);
  const [stackFrames, setStackFrames] = useState<Asset[]>([]);
  const [isPlayingAudio, setIsPlayingAudio] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const isStack = Boolean('isStack' in item && item.isStack);
  const stack = isStack ? (item as AssetStack & { isStack: true }) : null;
  const asset = !isStack ? (item as Asset) : stack?.representativeAsset;

  // Reset frame cache if card identity changes
  useEffect(() => {
    setStackFrames([]);
    setHoverFrameIndex(0);
  }, [item.id]);

  // Format file size
  const formatBytes = (bytes?: number) => {
    if (!bytes) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(0)} ${sizes[i]}`;
  };

  // Hover flipbook cycle for animation stacks
  useEffect(() => {
    if (isStack && stack?.type === 'animation' && isHovered) {
      if (stackFrames.length === 0) {
        // Fetch frames
        fetch(`/api/stacks/${stack.id}/assets`)
          .then((res) => res.json())
          .then((assets: Asset[]) => setStackFrames(assets))
          .catch(() => {});
      }

      if (stackFrames.length > 1) {
        const timer = setInterval(() => {
          setHoverFrameIndex((prev) => (prev + 1) % stackFrames.length);
        }, 120);
        return () => clearInterval(timer);
      }
    } else {
      setHoverFrameIndex(0);
    }
  }, [isHovered, isStack, stack?.id, stackFrames.length]);

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
      <div
        onClick={onSelect}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg border transition-all cursor-pointer group ${
          isSelected
            ? 'bg-[#22223a] border-indigo-500 shadow-md ring-1 ring-indigo-500/40'
            : 'bg-[#181829] border-[#26263a] hover:bg-[#1f1f33] hover:border-[#363654]'
        }`}
      >
        {/* Small thumbnail */}
        <div className="w-10 h-10 rounded bg-[#12121d] border border-[#2b2b40] overflow-hidden shrink-0 flex items-center justify-center checkerboard-bg">
          <img
            src={currentDisplayAsset.thumbnailUrl || currentDisplayAsset.fileUrl}
            alt={title}
            className="w-full h-full object-contain pixelated"
            loading="lazy"
          />
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
        <img
          src={currentDisplayAsset.thumbnailUrl || currentDisplayAsset.fileUrl}
          alt={title}
          className="max-w-full max-h-full object-contain pixelated p-2 transition-transform duration-200 group-hover:scale-105"
          loading="lazy"
        />

        {/* Stack Badge */}
        {isStack && (
          <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/80 backdrop-blur-xs border border-white/10 text-[10px] font-mono font-semibold text-cyan-300 flex items-center gap-1 shadow-sm">
            <Layers className="w-3 h-3 text-indigo-400" />
            {stack?.type === 'animation'
              ? `${stack?.itemCount} frames`
              : `${stack?.itemCount} variations`}
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
