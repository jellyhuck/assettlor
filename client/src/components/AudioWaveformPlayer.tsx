import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import { Play, Pause, Square, Repeat, Volume2, VolumeX, Loader2 } from 'lucide-react';
import { Asset } from '../types';

interface AudioWaveformPlayerProps {
  asset: Asset;
  variants?: Asset[];
  onSelectVariant?: (variant: Asset) => void;
}

type WaveformStatus = 'loading' | 'ready' | 'unavailable';
type MediaStatus = 'loading' | 'playable' | 'unavailable';

interface PlaybackSession {
  audio: HTMLAudioElement;
  waveform: WaveSurfer | null;
  active: boolean;
  playRequest: number;
}

function finiteTime(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function formatTime(value: number): string {
  const seconds = finiteTime(value);
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  const tenths = Math.floor((seconds % 1) * 10);
  return `${mins}:${secs.toString().padStart(2, '0')}.${tenths}`;
}

/** A source revision or retry gets a new state and media owner. */
export function AudioWaveformPlayer({
  asset,
  variants = [],
  onSelectVariant,
}: AudioWaveformPlayerProps) {
  const [retry, setRetry] = useState(0);
  const sourceKey = [asset.id, asset.fileUrl, asset.hash, asset.mtime,
    asset.updatedAt, asset.metadata.duration, retry].join('\0');

  return (
    <div className="flex flex-col gap-3 w-full">
      {variants.length > 1 && (
        <div className="space-y-1.5">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
            Audio Variations ({variants.length})
          </span>
          <div className="flex flex-wrap gap-1.5">
            {variants.map((variant, index) => (
              <button
                key={variant.id}
                type="button"
                onClick={() => onSelectVariant?.(variant)}
                aria-pressed={variant.id === asset.id}
                className={variant.id === asset.id
                  ? 'px-2.5 py-1 text-xs font-mono rounded-md border bg-indigo-600 border-indigo-400 text-white font-semibold'
                  : 'px-2.5 py-1 text-xs font-mono rounded-md border bg-[#181829] border-[#2d2d46] text-slate-300 hover:text-white'}
              >
                v{index + 1}: {variant.name}
              </button>
            ))}
          </div>
        </div>
      )}
      <AudioWaveformSession key={sourceKey} asset={asset} onRetry={() => setRetry((count) => count + 1)} />
    </div>
  );
}

function AudioWaveformSession({ asset, onRetry }: { asset: Asset; onRetry: () => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const sessionRef = useRef<PlaybackSession | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(finiteTime(asset.metadata.duration ?? 0));
  const [volume, setVolume] = useState(0.8);
  const [isMuted, setIsMuted] = useState(false);
  const [waveformStatus, setWaveformStatus] = useState<WaveformStatus>('loading');
  const [mediaStatus, setMediaStatus] = useState<MediaStatus>('loading');
  const [playbackError, setPlaybackError] = useState<string | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    const container = containerRef.current;
    if (!audio || !container) return;

    const session: PlaybackSession = { audio, waveform: null, active: true, playRequest: 0 };
    sessionRef.current = session;
    const unsubscribers: Array<() => void> = [];
    const isCurrent = () => session.active && sessionRef.current === session;

    try {
      const waveform = WaveSurfer.create({
        container,
        media: audio,
        waveColor: '#4f46e5',
        progressColor: '#38bdf8',
        cursorColor: '#f43f5e',
        cursorWidth: 2,
        height: 96,
        barWidth: 3,
        barGap: 3,
        barRadius: 2,
        url: new URL(asset.fileUrl, window.location.origin).href,
      });
      session.waveform = waveform;
      unsubscribers.push(waveform.on('ready', () => {
        if (!isCurrent()) return;
        setWaveformStatus('ready');
        const measured = waveform.getDuration();
        if (Number.isFinite(measured) && measured > 0) setDuration(measured);
      }));
      unsubscribers.push(waveform.on('seeking', (time) => {
        if (!isCurrent() || !Number.isFinite(time) || time < 0) return;
        setCurrentTime(time);
        if (Math.abs(audio.currentTime - time) > 0.2) audio.currentTime = time;
      }));
      unsubscribers.push(waveform.on('error', (error) => {
        if (!isCurrent()) return;
        console.warn('Waveform decoding failed:', error);
        setWaveformStatus('unavailable');
      }));
    } catch (error) {
      console.warn('Waveform initialization failed:', error);
      queueMicrotask(() => {
        if (isCurrent()) setWaveformStatus('unavailable');
      });
    }

    return () => {
      session.active = false;
      session.playRequest += 1;
      if (sessionRef.current === session) sessionRef.current = null;
      unsubscribers.forEach((unsubscribe) => unsubscribe());
      session.waveform?.destroy();
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
    };
  }, [asset.fileUrl]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = volume;
    audio.muted = isMuted;
    audio.loop = isLooping;
  }, [volume, isMuted, isLooping]);

  const isCurrentAudio = (audio: HTMLAudioElement) =>
    sessionRef.current?.active === true && sessionRef.current.audio === audio;

  const togglePlay = () => {
    const session = sessionRef.current;
    if (!session?.active || mediaStatus === 'unavailable') return;
    const { audio } = session;
    if (isPlaying) {
      session.playRequest += 1;
      audio.pause();
      setIsPlaying(false);
      return;
    }
    setPlaybackError(null);
    const request = ++session.playRequest;
    void audio.play().then(() => {
      if (session.active && sessionRef.current === session && request === session.playRequest) {
        setIsPlaying(!audio.paused);
      }
    }).catch((error: unknown) => {
      if (!session.active || sessionRef.current !== session || request !== session.playRequest) return;
      setIsPlaying(false);
      setPlaybackError(error instanceof Error && error.message
        ? `Playback failed: ${error.message}` : 'Playback failed. Try again.');
    });
  };

  const handleStop = () => {
    const session = sessionRef.current;
    if (!session?.active) return;
    session.playRequest += 1;
    session.audio.pause();
    session.audio.currentTime = 0;
    if (waveformStatus === 'ready') session.waveform?.setTime(0);
    setIsPlaying(false);
    setCurrentTime(0);
  };

  const handleScrub = (requestedTime: number) => {
    if (!Number.isFinite(requestedTime)) return;
    const time = Math.max(0, Math.min(requestedTime, duration > 0 ? duration : requestedTime));
    const session = sessionRef.current;
    if (!session?.active || mediaStatus === 'unavailable') return;
    session.audio.currentTime = time;
    if (waveformStatus === 'ready') session.waveform?.setTime(time);
    setCurrentTime(time);
  };

  const waveformUnavailable = waveformStatus === 'unavailable';
  const fileUnavailable = mediaStatus === 'unavailable';
  const scrubMaximum = duration > 0 ? duration : Math.max(100, currentTime);

  return (
    <div className="flex flex-col gap-3 w-full">
      <audio
        ref={audioRef}
        src={asset.fileUrl}
        preload="auto"
        controls={waveformUnavailable && !fileUnavailable}
        className={waveformUnavailable && !fileUnavailable ? 'w-full order-2' : 'hidden'}
        onCanPlay={(event) => {
          if (isCurrentAudio(event.currentTarget)) setMediaStatus('playable');
        }}
        onError={(event) => {
          const session = sessionRef.current;
          if (!session?.active || session.audio !== event.currentTarget) return;
          session.playRequest += 1;
          setMediaStatus('unavailable');
          setWaveformStatus('unavailable');
          setIsPlaying(false);
        }}
        onPlay={(event) => {
          if (isCurrentAudio(event.currentTarget) && !event.currentTarget.paused) {
            setPlaybackError(null);
            setIsPlaying(true);
          }
        }}
        onPause={(event) => {
          if (isCurrentAudio(event.currentTarget)) setIsPlaying(false);
        }}
        onTimeUpdate={(event) => {
          if (isCurrentAudio(event.currentTarget)) setCurrentTime(finiteTime(event.currentTarget.currentTime));
        }}
        onDurationChange={(event) => {
          if (isCurrentAudio(event.currentTarget)) {
            const measured = event.currentTarget.duration;
            if (Number.isFinite(measured) && measured > 0) setDuration(measured);
          }
        }}
        onEnded={(event) => {
          if (!isCurrentAudio(event.currentTarget) || event.currentTarget.loop) return;
          setIsPlaying(false);
          setCurrentTime(finiteTime(event.currentTarget.duration));
        }}
      />

      <div className="relative bg-[#11111d] border border-[#2b2b44] rounded-lg p-3 min-h-[110px] flex flex-col justify-center">
        {waveformStatus === 'loading' && !fileUnavailable && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#11111d]/80 rounded-lg gap-2 text-xs text-indigo-400 z-10" role="status">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Decoding audio waveform...</span>
          </div>
        )}
        {waveformUnavailable && (
          <div className="text-xs text-slate-300" role="alert">
            {fileUnavailable
              ? 'Audio file unavailable. Check the source and retry.'
              : mediaStatus === 'playable'
                ? 'Waveform unavailable. Audio playback is available below.'
                : 'Waveform unavailable. Try the audio controls below.'}
          </div>
        )}
        <div ref={containerRef} className={waveformUnavailable ? 'hidden' : 'w-full cursor-pointer'} />
      </div>

      {playbackError && <p role="alert" className="text-xs text-rose-400">{playbackError}</p>}
      {(waveformUnavailable || playbackError) && (
        <button type="button" onClick={onRetry} className="self-start text-xs text-indigo-300 hover:text-indigo-100 underline">
          Retry audio
        </button>
      )}

      <div className="w-full flex flex-col gap-1 px-1">
        <input
          type="range"
          min="0"
          max={scrubMaximum}
          step="0.05"
          value={Math.min(currentTime, scrubMaximum)}
          onChange={(event) => handleScrub(Number(event.target.value))}
          disabled={fileUnavailable}
          className="w-full accent-indigo-500 h-1.5 bg-[#25253e] hover:bg-[#313150] rounded-lg appearance-none cursor-pointer transition-colors"
          title="Scrub audio position"
          aria-label="Audio position scrubber"
        />
        <div className="flex justify-between text-[10px] font-mono text-slate-400 select-none">
          <span className="text-cyan-400 font-semibold">{formatTime(currentTime)}</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>

      <div className="flex items-center justify-between bg-[#161625] border border-[#252538] rounded-lg px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={togglePlay}
            title={isPlaying ? 'Pause' : 'Play'}
            aria-label={isPlaying ? 'Pause audio' : 'Play audio'}
            disabled={fileUnavailable}
            className="p-2 rounded bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white transition-colors cursor-pointer"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={handleStop}
            title="Stop"
            aria-label="Stop audio"
            className="p-1.5 rounded hover:bg-[#25253e] text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          >
            <Square className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => setIsLooping((looping) => !looping)}
            title="Toggle Loop"
            aria-label="Loop audio"
            aria-pressed={isLooping}
            className={isLooping
              ? 'p-1.5 rounded text-indigo-400 bg-indigo-950/40 cursor-pointer'
              : 'p-1.5 rounded text-slate-500 hover:text-slate-300 cursor-pointer'}
          >
            <Repeat className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="text-xs font-mono text-slate-300">
          <span className="text-cyan-400 font-semibold">{formatTime(currentTime)}</span>
          <span className="text-slate-500"> / </span>
          <span>{formatTime(duration)}</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setIsMuted((muted) => !muted)}
            aria-label={isMuted ? 'Unmute audio' : 'Mute audio'}
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
            onChange={(event) => {
              setIsMuted(false);
              setVolume(Number(event.target.value));
            }}
            aria-label="Audio volume"
            className="w-16 accent-indigo-500 h-1 bg-[#25253e] rounded appearance-none cursor-pointer"
          />
        </div>
      </div>
    </div>
  );
}
