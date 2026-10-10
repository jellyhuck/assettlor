import { useCallback, useEffect, useRef, useState } from 'react';
import { type Asset, getImageDisplayUrl } from '../types';
import { Play, Pause, SkipBack, SkipForward, Repeat, RotateCcw, Eye } from 'lucide-react';

interface FlipbookPlayerProps {
  frames: Asset[];
  pixelated?: boolean;
  checkerboard?: boolean;
  initialFps?: number;
  initialFrameIndex?: number;
  selectedFrameIndex?: number;
  onSelectFrame?: (index: number, asset: Asset) => void;
  onFrameChange?: (index: number, asset: Asset) => void;
  onViewFrameSeparately?: (asset: Asset, index: number) => void;
}

function clampFrameIndex(index: number, frameCount: number): number {
  if (frameCount === 0 || !Number.isFinite(index)) return 0;
  return Math.min(Math.max(Math.trunc(index), 0), frameCount - 1);
}

function clampFps(value: number): number {
  if (!Number.isFinite(value)) return 12;
  return Math.min(Math.max(Math.round(value), 1), 60);
}

export function FlipbookPlayer(props: FlipbookPlayerProps) {
  // A new set of frame identities starts a new playback session. Changes to
  // selectedFrameIndex only change the metadata selection in the strip.
  const frameSetKey = JSON.stringify(props.frames.map((frame) => frame.id));
  return <FlipbookSession key={frameSetKey} {...props} />;
}

