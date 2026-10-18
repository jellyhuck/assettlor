import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { ImageMetadata } from '../../../shared/types.js';
import {
  DEFAULT_THUMBNAIL_QUALITY,
  IMAGE_THUMBNAIL_SPEC,
  normalizeThumbnailQuality,
} from './processingFingerprint.js';
// @ts-ignore
import bmp from 'bmp-js';

export const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.bmp',
  '.gif',
  '.tga',
  '.svg',
]);

export function isSupportedImageExtension(ext: string): boolean {
  return SUPPORTED_IMAGE_EXTENSIONS.has(ext.toLowerCase());
}

export interface ImageProcessingResult {
  metadata: ImageMetadata;
  thumbnailBuffer: Buffer;
}

export interface DecodedRaster {
  width: number;
  height: number;
  data: Buffer;
  hasAlpha: boolean;
  channels: number;
}

// The BMP and TGA decoders hold the full RGBA raster in memory (twice, briefly).
const MAX_SOURCE_PIXELS = 8192 * 8192;
// Sharp decodes on demand while resizing, so it can accept larger textures.
// This matches Sharp's own default limit.
const MAX_SHARP_INPUT_PIXELS = 16384 * 16384;

export function decodeBmpBuffer(buffer: Buffer): DecodedRaster {
  // bmp-js allocates its output while parsing. Check the dimensions first so a
  // small, corrupt header cannot make it allocate an unbounded raw image.
  if (buffer.length < 54 || buffer.toString('ascii', 0, 2) !== 'BM') {
    throw new Error('Invalid BMP header');
  }
  const width = buffer.readInt32LE(18);
  const signedHeight = buffer.readInt32LE(22);
  const height = Math.abs(signedHeight);
  if (width < 1 || height < 1 || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('Invalid BMP dimensions');
  }

  const decoded = bmp.decode(buffer);
  // bmp-js returns ABGR, including a reserved zero byte for opaque BMPs.
  // A 32-bit BMP with only zero alpha bytes is commonly opaque BI_RGB.
  const hasAlpha = decoded.bitPP === 32 && decoded.data.some((value: number, index: number) =>
    index % 4 === 0 && value !== 0
  );
  const data = Buffer.alloc(decoded.data.length);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = decoded.data[i + 3];
    data[i + 1] = decoded.data[i + 2];
    data[i + 2] = decoded.data[i + 1];
    data[i + 3] = hasAlpha ? decoded.data[i] : 255;
  }

  return { width: decoded.width, height: decoded.height, data, hasAlpha, channels: hasAlpha ? 4 : 3 };
}

// Decode supported TGA pixels before passing normalized RGBA to Sharp. Both
// origin flags affect where each source pixel is placed.
export function decodeTgaBuffer(buffer: Buffer): DecodedRaster {
  if (buffer.length < 18) throw new Error('Invalid TGA: truncated header');
  const idLength = buffer[0];
  const colorMapType = buffer[1];
  const imageType = buffer[2];
  const isRle = imageType === 10 || imageType === 11;
  const isGray = imageType === 3 || imageType === 11;
  const colorMapLength = buffer.readUInt16LE(5);
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  const isTopDown = (descriptor & 0x20) !== 0;
  const isRightToLeft = (descriptor & 0x10) !== 0;
  const alphaBits = descriptor & 0x0f;

  if (colorMapType !== 0 || colorMapLength !== 0) {
    throw new Error('Unsupported TGA color map');
  }
  if (descriptor & 0xc0) throw new Error('Unsupported TGA interleaving');
  if (![2, 3, 10, 11].includes(imageType)) {
    throw new Error(`Unsupported TGA image type: ${imageType}`);
  }
  if (width < 1 || height < 1 || width * height > MAX_SOURCE_PIXELS) {
    throw new Error('Invalid TGA dimensions or pixel limit exceeded');
  }

  const validTrueColor = !isGray && (pixelDepth === 24 || pixelDepth === 32) &&
    (alphaBits === 0 || (pixelDepth === 32 && alphaBits === 8));
  const validGray = isGray && (pixelDepth === 8 || pixelDepth === 16) &&
    (alphaBits === 0 || (pixelDepth === 16 && alphaBits === 8));
  if (!validTrueColor && !validGray) {
    throw new Error(`Unsupported TGA pixel depth/alpha: ${pixelDepth}/${alphaBits}`);
  }

  const bytesPerPixel = pixelDepth / 8;
  const offset = 18 + idLength;
  const pixelCount = width * height;
  const requiredBytes = offset + (isRle ? 0 : pixelCount * bytesPerPixel);
  if (buffer.length < requiredBytes) {
    throw new Error(`Invalid TGA: truncated pixel data (need ${requiredBytes} bytes)`);
  }

  const hasAlpha = alphaBits === 8;
  const channels = isGray ? (hasAlpha ? 2 : 1) : (hasAlpha ? 4 : 3);
  const rgba = Buffer.alloc(pixelCount * 4);
  const placePixel = (i: number, srcIdx: number): void => {
    const row = Math.floor(i / width);
    const column = i % width;
    const x = isRightToLeft ? width - column - 1 : column;
    const y = isTopDown ? row : height - row - 1;
    const destIdx = (y * width + x) * 4;
    if (isGray) {
      rgba[destIdx] = buffer[srcIdx];
      rgba[destIdx + 1] = buffer[srcIdx];
      rgba[destIdx + 2] = buffer[srcIdx];
      rgba[destIdx + 3] = hasAlpha ? buffer[srcIdx + 1] : 255;
    } else {
      rgba[destIdx] = buffer[srcIdx + 2];
      rgba[destIdx + 1] = buffer[srcIdx + 1];
      rgba[destIdx + 2] = buffer[srcIdx];
      rgba[destIdx + 3] = hasAlpha ? buffer[srcIdx + 3] : 255;
    }
  };

  if (isRle) {
    let srcIdx = offset;
    let pixelIndex = 0;
    while (pixelIndex < pixelCount) {
      if (srcIdx >= buffer.length) throw new Error('Invalid TGA: truncated RLE packet header');
      const packet = buffer[srcIdx++];
      const count = (packet & 0x7f) + 1;
      if (pixelIndex + count > pixelCount) {
        throw new Error('Invalid TGA: RLE packet exceeds image bounds');
      }
      const isRun = (packet & 0x80) !== 0;
      const byteCount = (isRun ? 1 : count) * bytesPerPixel;
      if (srcIdx + byteCount > buffer.length) {
        throw new Error('Invalid TGA: truncated RLE packet pixels');
      }
      for (let i = 0; i < count; i++) {
        placePixel(pixelIndex++, srcIdx + (isRun ? 0 : i * bytesPerPixel));
      }
      srcIdx += byteCount;
    }
  } else {
    for (let i = 0; i < pixelCount; i++) {
      placePixel(i, offset + i * bytesPerPixel);
    }
  }

  return { width, height, data: rgba, channels, hasAlpha };
}

