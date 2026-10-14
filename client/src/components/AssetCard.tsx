import { useEffect, useRef, useState } from 'react';
import type { Asset, AssetStack, CardZoom, ViewMode } from '../types';
import {
  Layers, Copy, Play, Pause, Image as ImageIcon, ChevronDown, ChevronRight, Eye,
} from 'lucide-react';
import { errorMessage, expectArray, isAbortError, requestJson } from '../lib/requestLifecycle';
import { useToast } from './Toast';
import { AudioAssetIcon } from './AudioIcons';

type StackItem = AssetStack & { isStack: true };
type CardItem = Asset | StackItem;
type CardAudioResource = {
  audio: HTMLAudioElement;
  onEnded: () => void;
  onError: () => void;
};

interface AssetCardProps {
  item: CardItem;
  isSelected: boolean;
  onSelect: () => void;
  viewMode: ViewMode;
  cardZoom: CardZoom;
  onQuickCopy?: () => void;
  onSelectAsset?: (asset: Asset) => void;
  onViewStackAssets?: () => void;
}

const objectRevisions = new WeakMap<object, number>();
let nextObjectRevision = 0;

function objectRevision(item: object): number {
  let revision = objectRevisions.get(item);
  if (revision === undefined) {
    revision = ++nextObjectRevision;
    objectRevisions.set(item, revision);
  }
  return revision;
}

function assetRevision(asset?: Asset): string {
  if (!asset) return '';
  return [
    asset.id, asset.updatedAt, asset.mtime, asset.hash, asset.fileUrl, asset.thumbnailUrl,
    asset.metadata.thumbnailFingerprint,
  ].join('|');
}

/** Catalog refreshes replace item objects even when a stack keeps its ID. */
function cardRevision(item: CardItem): string {
  if ('isStack' in item && item.isStack) {
    return [
      objectRevision(item), item.id, item.type, item.itemCount,
      item.representativeAssetId, assetRevision(item.representativeAsset),
      item.assets?.map(assetRevision).join(','), JSON.stringify(item.metadata),
    ].join('|');
  }
  return `${objectRevision(item)}|${assetRevision(item as Asset)}`;
}

function isAsset(value: unknown): value is Asset {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<Asset>;
  return typeof candidate.id === 'string' && typeof candidate.name === 'string'
    && typeof candidate.path === 'string' && typeof candidate.extension === 'string'
    && typeof candidate.size === 'number' && Number.isFinite(candidate.size)
    && typeof candidate.fileUrl === 'string' && typeof candidate.thumbnailUrl === 'string'
    && (candidate.category === 'image' || candidate.category === 'audio'
      || candidate.category === 'archive' || candidate.category === 'other')
    && candidate.metadata !== null && typeof candidate.metadata === 'object'
    && !Array.isArray(candidate.metadata);
}

