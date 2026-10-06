import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Square, Repeat, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { Asset } from '../types';

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
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(asset.metadata.duration || 0);
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [loading, setLoading] = useState(true);
  const [waveformReady, setWaveformReady] = useState(false);

  // Initialize playback and WaveSurfer
  useEffect(() => {
    setLoading(true);
    setWaveformReady(false);
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(asset.metadata.duration || 0);

    // Destroy existing WaveSurfer instance
    if (waveSurferRef.current) {
      waveSurferRef.current.destroy();
      waveSurferRef.current = null;
    }

    const fullUrl = new URL(asset.fileUrl, window.location.origin).href;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      audio.src = fullUrl;
      audio.volume = isMuted ? 0 : volume;
      audio.muted = isMuted;
      audio.loop = isLooping;
    }

    if (!containerRef.current) return;

    try {
      const ws = WaveSurfer.create({
        container: containerRef.current,
        media: audio || undefined,
        waveColor: '#4f46e5',
        progressColor: '#38bdf8',
        cursorColor: '#f43f5e',
        cursorWidth: 2,
        height: 96,
        barWidth: 3,
        barGap: 3,
        barRadius: 2,
        url: fullUrl,
      });

      ws.on('ready', () => {
        setLoading(false);
        setWaveformReady(true);
        const d = ws.getDuration();
        if (d && !isNaN(d) && d > 0) {
          setDuration(d);
        }
        if (audio && audio.currentTime > 0) {
          try {
            ws.setTime(audio.currentTime);
          } catch {}
        }
      });

      ws.on('seeking', (time) => {
        setCurrentTime(time);
        if (audio && Math.abs(audio.currentTime - time) > 0.2) {
          audio.currentTime = time;
        }
      });

      ws.on('error', (err) => {
        console.warn('WaveSurfer waveform decoding failed:', err);
        setLoading(false);
      });

      waveSurferRef.current = ws;
    } catch (err) {
      console.warn('Failed to initialize WaveSurfer:', err);
      setLoading(false);
    }

    return () => {
      if (waveSurferRef.current) {
        waveSurferRef.current.destroy();
        waveSurferRef.current = null;
      }
      if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
    };
  }, [asset.id, asset.fileUrl, asset.metadata.duration]);

  // Volume & Mute sync
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.volume = isMuted ? 0 : volume;
      audioRef.current.muted = isMuted;
    }
    if (waveSurferRef.current) {
      waveSurferRef.current.setVolume(isMuted ? 0 : volume);
    }
  }, [volume, isMuted]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (isPlaying) {
      audio.pause();
    } else {
      audio.play().catch((err) => {
        console.warn('Playback error:', err);
      });
    }
  };

  const handleStop = () => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    if (waveSurferRef.current && waveformReady) {
      try {
        waveSurferRef.current.setTime(0);
      } catch {}
    }
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const toggleLoop = () => {
    const nextLoop = !isLooping;
    setIsLooping(nextLoop);
    if (audioRef.current) {
      audioRef.current.loop = nextLoop;
    }
  };

  const handleScrub = (newTime: number) => {
    const boundedTime = Math.max(0, Math.min(newTime, duration || newTime));
    setCurrentTime(boundedTime);
    if (audioRef.current) {
      audioRef.current.currentTime = boundedTime;
    }
    if (waveSurferRef.current && waveformReady) {
      try {
        waveSurferRef.current.setTime(boundedTime);
      } catch {}
    }
  };

  const handleVolumeChange = (newVolume: number) => {
    setIsMuted(false);
    setVolume(newVolume);
  };

  const toggleMute = () => {
    setIsMuted(!isMuted);
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 10);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms}`;
  };

  return (
    <div className="flex flex-col gap-3 w-full">
      {/* Hidden audio element for instant streaming playback */}
      <audio
        ref={audioRef}
        preload="auto"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onTimeUpdate={() => {
          if (audioRef.current) {
            setCurrentTime(audioRef.current.currentTime);
          }
        }}
        onDurationChange={() => {
          if (audioRef.current?.duration && !isNaN(audioRef.current.duration)) {
            setDuration(audioRef.current.duration);
          }
        }}
        onLoadedMetadata={() => {
          if (audioRef.current?.duration && !isNaN(audioRef.current.duration)) {
            setDuration(audioRef.current.duration);
          }
        }}
        onEnded={() => {
          if (isLooping) {
            if (audioRef.current) {
              audioRef.current.currentTime = 0;
              audioRef.current.play().catch(() => {});
            }
          } else {
            setIsPlaying(false);
            setCurrentTime(0);
          }
        }}
      />

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

      {/* Waveform Container (Animation Rectangle preserved from previous commit) */}
      <div className="relative bg-[#11111d] border border-[#2b2b44] rounded-lg p-3 min-h-[110px] flex flex-col justify-center">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#11111d]/80 rounded-lg gap-2 text-xs text-indigo-400 z-10">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Decoding audio waveform...</span>
          </div>
        )}
        <div ref={containerRef} className="w-full cursor-pointer" />
      </div>

      {/* Scrubber under the animation rectangle */}
      <div className="w-full flex flex-col gap-1 px-1">
        <input
          type="range"
          min="0"
          max={duration > 0 ? duration : 100}
          step="0.05"
          value={currentTime}
          onChange={(e) => handleScrub(Number(e.target.value))}
          className="w-full accent-indigo-500 h-1.5 bg-[#25253e] hover:bg-[#313150] rounded-lg appearance-none cursor-pointer transition-colors"
          title="Scrub audio position"
          aria-label="Audio position scrubber"
        />
        <div className="flex justify-between text-[10px] font-mono text-slate-400 select-none">
          <span className="text-cyan-400 font-semibold">{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      {/* Time & Playback Controls */}
      <div className="flex items-center justify-between bg-[#161625] border border-[#252538] rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={togglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
            className="p-2 rounded bg-indigo-600 hover:bg-indigo-500 text-white transition-colors cursor-pointer"
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
            onClick={toggleLoop}
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
          <span className="text-cyan-400 font-semibold">{formatTime(currentTime)}</span>
          <span className="text-slate-500"> / </span>
          <span>{formatTime(duration)}</span>
        </div>

        {/* Volume */}
        <div className="flex items-center gap-2">
          <button
            onClick={toggleMute}
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
            onChange={(e) => handleVolumeChange(Number(e.target.value))}
            className="w-16 accent-indigo-500 h-1 bg-[#25253e] rounded appearance-none cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
}
