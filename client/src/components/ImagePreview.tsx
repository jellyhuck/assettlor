import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Grid, Image as ImageIcon, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';
import type { Asset } from '../types';

export interface ImagePreviewProps {
  asset: Asset;
  pixelated: boolean;
  checkerboard: boolean;
  onPixelatedChange: (enabled: boolean) => void;
  onCheckerboardChange: (enabled: boolean) => void;
  /** Use when the image is regenerated without changing its URLs or metadata. */
  revision?: string | number;
  title?: string;
}

type DragStart = {
  pointerId: number;
  x: number;
  y: number;
  left: number;
  top: number;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 0.25;
const PAN_STEP = 48;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function sourceRevision(asset: Asset, revision?: string | number) {
  return [
    asset.id, asset.updatedAt, asset.mtime, asset.hash,
    asset.metadata.thumbnailFingerprint, asset.fileUrl, asset.thumbnailUrl,
    revision ?? '',
  ].join('|');
}

function versionToken(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function versionedUrl(url: string, version: string): string {
  const hashStart = url.indexOf('#');
  const path = hashStart < 0 ? url : url.slice(0, hashStart);
  const fragment = hashStart < 0 ? '' : url.slice(hashStart);
  return `${path}${path.includes('?') ? '&' : '?'}_preview=${encodeURIComponent(version)}${fragment}`;
}

/** A scrollable image stage keeps every edge reachable at high zoom. */
export function ImagePreview(props: ImagePreviewProps) {
  const sourceKey = sourceRevision(props.asset, props.revision);
  return <ImagePreviewContent key={sourceKey} {...props} sourceKey={sourceKey} />;
}

function ImagePreviewContent({
  asset, pixelated, checkerboard, onPixelatedChange, onCheckerboardChange,
  sourceKey, title = 'Preview',
}: ImagePreviewProps & { sourceKey: string }) {
  const candidates = asset.extension.toLowerCase() === '.tga'
    ? [asset.thumbnailUrl]
    : [asset.fileUrl, asset.thumbnailUrl];
  const sources = [...new Set(candidates.filter(Boolean))];
  const [failedStage, setFailedStage] = useState<{ key: string; index: number } | null>(null);
  const [retryState, setRetryState] = useState<{ key: string; count: number } | null>(null);
  const [zoomState, setZoomState] = useState<{ key: string; value: number }>({ key: sourceKey, value: 1 });
  const stage = failedStage?.key === sourceKey ? failedStage.index : 0;
  const retryCount = retryState?.key === sourceKey ? retryState.count : 0;
  const zoom = zoomState.key === sourceKey ? zoomState.value : 1;
  const imageUrl = sources[stage]
    ? versionedUrl(sources[stage], `${versionToken(sourceKey)}-${retryCount}`)
    : undefined;
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragStart | null>(null);
  const previousZoomRef = useRef({ key: sourceKey, value: 1 });

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const previous = previousZoomRef.current;
    if (previous.key !== sourceKey || zoom === 1) {
      viewport.scrollLeft = 0;
      viewport.scrollTop = 0;
      dragRef.current = null;
    } else if (previous.value !== zoom) {
      const ratio = zoom / previous.value;
      viewport.scrollLeft = clamp(
        (viewport.scrollLeft + viewport.clientWidth / 2) * ratio - viewport.clientWidth / 2,
        0, Math.max(0, viewport.scrollWidth - viewport.clientWidth),
      );
      viewport.scrollTop = clamp(
        (viewport.scrollTop + viewport.clientHeight / 2) * ratio - viewport.clientHeight / 2,
        0, Math.max(0, viewport.scrollHeight - viewport.clientHeight),
      );
    }
    previousZoomRef.current = { key: sourceKey, value: zoom };
  }, [sourceKey, zoom]);

  const changeZoom = (value: number) => {
    setZoomState({ key: sourceKey, value: clamp(value, MIN_ZOOM, MAX_ZOOM) });
  };

  const retryImage = () => {
    setRetryState({ key: sourceKey, count: retryCount + 1 });
    setFailedStage({ key: sourceKey, index: 0 });
  };

  const panTo = (left: number, top: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    viewport.scrollLeft = clamp(left, 0, Math.max(0, viewport.scrollWidth - viewport.clientWidth));
    viewport.scrollTop = clamp(top, 0, Math.max(0, viewport.scrollHeight - viewport.clientHeight));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (zoom <= 1 || event.button !== 0) return;
    event.preventDefault();
    const viewport = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId, x: event.clientX, y: event.clientY,
      left: viewport.scrollLeft, top: viewport.scrollTop,
    };
    viewport.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    panTo(drag.left - (event.clientX - drag.x), drag.top - (event.clientY - drag.y));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const canPanX = viewport.scrollWidth > viewport.clientWidth;
    const canPanY = viewport.scrollHeight > viewport.clientHeight;
    switch (event.key) {
      case 'ArrowLeft': if (!canPanX) return; panTo(viewport.scrollLeft - PAN_STEP, viewport.scrollTop); break;
      case 'ArrowRight': if (!canPanX) return; panTo(viewport.scrollLeft + PAN_STEP, viewport.scrollTop); break;
      case 'ArrowUp': if (!canPanY) return; panTo(viewport.scrollLeft, viewport.scrollTop - PAN_STEP); break;
      case 'ArrowDown': if (!canPanY) return; panTo(viewport.scrollLeft, viewport.scrollTop + PAN_STEP); break;
      case 'Home': if (!canPanX && !canPanY) return; panTo(0, 0); break;
      case 'End': if (!canPanX && !canPanY) return; panTo(viewport.scrollWidth, viewport.scrollHeight); break;
      case '+':
      case '=': changeZoom(zoom + ZOOM_STEP); break;
      case '-': changeZoom(zoom - ZOOM_STEP); break;
      case '0': changeZoom(1); panTo(0, 0); break;
      default: return;
    }
    event.preventDefault();
  };

  return <div className="space-y-2">
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs font-semibold text-slate-300">{title}</span>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => changeZoom(zoom - ZOOM_STEP)}
          disabled={zoom <= MIN_ZOOM} aria-label="Zoom out" title="Zoom Out"
          className="rounded p-1 text-slate-400 hover:bg-[#252538] hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40">
          <ZoomOut aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <output aria-label="Image zoom" className="w-9 text-center font-mono text-[10px] text-slate-400">
          {Math.round(zoom * 100)}%
        </output>
        <button type="button" onClick={() => changeZoom(zoom + ZOOM_STEP)}
          disabled={zoom >= MAX_ZOOM} aria-label="Zoom in" title="Zoom In"
          className="rounded p-1 text-slate-400 hover:bg-[#252538] hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400 disabled:opacity-40">
          <ZoomIn aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => { changeZoom(1); panTo(0, 0); }}
          aria-label="Reset zoom and pan" title="Reset Zoom"
          className="rounded p-1 text-slate-400 hover:bg-[#252538] hover:text-white focus-visible:outline-2 focus-visible:outline-indigo-400">
          <Maximize2 aria-hidden="true" className="h-3.5 w-3.5" />
        </button>
        <button type="button" onClick={() => onPixelatedChange(!pixelated)}
          aria-label="Pixelated rendering" aria-pressed={pixelated}
          title={pixelated ? 'Pixel Art: Nearest Neighbor' : 'Bilinear Filtered'}
          className={`ml-1 rounded border px-1.5 py-0.5 font-mono text-[10px] focus-visible:outline-2 focus-visible:outline-indigo-400 ${
            pixelated
              ? 'border-indigo-500/50 bg-indigo-950/60 text-indigo-300'
              : 'border-[#2f2f48] bg-[#202033] text-slate-400'
          }`}>{pixelated ? 'Pixel' : 'Smooth'}</button>
        <button type="button" onClick={() => onCheckerboardChange(!checkerboard)}
          aria-label="Checkerboard background" aria-pressed={checkerboard}
          title="Toggle Checkerboard"
          className={`rounded border p-1 focus-visible:outline-2 focus-visible:outline-indigo-400 ${
            checkerboard
              ? 'border-indigo-500/50 bg-indigo-950/60 text-indigo-300'
              : 'border-[#2f2f48] bg-[#202033] text-slate-400'
          }`}><Grid aria-hidden="true" className="h-3 w-3" /></button>
      </div>
    </div>
    <div ref={viewportRef} role="region" tabIndex={0}
      aria-label={`Pan ${asset.name} preview`}
      aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight Home End + - 0"
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={`relative h-60 overflow-auto rounded-lg border border-[#2b2b42] focus-visible:outline-2 focus-visible:outline-indigo-400 ${
        checkerboard ? 'checkerboard-bg' : 'bg-[#11111d]'
      } ${zoom > 1 ? 'cursor-grab active:cursor-grabbing touch-none' : ''}`}>
      {imageUrl ? <div
        className="flex items-center justify-center"
        style={{ width: `${Math.max(zoom, 1) * 100}%`, height: `${Math.max(zoom, 1) * 100}%` }}>
        <img key={`${sourceKey}:${stage}`} src={imageUrl} alt={asset.name}
          draggable={false}
          onError={() => setFailedStage((previous) => ({
            key: sourceKey,
            index: Math.min((previous?.key === sourceKey ? previous.index : 0) + 1, sources.length),
          }))}
          style={{ width: `${Math.min(zoom, 1) * 100}%`, height: `${Math.min(zoom, 1) * 100}%` }}
          className={`object-contain ${pixelated ? 'pixelated' : 'smooth-render'}`}
        />
      </div> : <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center text-slate-400">
        <ImageIcon aria-hidden="true" className="h-6 w-6" />
        <span role="status" className="text-xs">Preview unavailable</span>
        {sources.length > 0 && <button type="button"
          onClick={retryImage}
          className="rounded border border-indigo-500/50 px-2 py-1 text-xs text-indigo-300 hover:bg-indigo-950/60 focus-visible:outline-2 focus-visible:outline-indigo-400">
          Retry image
        </button>}
      </div>}
    </div>
    <p className="text-[10px] text-slate-500">Drag to pan when zoomed, or focus the image and use the arrow keys.</p>
  </div>;
}