function formatBytes(bytes?: number): string {
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(0)} ${units[index]}`;
}

function releaseAudio({ audio, onEnded, onError }: CardAudioResource, resetTime: boolean) {
  audio.removeEventListener('ended', onEnded);
  audio.removeEventListener('error', onError);
  audio.pause();
  if (resetTime) audio.currentTime = 0;
}

function CardImage({ asset, title, className }: { asset: Asset; title: string; className: string }) {
  const isTga = asset.extension.toLowerCase() === '.tga';
  const sources = [...new Set((isTga
    ? [asset.thumbnailUrl]
    : [asset.thumbnailUrl, asset.fileUrl]).filter(Boolean))];
  const sourceKey = `${assetRevision(asset)}|${sources.join('|')}`;
  const [failedStages, setFailedStages] = useState<Record<string, number>>({});
  const stage = failedStages[sourceKey] ?? 0;
  const src = sources[stage];

  if (!src) {
    return <div role="img" aria-label={`Preview unavailable for ${title}`}
      className="flex h-full w-full items-center justify-center gap-1 text-slate-500">
      <ImageIcon aria-hidden="true" className="h-4 w-4 shrink-0" />
      <span className="text-[10px]">Preview unavailable</span>
    </div>;
  }

  return <img
    src={src}
    alt={title}
    className={className}
    loading="lazy"
    onError={() => setFailedStages((current) => ({
      ...current,
      [sourceKey]: Math.min((current[sourceKey] ?? 0) + 1, sources.length),
    }))}
  />;
}

export function AssetCard(props: AssetCardProps) {
  return <AssetCardContent key={cardRevision(props.item)} {...props} />;
}

function AssetCardContent({
  item, isSelected, onSelect, viewMode, cardZoom, onQuickCopy, onSelectAsset,
  onViewStackAssets,
}: AssetCardProps) {
  const { showToast } = useToast();
  const [isHovered, setIsHovered] = useState(false);
  const [hoverFrameIndex, setHoverFrameIndex] = useState(0);
  const [isExpanded, setIsExpanded] = useState(false);
  const [members, setMembers] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    assets: Asset[];
    error?: string;
  }>({ status: 'idle', assets: [] });
  const memberStatusRef = useRef<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const memberRequestRef = useRef<AbortController | null>(null);
  const audioRef = useRef<CardAudioResource | null>(null);
  const audioGenerationRef = useRef(0);
  const [audioStatus, setAudioStatus] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle');
  const [audioError, setAudioError] = useState<string | null>(null);

  const isStack = 'isStack' in item && item.isStack;
  const stack = isStack ? item as StackItem : null;
  const asset = isStack ? stack?.representativeAsset : item as Asset;

  useEffect(() => {
    return () => {
      memberRequestRef.current?.abort();
      audioGenerationRef.current += 1;
      const resource = audioRef.current;
      if (resource) releaseAudio(resource, false);
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!isHovered || stack?.type !== 'animation' || members.assets.length < 2) return;
    const timer = window.setInterval(() => {
      setHoverFrameIndex((previous) => (previous + 1) % members.assets.length);
    }, 120);
    return () => window.clearInterval(timer);
  }, [isHovered, stack?.type, members.assets.length]);

  const loadMembers = (retry = false) => {
    if (!stack || memberStatusRef.current === 'loading') return;
    if (!retry && (memberStatusRef.current === 'ready' || memberStatusRef.current === 'error')) return;
    memberStatusRef.current = 'loading';
    const controller = new AbortController();
    memberRequestRef.current = controller;
    setMembers({ status: 'loading', assets: [] });
    requestJson(`/api/stacks/${encodeURIComponent(stack.id)}/assets`,
      (value) => expectArray(value, isAsset, 'stack members'), { signal: controller.signal })
      .then((assets) => {
        if (memberRequestRef.current !== controller || controller.signal.aborted) return;
        memberRequestRef.current = null;
        memberStatusRef.current = 'ready';
        setHoverFrameIndex(0);
        setMembers({ status: 'ready', assets });
      })
      .catch((error: unknown) => {
        if (memberRequestRef.current !== controller || controller.signal.aborted || isAbortError(error)) return;
        memberRequestRef.current = null;
        memberStatusRef.current = 'error';
        setMembers({ status: 'error', assets: [], error: errorMessage(error) });
      });
  };

  const stopAudio = () => {
    audioGenerationRef.current += 1;
    const resource = audioRef.current;
    if (resource) releaseAudio(resource, true);
    audioRef.current = null;
    setAudioStatus('idle');
    setAudioError(null);
  };

  const toggleCardAudio = () => {
    if (!asset) return;
    if (audioStatus === 'loading' || audioStatus === 'playing') {
      stopAudio();
      return;
    }
    if (!asset.fileUrl) {
      setAudioStatus('error');
      setAudioError('Audio file unavailable');
      return;
    }

    const generation = ++audioGenerationRef.current;
    const audio = new Audio(asset.fileUrl);
    const onEnded = () => {
      if (audioRef.current?.audio !== audio || audioGenerationRef.current !== generation) return;
      releaseAudio(audioRef.current, false);
      audioRef.current = null;
      setAudioStatus('idle');
    };
    const onError = () => {
      if (audioRef.current?.audio !== audio || audioGenerationRef.current !== generation) return;
      releaseAudio(audioRef.current, false);
      audioRef.current = null;
      setAudioStatus('error');
      setAudioError('Audio file unavailable');
    };
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audioRef.current = { audio, onEnded, onError };
    setAudioStatus('loading');
    setAudioError(null);
    void Promise.resolve().then(() => audio.play())
      .then(() => {
        if (audioRef.current?.audio !== audio || audioGenerationRef.current !== generation) {
          audio.pause();
          return;
        }
        setAudioStatus('playing');
      })
      .catch((error: unknown) => {
        if (audioRef.current?.audio !== audio || audioGenerationRef.current !== generation) return;
        releaseAudio(audioRef.current, false);
        audioRef.current = null;
        const message = errorMessage(error);
        setAudioStatus('error');
        setAudioError(message);
        showToast('error', 'Audio preview unavailable', message);
      });
  };

  if (!asset) return null;

  const currentDisplayAsset = stack?.type === 'animation' && members.assets[hoverFrameIndex]
    ? members.assets[hoverFrameIndex] : asset;
  const title = stack ? stack.name : asset.name;
  const isImage = asset.category === 'image';
  const isAudio = asset.category === 'audio';
  const selection = <button
    type="button"
    aria-label={`Select ${title}`}
    aria-pressed={isSelected}
    onClick={onSelect}
    className="absolute inset-0 z-0 rounded-lg cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-indigo-400"
  />;

  if (viewMode === 'list') {
    return <div className="flex w-full flex-col gap-1">
      <div className={`group relative flex items-center gap-3 rounded-lg border px-3 py-2 transition-all ${
        isSelected
          ? 'bg-[#22223a] border-indigo-500 shadow-md ring-1 ring-indigo-500/40'
          : 'bg-[#181829] border-[#26263a] hover:bg-[#1f1f33] hover:border-[#363654]'
      }`}>
        {selection}
        {stack ? <button
          type="button"
          onClick={() => { if (!isExpanded) loadMembers(); setIsExpanded(!isExpanded); }}
          aria-label={isExpanded ? 'Collapse content assets' : 'Expand to view content assets'}
          aria-expanded={isExpanded}
          title={isExpanded ? 'Collapse content assets' : 'Expand to view content assets'}
          className="relative z-10 shrink-0 rounded p-1 text-slate-400 hover:bg-[#252538] hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400"
        >{isExpanded ? <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 text-indigo-400" />
          : <ChevronRight aria-hidden="true" className="h-3.5 w-3.5" />}</button>
          : <div className="w-4 shrink-0" />}
        <div className="pointer-events-none flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-[#2b2b40] bg-[#12121d] checkerboard-bg">
          {isAudio && !currentDisplayAsset.thumbnailUrl
            ? <AudioAssetIcon duration={currentDisplayAsset.metadata.duration}
              bpm={currentDisplayAsset.metadata.bpm} className="h-6 w-6" />
            : <CardImage asset={currentDisplayAsset} title={title}
              className="h-full w-full object-contain pixelated" />}
        </div>
        <div className="pointer-events-none min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-semibold text-slate-200">{title}</span>
            {stack && <span className="shrink-0 border border-indigo-500/30 bg-indigo-950/70 px-1.5 text-[10px] font-medium text-indigo-300">{stack.itemCount}</span>}
          </div>
          <span className="block truncate font-mono text-[11px] text-slate-400">{asset.path}</span>
        </div>
        <div className="pointer-events-none flex shrink-0 items-center gap-2 font-mono text-[11px] text-slate-400">
          <span className="bg-[#252538] px-1.5 py-0.5 uppercase text-slate-300">{asset.extension.replace('.', '')}</span>
          <span>{formatBytes(asset.size)}</span>
        </div>
        {stack && onViewStackAssets && <button type="button" onClick={onViewStackAssets}
          aria-label="View each content asset separately" title="View each content asset separately"
          className="relative z-10 flex shrink-0 items-center gap-1 rounded p-1.5 text-xs text-slate-400 hover:bg-indigo-600 hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">
          <Eye aria-hidden="true" className="h-3.5 w-3.5" />
        </button>}
        {onQuickCopy && <button type="button" onClick={onQuickCopy}
          aria-label="Copy to Project" title="Copy to Project"
          className="relative z-10 shrink-0 rounded p-1.5 text-slate-400 opacity-0 transition-all hover:bg-indigo-600 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-indigo-400">
          <Copy aria-hidden="true" className="h-3.5 w-3.5" />
        </button>}
      </div>
      {stack && isExpanded && <div className="ml-4 space-y-1 border-l-2 border-indigo-500/30 py-1 pl-6">
        {members.status === 'loading' && <div className="p-2 text-xs text-slate-500">Loading content assets...</div>}
        {members.status === 'error' && <div role="alert" className="p-2 text-xs text-rose-300">
          {members.error} <button type="button" onClick={() => loadMembers(true)}
            className="rounded underline focus-visible:outline-2 focus-visible:outline-indigo-400">Retry</button>
        </div>}
        {members.status === 'ready' && members.assets.length === 0
          && <div className="p-2 text-xs text-slate-500">No content assets</div>}
        {members.assets.map((frame, index) => <button key={frame.id} type="button"
          onClick={() => onSelectAsset?.(frame)}
          aria-label={`Select content asset ${frame.name}`}
          className="group flex w-full items-center gap-3 rounded-md border border-[#222238] bg-[#141423] px-3 py-1.5 text-left transition-all hover:border-indigo-500/50 hover:bg-[#1c1c30] focus-visible:outline-2 focus-visible:outline-indigo-400">
          <span className="w-6 font-mono text-[10px] font-semibold text-indigo-400">#{index + 1}</span>
          <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded border border-[#26263a] bg-[#10101a] checkerboard-bg">
            <CardImage asset={frame} title={frame.name} className="h-full w-full object-contain pixelated" />
          </span>
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-200">{frame.name}</span>
          <span className="shrink-0 font-mono text-[10px] text-slate-400">{formatBytes(frame.size)}</span>
          {frame.metadata.width && frame.metadata.height && <span className="shrink-0 font-mono text-[10px] text-slate-400">{frame.metadata.width}×{frame.metadata.height}</span>}
        </button>)}
      </div>}
    </div>;
  }

  const thumbnailHeight = cardZoom === 'small' ? 'h-28' : cardZoom === 'large' ? 'h-48' : 'h-36';
  return <div
    onMouseEnter={() => { setIsHovered(true); loadMembers(); }}
    onMouseLeave={() => { setIsHovered(false); setHoverFrameIndex(0); }}
    className={`group relative flex w-full flex-col overflow-hidden rounded-xl border transition-all duration-150 ${
      isSelected
        ? 'bg-[#212136] border-indigo-500 shadow-xl ring-2 ring-indigo-500/40'
        : 'bg-[#181828] border-[#26263a] hover:border-[#383856] hover:bg-[#1d1d30] hover:shadow-lg'
    }`}>
    {selection}
    <div className={`pointer-events-none relative flex w-full items-center justify-center overflow-hidden border-b border-[#232338] ${thumbnailHeight} ${
      isImage ? 'checkerboard-bg' : 'bg-[#12121e]'
    }`}>
      {isAudio && !currentDisplayAsset.thumbnailUrl
        ? <div className="flex flex-col items-center justify-center gap-1.5 p-3">
          <AudioAssetIcon duration={currentDisplayAsset.metadata.duration}
            bpm={currentDisplayAsset.metadata.bpm} className="h-12 w-12" />
          <span className="font-mono text-[10px] text-slate-400">
            {currentDisplayAsset.metadata.duration !== undefined && currentDisplayAsset.metadata.duration <= 5
              ? 'Sound FX' : 'Music Track'}
          </span>
        </div>
        : <CardImage asset={currentDisplayAsset} title={title}
          className="max-h-full max-w-full object-contain p-2 pixelated transition-transform duration-200 group-hover:scale-105" />}
      {stack && <div className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md border border-white/10 bg-black/80 px-2 py-0.5 font-mono text-[10px] font-semibold text-cyan-300 shadow-sm">
        <Layers aria-hidden="true" className="h-3 w-3 text-indigo-400" />{stack.itemCount}
      </div>}
      {asset.isArchiveEntry && <div className="absolute right-2 top-2 rounded border border-amber-500/30 bg-amber-950/80 px-1.5 py-0.5 font-mono text-[9px] font-bold text-amber-300">ZIP</div>}
      {isAudio && <button type="button" onClick={toggleCardAudio}
        aria-label={audioStatus === 'playing' || audioStatus === 'loading' ? 'Stop audio preview' : audioStatus === 'error' ? 'Retry audio preview' : 'Play audio preview'}
        title={audioStatus === 'playing' || audioStatus === 'loading' ? 'Stop audio preview' : 'Play audio preview'}
        className="pointer-events-auto absolute bottom-2 left-2 z-10 rounded-full border border-white/20 bg-black/80 p-1.5 text-white shadow-md transition-all hover:bg-indigo-600 focus-visible:outline-2 focus-visible:outline-indigo-400">
        {audioStatus === 'playing' || audioStatus === 'loading'
          ? <Pause aria-hidden="true" className="h-3.5 w-3.5" />
          : <Play aria-hidden="true" className="ml-0.5 h-3.5 w-3.5" />}
      </button>}
      {onQuickCopy && <button type="button" onClick={onQuickCopy}
        aria-label="Quick Copy to Project" title="Quick Copy to Project"
        className="pointer-events-auto absolute bottom-2 right-2 z-10 rounded-md border border-white/20 bg-black/80 p-1.5 text-slate-300 opacity-0 shadow-md transition-all hover:bg-indigo-600 hover:text-white group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-indigo-400">
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
      </button>}
    </div>
    <div className="pointer-events-none flex min-w-0 flex-col gap-1.5 p-3">
      <div className="flex items-center justify-between gap-1.5">
        <span className="truncate text-xs font-semibold text-slate-100" title={title}>{title}</span>
        <span className="shrink-0 rounded border border-[#32324e] bg-[#25253a] px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-indigo-300">{asset.extension.replace('.', '')}</span>
      </div>
      <div className="flex items-center justify-between font-mono text-[11px] text-slate-400">
        <span>{formatBytes(asset.size)}</span>
        {isImage && asset.metadata.width && asset.metadata.height && <span>{asset.metadata.width}×{asset.metadata.height}</span>}
        {isAudio && asset.metadata.duration && <span>{asset.metadata.duration.toFixed(1)}s</span>}
      </div>
      {audioError && <span role="alert" className="text-[10px] text-rose-300">{audioError}</span>}
      {stack && isHovered && members.status === 'error' && <button type="button"
        onClick={() => loadMembers(true)}
        className="pointer-events-auto relative z-10 self-start rounded text-[10px] text-rose-300 underline focus-visible:outline-2 focus-visible:outline-indigo-400">
        Retry preview
      </button>}
      {stack && isHovered && members.status === 'ready' && members.assets.length === 0
        && <span className="text-[10px] text-slate-500">No content assets</span>}
    </div>
  </div>;
}
