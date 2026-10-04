import * as mm from 'music-metadata';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { AudioMetadata } from '../../shared/types.js';

export const SUPPORTED_AUDIO_EXTENSIONS = new Set(['.wav', '.mp3', '.ogg', '.flac']);

export function isSupportedAudioExtension(ext: string): boolean {
  return SUPPORTED_AUDIO_EXTENSIONS.has(ext.toLowerCase());
}

export function getAudioMimeType(extension: string): string {
  const ext = extension.toLowerCase();
  switch (ext) {
    case '.wav':
      return 'audio/wav';
    case '.mp3':
      return 'audio/mpeg';
    case '.ogg':
      return 'audio/ogg';
    case '.flac':
      return 'audio/flac';
    default:
      return 'audio/wav';
  }
}

export interface AudioProcessingResult {
  metadata: AudioMetadata;
  thumbnailBuffer: Buffer;
}

export async function generateAudioThumbnail(
  name: string,
  duration?: number,
  channels?: number
): Promise<Buffer> {
  const width = 400;
  const height = 240;
  const bars = 48;
  const barWidth = 4;
  const gap = 4;
  const startX = (width - bars * (barWidth + gap)) / 2;

  // Generate pseudo-random deterministic waveform bars based on asset name
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash << 5) - hash + name.charCodeAt(i);
    hash |= 0;
  }

  const rects: string[] = [];
  for (let i = 0; i < bars; i++) {
    const x = startX + i * (barWidth + gap);
    // Normalized pseudo-amplitude
    const seed = Math.sin(i * 0.4 + hash) * 0.5 + 0.5;
    const bellCurve = Math.sin((i / (bars - 1)) * Math.PI);
    const amp = Math.max(0.15, Math.min(0.95, seed * 0.7 * bellCurve + 0.25));
    const h = Math.round(amp * (height * 0.65));
    const y = Math.round((height - h) / 2);

    // Gradient or neon color based on channel / index
    const color = i % 2 === 0 ? '#6366f1' : '#06b6d4';
    rects.push(`<rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="2" fill="${color}" opacity="0.85" />`);
  }

  const durationStr = duration ? `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}` : '';

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#141424" />
          <stop offset="100%" stop-color="#1e1e36" />
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrad)" />
      <!-- Waveform center line -->
      <line x1="20" y1="${height / 2}" x2="${width - 20}" y2="${height / 2}" stroke="#2d2d48" stroke-width="1" stroke-dasharray="2 4" />
      <g>
        ${rects.join('\n')}
      </g>
      <!-- Audio Icon Badge -->
      <circle cx="36" cy="36" r="16" fill="#25253e" stroke="#3b3b5c" stroke-width="1.5" />
      <polygon points="32,28 32,44 44,36" fill="#818cf8" />
      <!-- Duration text if known -->
      ${durationStr ? `<text x="${width - 24}" y="42" font-family="sans-serif" font-size="12" font-weight="600" fill="#94a3b8" text-anchor="end">${durationStr}</text>` : ''}
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .webp({ quality: 85 })
    .toBuffer();
}

export async function processAudioFile(filePath: string): Promise<AudioProcessingResult> {
  const ext = path.extname(filePath);
  const name = path.basename(filePath);
  let metadata: AudioMetadata = {};

  try {
    const parsed = await mm.parseFile(filePath, { skipCovers: true });
    metadata = {
      duration: parsed.format.duration,
      sampleRate: parsed.format.sampleRate,
      numberOfChannels: parsed.format.numberOfChannels,
      bitrate: parsed.format.bitrate,
      codec: parsed.format.codec,
      lossless: parsed.format.lossless,
    };
  } catch (err) {
    console.warn(`Could not parse audio metadata for ${filePath}:`, err);
  }

  const thumbnailBuffer = await generateAudioThumbnail(name, metadata.duration, metadata.numberOfChannels);

  return {
    metadata,
    thumbnailBuffer,
  };
}

export async function processAudioBuffer(buffer: Buffer, name: string, extension: string): Promise<AudioProcessingResult> {
  const mimeType = getAudioMimeType(extension);
  let metadata: AudioMetadata = {};

  try {
    const parsed = await mm.parseBuffer(buffer, { mimeType, size: buffer.length });
    metadata = {
      duration: parsed.format.duration,
      sampleRate: parsed.format.sampleRate,
      numberOfChannels: parsed.format.numberOfChannels,
      bitrate: parsed.format.bitrate,
      codec: parsed.format.codec,
      lossless: parsed.format.lossless,
    };
  } catch (err) {
    console.warn(`Could not parse audio buffer for ${name}:`, err);
  }

  const thumbnailBuffer = await generateAudioThumbnail(name, metadata.duration, metadata.numberOfChannels);

  return {
    metadata,
    thumbnailBuffer,
  };
}