function FlipbookSession({
  frames,
  pixelated = true,
  checkerboard = true,
  initialFps = 12,
  initialFrameIndex = 0,
  selectedFrameIndex = 0,
  onSelectFrame,
  onFrameChange,
  onViewFrameSeparately,
}: FlipbookPlayerProps) {
  const totalFrames = frames.length;
  const [currentFrameIndex, setCurrentFrameIndex] = useState(() => clampFrameIndex(initialFrameIndex, totalFrames));
  const currentFrameIndexRef = useRef(currentFrameIndex);
  const [isPlaying, setIsPlaying] = useState(totalFrames > 1);
  const [fpsOverride, setFpsOverride] = useState<number | null>(null);
  const fps = fpsOverride ?? clampFps(initialFps);
  const [isLooping, setIsLooping] = useState(true);

  const currentAsset = frames[currentFrameIndex];

  const updateFrameIndex = useCallback((index: number) => {
    if (frames.length === 0) return;
    const next = clampFrameIndex(index, frames.length);
    currentFrameIndexRef.current = next;
    setCurrentFrameIndex(next);
    onFrameChange?.(next, frames[next]);
  }, [frames, onFrameChange]);

  const handleFrameClick = (idx: number) => {
    if (frames[idx] && onSelectFrame) {
      onSelectFrame(idx, frames[idx]);
    }
    // If playback is paused, also sync the player canvas to the clicked frame
    if (!isPlaying) {
      updateFrameIndex(idx);
    }
  };

  useEffect(() => {
    if (!isPlaying || totalFrames <= 1) return;

    const intervalMs = 1000 / fps;
    const timer = setInterval(() => {
      const next = currentFrameIndexRef.current + 1;
      if (next >= totalFrames) {
        if (isLooping) updateFrameIndex(0);
        else setIsPlaying(false);
        return;
      }
      updateFrameIndex(next);
      if (!isLooping && next === totalFrames - 1) setIsPlaying(false);
    }, intervalMs);

    return () => clearInterval(timer);
  }, [isPlaying, fps, totalFrames, isLooping, updateFrameIndex]);

  const handleStepBack = () => {
    setIsPlaying(false);
    if (totalFrames <= 1) return;
    const nextIdx = currentFrameIndex > 0 ? currentFrameIndex - 1 : totalFrames - 1;
    updateFrameIndex(nextIdx);
  };

  const handleStepForward = () => {
    setIsPlaying(false);
    if (totalFrames <= 1) return;
    const nextIdx = currentFrameIndex + 1 < totalFrames ? currentFrameIndex + 1 : 0;
    updateFrameIndex(nextIdx);
  };

  const handlePlayPause = () => {
    if (isPlaying) {
      setIsPlaying(false);
    } else if (totalFrames > 1) {
      // A completed non-looping animation replays from the first frame.
      if (!isLooping && currentFrameIndexRef.current === totalFrames - 1) {
        updateFrameIndex(0);
      }
      setIsPlaying(true);
    }
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
          src={getImageDisplayUrl(currentAsset)}
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
          max={Math.max(0, totalFrames - 1)}
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
            disabled={totalFrames <= 1}
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={handlePlayPause}
            title={isPlaying ? 'Pause' : 'Play'}
            disabled={totalFrames <= 1}
            className="p-1.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            onClick={handleStepForward}
            title="Next Frame"
            disabled={totalFrames <= 1}
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => {
              if (isLooping && currentFrameIndexRef.current === totalFrames - 1) setIsPlaying(false);
              setIsLooping(!isLooping);
            }}
            title="Toggle Loop"
            className={`p-1.5 rounded transition-colors cursor-pointer ${
              isLooping ? 'text-indigo-400 bg-indigo-950/40' : 'text-slate-500 hover:text-slate-300'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* FPS Control */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-slate-400 font-medium">Speed:</span>
          <input
            type="range"
            min="1"
            max="60"
            value={fps}
            onChange={(e) => setFpsOverride(clampFps(Number(e.target.value)))}
            className="w-16 accent-indigo-500 h-1 bg-[#25253e] rounded appearance-none cursor-pointer"
          />
          <span className="text-[11px] font-mono font-bold text-indigo-400 w-9 text-right">{fps} fps</span>
        </div>
      </div>

      {/* Frame Strip Thumbnails */}
      <div className="flex items-center gap-1.5 overflow-x-auto py-1 px-0.5">
        {frames.map((frame, index) => {
          const isSelected = selectedFrameIndex === index;
          const isCurrentPlayback = currentFrameIndex === index;

          let borderRingClass = 'border-[#2d2d44] hover:border-slate-500 bg-[#161625]';
          let badgeClass = 'bg-black/80 text-slate-400';
          let titleSuffix = '';

          if (isSelected && isCurrentPlayback) {
            borderRingClass = 'border-indigo-400 ring-2 ring-indigo-500 bg-[#252542] shadow-sm';
            badgeClass = 'bg-indigo-600 text-white font-bold';
            titleSuffix = ' (Selected & Playing)';
          } else if (isSelected) {
            borderRingClass = 'border-indigo-500 ring-2 ring-indigo-500/50 bg-[#202038] shadow-sm';
            badgeClass = 'bg-indigo-600 text-white font-bold';
            titleSuffix = ' (Selected)';
          } else if (isCurrentPlayback) {
            borderRingClass = 'border-slate-300 ring-2 ring-slate-400/50 bg-[#222232]';
            badgeClass = 'bg-slate-700 text-slate-200 font-semibold';
            titleSuffix = ' (Playing)';
          }

          return (
            <button
              key={frame.id}
              onClick={() => handleFrameClick(index)}
              onDoubleClick={() => {
                handleFrameClick(index);
                updateFrameIndex(index);
              }}
              className={`relative shrink-0 w-12 h-12 rounded-lg border overflow-hidden p-0.5 transition-all cursor-pointer ${borderRingClass}`}
              title={`Frame ${index + 1}: ${frame.name}${titleSuffix}`}
            >
              <img
                src={getImageDisplayUrl(frame, true)}
                alt={frame.name}
                className={`w-full h-full object-contain ${pixelated ? 'pixelated' : 'smooth-render'}`}
              />
              <span className={`absolute bottom-0 right-0 px-1 text-[9px] font-mono rounded-tl ${badgeClass}`}>
                {index + 1}
              </span>
            </button>
          );
        })}
      </div>

      {/* Inspect Frame Action */}
      {onViewFrameSeparately && (
        <button
          onClick={() => {
            const targetIndex =
              selectedFrameIndex !== undefined && selectedFrameIndex >= 0 && selectedFrameIndex < totalFrames
                ? selectedFrameIndex
                : currentFrameIndex;
            const targetAsset = frames[targetIndex] || currentAsset;
            onViewFrameSeparately(targetAsset, targetIndex);
          }}
          title="Inspect this frame separately"
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#202035] hover:bg-indigo-600 hover:text-white text-slate-300 border border-[#2d2d46] text-xs font-medium transition-colors cursor-pointer w-full"
        >
          <Eye className="w-3.5 h-3.5" />
          <span>Inspect</span>
        </button>
      )}
    </div>
  );
}
