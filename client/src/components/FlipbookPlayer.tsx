import React, { useState, useEffect, useRef } from 'react';
import { Asset } from '../types';
import { Play, Pause, SkipBack, SkipForward, Repeat, RotateCcw, Eye } from 'lucide-react';

interface FlipbookPlayerProps {
  frames: Asset[];
  pixelated?: boolean;
  checkerboard?: boolean;
  initialFps?: number;
  initialFrameIndex?: number;
  onFrameChange?: (index: number, asset: Asset) => void;
  onViewFrameSeparately?: (asset: Asset, index: number) => void;
}

export function FlipbookPlayer({
  frames,
  pixelated = true,
  checkerboard = true,
  initialFps = 12,
  initialFrameIndex = 0,
  onFrameChange,
  onViewFrameSeparately,
}: FlipbookPlayerProps) {
  const [currentFrameIndex, setCurrentFrameIndex] = useState(initialFrameIndex);
  const [isPlaying, setIsPlaying] = useState(true);
  const [fps, setFps] = useState(initialFps);
  const [isLooping, setIsLooping] = useState(true);

  // Safety check
  const totalFrames = frames.length;
  const currentAsset = frames[currentFrameIndex] || frames[0];

  useEffect(() => {
    if (initialFrameIndex >= 0 && initialFrameIndex < frames.length) {
      setCurrentFrameIndex(initialFrameIndex);
    } else {
      setCurrentFrameIndex(0);
    }
  }, [frames, initialFrameIndex]);

  const updateFrameIndex = (idx: number) => {
    setCurrentFrameIndex(idx);
    if (frames[idx] && onFrameChange) {
      onFrameChange(idx, frames[idx]);
    }
  };

  useEffect(() => {
    if (!isPlaying || totalFrames <= 1) return;

    const intervalMs = 1000 / fps;
    const timer = setInterval(() => {
      setCurrentFrameIndex((prev) => {
        const next = prev + 1 >= totalFrames ? (isLooping ? 0 : prev) : prev + 1;
        if (frames[next] && onFrameChange) {
          onFrameChange(next, frames[next]);
        }
        return next;
      });
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, fps, totalFrames, isLooping, frames, onFrameChange]);

  const handleStepBack = () => {
    setIsPlaying(false);
    const nextIdx = currentFrameIndex > 0 ? currentFrameIndex - 1 : totalFrames - 1;
    updateFrameIndex(nextIdx);
  };

  const handleStepForward = () => {
    setIsPlaying(false);
    const nextIdx = currentFrameIndex + 1 < totalFrames ? currentFrameIndex + 1 : 0;
    updateFrameIndex(nextIdx);
  };

  if (!currentAsset) {
    return <div className="text-center text-xs text-slate-500 py-6">No frames available</div>;
  }

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Canvas / Image Display */}
      <div
        className={`relative flex items-center justify-center rounded-lg overflow-hidden border border-[#2d2d48] min-h-[220px] max-h-[300px] ${
          checkerboard ? 'checkerboard-bg' : 'bg-[#12121e]'
        }`}
      >
        <img
          src={currentAsset.fileUrl || currentAsset.thumbnailUrl}
          alt={currentAsset.name}
          className={`max-w-full max-h-[260px] object-contain transition-none ${
            pixelated ? 'pixelated' : 'smooth-render'
          }`}
        />
        {/* Frame badge overlay */}
        <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/80 backdrop-blur-xs border border-white/10 text-[11px] font-mono font-medium text-cyan-300 flex items-center gap-2 shadow-sm">
          <span>Frame {currentFrameIndex + 1} / {totalFrames}</span>
          {onViewFrameSeparately && (
            <button
              onClick={() => onViewFrameSeparately(currentAsset, currentFrameIndex)}
              title="View this frame separately as an individual asset"
              className="text-[10px] text-indigo-300 hover:text-white underline cursor-pointer font-sans"
            >
              View Asset
            </button>
          )}
        </div>
      </div>

      {/* Frame Scrubber */}
      <div className="flex items-center gap-2 px-1">
        <input
          type="range"
          min="0"
          max={totalFrames - 1}
          value={currentFrameIndex}
          onChange={(e) => {
            setIsPlaying(false);
            updateFrameIndex(Number(e.target.value));
          }}
          className="flex-1 accent-indigo-500 h-1.5 bg-[#25253e] rounded-lg appearance-none cursor-pointer"
        />
        <span className="text-[11px] font-mono text-slate-400 w-12 text-right">
          {currentFrameIndex + 1} / {totalFrames}
        </span>
      </div>

      {/* Player Controls */}
      <div className="flex items-center justify-between bg-[#161625] border border-[#252538] rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => {
              updateFrameIndex(0);
              setIsPlaying(false);
            }}
            title="Reset to first frame"
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handleStepBack}
            title="Previous Frame"
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            title={isPlaying ? 'Pause' : 'Play'}
            className="p-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            onClick={handleStepForward}
            title="Next Frame"
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setIsLooping(!isLooping)}
            title="Toggle Loop"
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              isLooping ? 'text-indigo-400 bg-indigo-950/40' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* View Frame action & FPS Control */}
        <div className="flex items-center gap-3">
          {onViewFrameSeparately && (
            <button
              onClick={() => onViewFrameSeparately(currentAsset, currentFrameIndex)}
              title="Inspect this frame separately"
              className="hidden sm:flex items-center gap-1 px-2 py-1 rounded bg-[#202035] hover:bg-indigo-600 hover:text-white text-slate-300 border border-[#2d2d46] text-xs font-medium transition-colors cursor-pointer"
            >
              <Eye className="w-3 h-3" />
              <span>Inspect</span>
            </button>
          )}

          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-400 font-medium">Speed:</span>
            <input
              type="range"
              min="1"
              max="30"
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              className="w-16 accent-indigo-500 h-1 bg-[#25253e] rounded appearance-none cursor-pointer"
            />
            <span className="text-[11px] font-mono font-bold text-indigo-400 w-9 text-right">{fps} fps</span>
          </div>
        </div>
      </div>

      {/* Frame Strip Thumbnails */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5">
        {frames.map((frame, index) => (
          <button
            key={frame.id}
            onClick={() => {
              updateFrameIndex(index);
              setIsPlaying(false);
            }}
            className={`relative shrink-0 w-12 h-12 rounded border overflow-hidden p-0.5 transition-all cursor-pointer ${
              currentFrameIndex === index
                ? 'border-indigo-500 ring-2 ring-indigo-500/40 bg-[#25253e]'
                : 'border-[#2d2d44] hover:border-slate-500 bg-[#161625]'
            }`}
            title={`Frame ${index + 1}: ${frame.name}`}
          >
            <img
              src={frame.thumbnailUrl || frame.fileUrl}
              alt={frame.name}
              className={`w-full h-full object-contain ${pixelated ? 'pixelated' : 'smooth-render'}`}
            />
            <span className="absolute bottom-0 right-0 px-1 text-[9px] font-mono bg-black/80 text-slate-300 rounded-tl">
              {index + 1}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
