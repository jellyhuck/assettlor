import * as mm from 'music-metadata';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { AudioMetadata } from '../../../shared/types.js';
import {
  AUDIO_THUMBNAIL_SPEC,
  DEFAULT_THUMBNAIL_QUALITY,
  normalizeThumbnailQuality,
} from './processingFingerprint.js';

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

export interface BpmColorConfig {
  primary: string;
  secondary: string;
  hex: string;
}

/**
 * Computes color transition based on BPM:
 * - Low BPM (<= 60): Teal rgb(121, 204, 191)
 * - Mid BPM (120): Purple rgb(168, 85, 247)
 * - High BPM (>= 180): Red rgb(239, 68, 68)
 * - Linear transition from teal through purple in the middle up to red for high BPM values.
 */
export function getBpmColor(bpm?: number | null): BpmColorConfig {
  if (bpm === undefined || bpm === null || isNaN(bpm)) {
    return {
      primary: 'rgb(121, 204, 191)', // Teal
      secondary: '#F4CE73',           // Swapped yellow accent
      hex: '#79ccbf',
    };
  }

  const minBpm = 60;
  const maxBpm = 180;
  const t = Math.max(0, Math.min(1, (bpm - minBpm) / (maxBpm - minBpm)));

  let r: number, g: number, b: number;
  if (t <= 0.5) {
    // 0 to 0.5: Teal (121, 204, 191) -> Purple (168, 85, 247)
    const factor = t / 0.5;
    r = Math.round(121 + factor * (168 - 121));
    g = Math.round(204 + factor * (85 - 204));
    b = Math.round(191 + factor * (247 - 191));
  } else {
    // 0.5 to 1.0: Purple (168, 85, 247) -> Red (239, 68, 68)
    const factor = (t - 0.5) / 0.5;
    r = Math.round(168 + factor * (239 - 168));
    g = Math.round(85 + factor * (68 - 85));
    b = Math.round(247 + factor * (68 - 247));
  }

  const primary = `rgb(${r}, ${g}, ${b})`;
  const hex = '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);

  return {
    primary,
    secondary: '#F4CE73',
    hex,
  };
}

