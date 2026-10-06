import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Square, Repeat, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { Asset } from '../types';

import { getBpmColor } from './AudioIcons';

interface AudioWaveformPlayerProps {
  asset: Asset;
  variants?: Asset[];
  onSelectVariant?: (variant: Asset) => void;
}

export function AudioWaveformPlayer({
  asset,
  variants = [],
  onSelectVariant,
}: AudioWaveformPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const waveSurferRef = useRef<WaveSurfer | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.metadata.duration || 0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [loading, setLoading] = useState(true);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!containerRef.current) return;

    setLoading(true);
    setIsPlaying(false);
    setCurrentTime(0);

    // Destroy existing instance
    if (waveSurferRef.current) {
      waveSurferRef.current.destroy();
      waveSurferRef.current = null;
    }

    const isSound = asset.metadata.duration !== undefined && asset.metadata.duration <= 5;
    const waveColor = isSound ? '#06b6d4' : getBpmColor(asset.metadata.bpm);
    const progressColor = isSound ? '#38bdf8' : (asset.metadata.bpm ? '#f87171' : '#38bdf8');

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor,
      progressColor,
      cursorColor: '#f43f5e',
      cursorWidth: 2,
      height: 96,
      barWidth: 3,
      barGap: 3,
      barRadius: 2,
      url: asset.fileUrl,
    });

    ws.on('ready', () => {
      setLoading(false);
      setDuration(ws.getDuration());
      ws.setVolume(isMuted ? 0 : volume);
    });

    ws.on('audioprocess', (time) => {
      setCurrentTime(time);
    });

    ws.on('seeking', (time) => {
      setCurrentTime(time);
    });

    ws.on('finish', () => {
      if (isLooping) {
        ws.play();
      } else {
        setIsPlaying(false);
        setCurrentTime(0);
      }
    });

    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));

    waveSurferRef.current = ws;

    return () => {
      ws.destroy();
    };
  }, [asset.id, asset.fileUrl]);

  // Volume & Mute sync
  useEffect(() => {
    if (waveSurferRef.current) {
      waveSurferRef.current.setVolume(isMuted ? 0 : volume);
    }
  }, [volume, isMuted]);

  const togglePlay = () => {
    if (waveSurferRef.current) {
      waveSurferRef.current.playPause();
    }
  };

  const handleStop = () => {
    if (waveSurferRef.current) {
      waveSurferRef.current.stop();
      setIsPlaying(false);
      setCurrentTime(0);
    }
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Variations Switcher (if variants present) */}
      {variants.length > 1 && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Audio Variations ({variants.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {variants.map((v, idx) => {
              const isSelected = v.id === asset.id;
              return (
                <button
                  key={v.id}
                  onClick={() => onSelectVariant && onSelectVariant(v)}
                  className={`px-2.5 py-1 text-xs font-mono rounded-md border transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-indigo-600 border-indigo-400 text-white font-semibold shadow-xs'
                      : 'bg-[#181829] border-[#2d2d46] text-slate-300 hover:border-slate-500 hover:text-white'
                  }`}
                >
                  v{idx + 1}: {v.name}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Waveform Container */}
      <div className="relative bg-[#11111d] border border-[#2b2b44] rounded-lg p-3 min-h-[110px] flex flex-col justify-center">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#11111d]/80 rounded-lg gap-2 text-xs text-indigo-400 z-10">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Decoding audio waveform...</span>
          </div>
        )}
        <div ref={containerRef} className="w-full cursor-pointer" />
      </div>

      {/* Time & Playback Controls */}
      <div className="flex items-center justify-between bg-[#161625] border border-[#252538] rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={togglePlay}
            disabled={loading}
            title={isPlaying ? 'Pause' : 'Play'}
            className="p-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors disabled:opacity-50 cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            onClick={handleStop}
            title="Stop"
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" />
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

        {/* Time display */}
        <div className="text-xs font-mono text-slate-300">
          <span className="text-cyan-400">{formatTime(currentTime)}</span>
          <span className="text-slate-500"> / </span>
          <span>{formatTime(duration)}</span>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsMuted(!isMuted)}
            className="text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            {isMuted || volume === 0 ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={isMuted ? 0 : volume}
            onChange={(e) => {
              setIsMuted(false);
              setVolume(Number(e.target.value));
            }}
            className="w-16 accent-indigo-500 h-1 bg-[#25253e] rounded appearance-none cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
}
