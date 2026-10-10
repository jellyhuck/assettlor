import { useState } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import type { Asset } from '../types';

export interface ImageThumbnailProps {
  asset: Asset;
  pixelated?: boolean;
  /** Use when the thumbnail is regenerated without a URL or metadata change. */
  revision?: string | number;
  className?: string;
  alt?: string;
}

function thumbnailRevision(asset: Asset, revision?: string | number): string {
  return [
    asset.id, asset.extension, asset.updatedAt, asset.mtime, asset.hash,
    asset.metadata.thumbnailFingerprint, asset.thumbnailUrl, asset.fileUrl,
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

function versionedUrl(url: string, token: string): string {
  const hashStart = url.indexOf('#');
  const path = hashStart < 0 ? url : url.slice(0, hashStart);
  const fragment = hashStart < 0 ? '' : url.slice(hashStart);
  return `${path}${path.includes('?') ? '&' : '?'}_thumbnail=${token}${fragment}`;
}

export function ImageThumbnail(props: ImageThumbnailProps) {
  const sourceKey = thumbnailRevision(props.asset, props.revision);
  return <ImageThumbnailContent key={sourceKey} {...props} sourceKey={sourceKey} />;
}

function ImageThumbnailContent({
  asset, pixelated = true, className = 'h-full w-full object-contain',
  alt = asset.name, sourceKey,
}: ImageThumbnailProps & { sourceKey: string }) {
  const [failedCount, setFailedCount] = useState(0);
  const candidates = asset.extension.toLowerCase() === '.tga'
    ? [asset.thumbnailUrl]
    : [asset.thumbnailUrl, asset.fileUrl];
  const sources = [...new Set(candidates.filter(Boolean))];
  const source = sources[failedCount];

  if (!source) {
    return <span role="img" aria-label={`Preview unavailable for ${alt}`}
      className="flex h-full w-full items-center justify-center text-slate-500">
      <ImageIcon aria-hidden="true" className="h-4 w-4" />
    </span>;
  }

  return <img
    src={versionedUrl(source, versionToken(sourceKey))}
    alt={alt}
    loading="lazy"
    draggable={false}
    className={`${className} ${pixelated ? 'pixelated' : 'smooth-render'}`}
    onError={() => setFailedCount((count) => Math.min(count + 1, sources.length))}
  />;
}