export async function generateAudioThumbnail(
  name: string,
  duration?: number,
  channels?: number,
  _bpm?: number | null,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<Buffer> {
  const width = AUDIO_THUMBNAIL_SPEC.width;
  const height = AUDIO_THUMBNAIL_SPEC.height;
  const isSound = duration !== undefined && duration <= 5;
  const durationStr = duration
    ? `${Math.floor(duration / 60)}:${Math.floor(duration % 60).toString().padStart(2, '0')}`
    : '';

  let contentSvg = '';

  if (isSound) {
    // Sound icon (<=5s): Dedicated Bell icon with sound waves (muted warm gold)
    const iconScale = 0.33;
    const iconW = 512 * iconScale;
    const iconH = 512 * iconScale;
    const tx = (width - iconW) / 2;
    const ty = (height - iconH) / 2;

    contentSvg = `
      <!-- Subtle glow and circular badge behind sound icon -->
      <circle cx="200" cy="120" r="95" fill="url(#glowGrad)" />
      <circle cx="200" cy="120" r="82" fill="#1e1e32" stroke="#313152" stroke-width="1.5" />

      <!-- Sound Bell Icon -->
      <g transform="translate(${tx}, ${ty}) scale(${iconScale})">
        <!-- Sound Waves Left -->
        <path d="M 68 150 C 24 215 24 295 68 360" fill="none" stroke="#64748b" stroke-width="18" stroke-linecap="round" />
        <path d="M 118 180 C 80 222 80 288 118 330" fill="none" stroke="#94a3b8" stroke-width="18" stroke-linecap="round" />

        <!-- Sound Waves Right -->
        <path d="M 394 180 C 432 222 432 288 394 330" fill="none" stroke="#94a3b8" stroke-width="18" stroke-linecap="round" />
        <path d="M 444 150 C 488 215 488 295 444 360" fill="none" stroke="#64748b" stroke-width="18" stroke-linecap="round" />

        <!-- Top Loop -->
        <path d="M 230 105 C 230 75 282 75 282 105" fill="none" stroke="#19cfba" stroke-width="22" stroke-linecap="round" />
        <path d="M 230 105 C 230 75 282 75 282 105" fill="none" stroke="#1e293b" stroke-width="7" stroke-linecap="round" />

        <!-- Clapper -->
        <circle cx="256" cy="385" r="34" fill="#60b7fe" stroke="#1e293b" stroke-width="16" />

        <!-- Bell Body (Muted Warm Gold) -->
        <path d="M 256 115 
                 C 205 115 180 180 176 270 
                 C 174 315 142 340 132 355 
                 C 126 364 133 375 145 375 
                 L 367 375 
                 C 379 375 386 364 380 355 
                 C 370 340 338 315 336 270 
                 C 332 180 307 115 256 115 Z" 
              fill="#e5b84c" stroke="#1e293b" stroke-width="16" stroke-linejoin="round" stroke-linecap="round" />

        <!-- Top Cap -->
        <path d="M 234 125 C 234 116 278 116 278 125 Z" fill="#19cfba" stroke="#1e293b" stroke-width="10" stroke-linejoin="round" />

        <!-- Inner Rim Contour -->
        <line x1="165" y1="345" x2="347" y2="345" stroke="#bfa238" stroke-width="10" stroke-linecap="round" opacity="0.6" />
      </g>
      <text x="24" y="${height - 20}" font-family="monospace" font-size="11" font-weight="700" fill="#38bdf8">SFX / SOUND</text>
    `;
  } else {
    // Music (>5s): Dedicated Music plate icon with standard teal and yellow colors
    const iconScale = 0.17;
    const iconW = 1024 * iconScale;
    const iconH = 1024 * iconScale;
    const tx = (width - iconW) / 2;
    const ty = (height - iconH) / 2;

    contentSvg = `
      <!-- Subtle glow behind music plate icon -->
      <circle cx="200" cy="120" r="95" fill="url(#glowGrad)" />

      <!-- Music Plate Icon -->
      <g transform="translate(${tx}, ${ty}) scale(${iconScale})">
        <!-- Outer dark vinyl rim -->
        <path d="M511.010927 95.397443c-229.290927 0-415.123042 185.832115-415.123043 415.123043 0 229.224375 185.832115 415.123042 415.123042 415.123042 229.287856 0 415.123042-185.898667 415.123042-415.123042 0-229.289904-185.835186-415.123042-415.123042-415.123043z" fill="#27323A" />
        
        <!-- Disc background: standard teal #79ccbf -->
        <path d="M511.010927 875.829459c-201.401315 0-365.308973-163.91073-365.308974-365.308973 0-201.464796 163.907658-365.308973 365.308974-365.308974 201.464796 0 365.308973 163.844177 365.308973 365.308974 0 201.398243-163.844177 365.308973-365.308973 365.308973z" fill="#79ccbf" />
        
        <!-- Groove lines & clef shapes -->
        <path d="M807.82402 423.278289c19.06884 41.578959 20.885213 88.215912 4.92796 131.285648-3.114659 8.561729-12.71256 12.971603-21.340842 9.793463-8.628282-3.17814-12.971603-12.71256-9.860016-21.274289 12.845665-34.704593 11.480826-72.387669-3.955269-105.922985-15.436095-33.535316-42.940727-59.056682-77.704705-71.933063-8.564801-3.17814-12.909146-12.71256-9.796535-21.27429 3.244693-8.628282 12.71256-12.974675 21.340842-9.796534 43.004208 15.828243 77.186619 47.547187 96.388565 89.12205z" fill="#27323A" />
        
        <path d="M751.716128 453.050826c12.842594 30.03158 13.168189 63.178844 1.036172 93.598477-3.37063 8.431696-13.101637 12.646008-21.533333 9.208825-8.495177-3.37063-12.71256-13.038156-9.275377-21.533332 8.757291-22.184523 8.561729-46.37791-0.843681-68.236838-9.338858-21.858928-26.724431-38.788872-48.841378-47.609644-8.561729-3.437183-12.583551-13.038156-9.275377-21.533332 3.374726-8.628282 13.104708-12.715632 21.599885-9.34193 30.356152 12.196522 54.161486 35.353736 67.133089 65.447774zM656.49684 537.178364c-3.891788-48.645816-39.306958-98.071832-125.573391-101.057482l-4.54298-50.074135c60.455309-8.624186 95.608364-59.057706 93.795063-103.000816-1.753916-41.448926-35.869775-85.75142-126.224583-85.75142-4.668917 0-9.082887 1.97917-12.261026 5.450142a16.832675 16.832675 0 0 0-4.280865 12.679795l12.974675 141.759995c-61.620491 11.318028-107.284752 43.39226-130.116371 91.912138-24.064377 51.30587-18.225159 112.989841 15.243605 161.05409 31.393348 45.078599 81.793079 70.05321 140.102324 70.05321 1.42832 0 2.855616-0.12901 4.217384-0.195562l4.79895 52.475147c3.308173 25.100549-8.302686 39.177948-18.614235 46.5704-12.974675 9.405411-30.875262 13.297199-46.832514 10.767178 10.766154-19.71696 8.1061-39.306958 0.325595-53.05569-10.378102-18.358264-29.709057-28.215208-46.314429-23.546291-5.771642 1.62081-24.582463 9.53442-23.349705 41.186812 1.169277 26.919993 15.502648 48.971411 39.436991 60.584318 11.935431 5.835122 25.621706 8.690739 39.436992 8.690739 20.108084 0 40.539716-6.033756 56.689458-17.644616 24.973587-17.966116 36.387861-45.596685 32.23703-77.186619l-4.862432-53.122242c67.973699-15.891724 108.320924-80.690355 103.714464-138.549091z" fill="#27323A" />
        
        <path d="M429.929448 774.058329c-4.214312-5.705089-6.548771-12.71256-6.874366-21.015246-0.12901-3.955269 0.259043-6.486314-0.192491-7.459004 2.464492 1.039244 6.874366 4.476427 9.142272 10.507111 2.075416 5.771642 1.364839 11.806422-2.075415 17.967139z" fill="#27323A" />
        
        <!-- White spindle center -->
        <path d="M510.877822 551.773849c-22.765066 0-41.316845-18.488297-41.316845-41.253363 0-23.805334 19.586926-38.008671 35.803222-40.668725 2.660054-0.195562 5.061065-0.066553 7.588014-0.195562 21.728894 1.169277 39.177948 18.87635 39.177948 40.864287 0.001024 22.76609-18.483178 41.253364-41.252339 41.252339z" fill="#FFFFFF" />
        
        <!-- Clef accent shapes: yellow #F4CE73 -->
        <path d="M586.965812 284.471179c1.231734 28.799846-23.805334 61.817076-63.633449 68.4324l-11.088678-121.618123c45.922281 3.922505 73.489369 23.187931 74.722127 53.185723zM402.753484 591.144288c-26.268802-37.749628-31.134305-87.952773-12.391061-127.90785 17.707073-37.686147 53.836914-62.982258 103.070441-72.779817l4.280864 46.962548c-31.655463 6.16379-61.361448 33.986849-61.361447 73.101317 0 41.057802 33.468763 74.463084 74.526565 74.463084h0.262114l5.642632 61.554962c-64.215016 0.518086-98.916537-33.664326-114.030108-55.394244zM549.796727 642.713296l-6.030685-65.708864c24.518982-12.194474 41.575888-37.295023 41.575888-66.482922 0-11.025197-2.526949-21.403299-6.807814-30.811781 26.461292 11.483898 42.615131 31.785496 44.883037 60.06316 3.30715 42.096021-25.100549 89.25106-73.620426 102.940407z" fill="#F4CE73" />
      </g>
      <text x="24" y="${height - 20}" font-family="monospace" font-size="11" font-weight="700" fill="#79ccbf">MUSIC</text>
    `;
  }

  const glowColor = isSound ? '#38bdf8' : '#79ccbf';
  const badgeColor = isSound ? '#818cf8' : '#79ccbf';

  const svg = `
    <svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#141424" />
          <stop offset="100%" stop-color="#1e1e36" />
        </linearGradient>
        <radialGradient id="glowGrad" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stop-color="${glowColor}" stop-opacity="0.16" />
          <stop offset="100%" stop-color="${glowColor}" stop-opacity="0" />
        </radialGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrad)" />
      ${contentSvg}
      <!-- Audio Icon Badge -->
      <circle cx="36" cy="36" r="16" fill="#25253e" stroke="#3b3b5c" stroke-width="1.5" />
      <polygon points="32,28 32,44 44,36" fill="${badgeColor}" />
      <!-- Duration text if known -->
      ${durationStr ? `<text x="${width - 24}" y="42" font-family="sans-serif" font-size="12" font-weight="600" fill="#94a3b8" text-anchor="end">${durationStr}</text>` : ''}
    </svg>
  `;

  return sharp(Buffer.from(svg))
    .webp({ quality: normalizeThumbnailQuality(quality) })
    .toBuffer();
}

export async function processAudioFile(
  filePath: string,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<AudioProcessingResult> {
  const ext = path.extname(filePath);
  const name = path.basename(filePath);
  let metadata: AudioMetadata = {};

  try {
    const parsed = await mm.parseFile(filePath, { skipCovers: true });
    if (parsed.format.duration !== undefined || parsed.format.sampleRate !== undefined) {
      metadata = {
        duration: parsed.format.duration,
        sampleRate: parsed.format.sampleRate,
        numberOfChannels: parsed.format.numberOfChannels,
        bitrate: parsed.format.bitrate,
        codec: parsed.format.codec,
        lossless: parsed.format.lossless,
        bpm: parsed.common.bpm,
        audioThumbnailVersion: AUDIO_THUMBNAIL_SPEC.rendererVersion,
      };
    }
  } catch (err) {
    console.warn(`Could not parse audio metadata for ${filePath}:`, err);
  }

  const thumbnailBuffer = await generateAudioThumbnail(
    name, metadata.duration, metadata.numberOfChannels, metadata.bpm, quality
  );

  return {
    metadata,
    thumbnailBuffer,
  };
}

export async function processAudioBuffer(
  buffer: Buffer,
  name: string,
  extension: string,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<AudioProcessingResult> {
  const mimeType = getAudioMimeType(extension);
  let metadata: AudioMetadata = {};

  try {
    const parsed = await mm.parseBuffer(buffer, { mimeType, size: buffer.length });
    if (parsed.format.duration !== undefined || parsed.format.sampleRate !== undefined) {
      metadata = {
        duration: parsed.format.duration,
        sampleRate: parsed.format.sampleRate,
        numberOfChannels: parsed.format.numberOfChannels,
        bitrate: parsed.format.bitrate,
        codec: parsed.format.codec,
        lossless: parsed.format.lossless,
        bpm: parsed.common.bpm,
        audioThumbnailVersion: AUDIO_THUMBNAIL_SPEC.rendererVersion,
      };
    }
  } catch (err) {
    console.warn(`Could not parse audio buffer for ${name}:`, err);
  }

  const thumbnailBuffer = await generateAudioThumbnail(
    name, metadata.duration, metadata.numberOfChannels, metadata.bpm, quality
  );

  return {
    metadata,
    thumbnailBuffer,
  };
}