async function encodeRasterThumbnail(
  decoded: DecodedRaster,
  targetWidth: number,
  targetHeight: number,
  quality: number
): Promise<Buffer> {
  return sharp(decoded.data, {
    raw: { width: decoded.width, height: decoded.height, channels: 4 },
  })
    .resize(targetWidth, targetHeight, {
      fit: IMAGE_THUMBNAIL_SPEC.fit,
      withoutEnlargement: IMAGE_THUMBNAIL_SPEC.withoutEnlargement,
    })
    .webp({ quality })
    .toBuffer();
}

export async function processImageBuffer(
  buffer: Buffer,
  extension: string,
  targetWidth = IMAGE_THUMBNAIL_SPEC.width,
  targetHeight = IMAGE_THUMBNAIL_SPEC.height,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<ImageProcessingResult> {
  const ext = extension.toLowerCase();
  const webpQuality = normalizeThumbnailQuality(quality);

  if (ext === '.tga') {
    const decoded = decodeTgaBuffer(buffer);
    return {
      metadata: {
        width: decoded.width,
        height: decoded.height,
        format: 'tga',
        channels: decoded.channels,
        hasAlpha: decoded.hasAlpha,
      },
      thumbnailBuffer: await encodeRasterThumbnail(decoded, targetWidth, targetHeight, webpQuality),
    };
  }

  if (ext === '.bmp') {
    const decoded = decodeBmpBuffer(buffer);
    return {
      metadata: {
        width: decoded.width,
        height: decoded.height,
        format: 'bmp',
        channels: decoded.channels,
        hasAlpha: decoded.hasAlpha,
      },
      thumbnailBuffer: await encodeRasterThumbnail(decoded, targetWidth, targetHeight, webpQuality),
    };
  }

  // Sharp reads the first page of animated images. Apply EXIF orientation
  // before resizing so the thumbnail and its reported dimensions agree.
  const image = sharp(buffer, {
    page: 0,
    pages: 1,
    limitInputPixels: MAX_SHARP_INPUT_PIXELS,
  });
  const sharpMeta = await image.metadata();
  const swapsAxes = [5, 6, 7, 8].includes(sharpMeta.orientation ?? 1);

  const thumbnailBuffer = await image
    .autoOrient()
    .resize(targetWidth, targetHeight, {
      fit: IMAGE_THUMBNAIL_SPEC.fit,
      withoutEnlargement: IMAGE_THUMBNAIL_SPEC.withoutEnlargement,
    })
    .webp({ quality: webpQuality })
    .toBuffer();

  const metadata: ImageMetadata = {
    width: swapsAxes ? sharpMeta.height : sharpMeta.width,
    height: swapsAxes ? sharpMeta.width : sharpMeta.height,
    format: sharpMeta.format || ext.replace('.', ''),
    colorSpace: sharpMeta.space,
    channels: sharpMeta.channels,
    hasAlpha: sharpMeta.hasAlpha,
    density: sharpMeta.density,
    orientation: sharpMeta.orientation,
  };

  return {
    metadata,
    thumbnailBuffer,
  };
}

export async function processImageFile(
  filePath: string,
  targetWidth = IMAGE_THUMBNAIL_SPEC.width,
  targetHeight = IMAGE_THUMBNAIL_SPEC.height,
  quality = DEFAULT_THUMBNAIL_QUALITY
): Promise<ImageProcessingResult> {
  const ext = path.extname(filePath);
  const buffer = await fs.promises.readFile(filePath);
  return processImageBuffer(buffer, ext, targetWidth, targetHeight, quality);
}
