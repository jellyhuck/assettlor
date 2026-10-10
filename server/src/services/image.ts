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

const MAX_SOURCE_PIXELS = 64_000_000;

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

// Pure Node.js TGA decoder without browser canvas dependency
function decodeTgaBuffer(buffer: Buffer): { width: number; height: number; data: Buffer } {
  const idLength = buffer[0];
  const imageType = buffer[2];
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  const isTopDown = (descriptor & 0x20) !== 0;

  if (imageType !== 2 && imageType !== 3) {
    throw new Error(`Unsupported TGA format type: ${imageType}`);
  }

  const bytesPerPixel = Math.floor(pixelDepth / 8);
  const offset = 18 + idLength;
  const rgba = Buffer.alloc(width * height * 4);

  let srcIdx = offset;
  for (let i = 0; i < width * height; i++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 255;

    if (imageType === 3) {
      const gray = buffer[srcIdx] || 0;
      r = gray;
      g = gray;
      b = gray;
      srcIdx += bytesPerPixel;
    } else {
      b = buffer[srcIdx] || 0;
      g = buffer[srcIdx + 1] || 0;
      r = buffer[srcIdx + 2] || 0;
      a = bytesPerPixel === 4 ? buffer[srcIdx + 3] : 255;
      srcIdx += bytesPerPixel;
    }

    const destIdx = i * 4;
    rgba[destIdx] = r;
    rgba[destIdx + 1] = g;
    rgba[destIdx + 2] = b;
    rgba[destIdx + 3] = a;
  }

  // TGA files are often stored bottom-to-top unless bit 5 of descriptor is set
  if (!isTopDown) {
    const rowSize = width * 4;
    const flipped = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      const srcRow = (height - 1 - y) * rowSize;
      const destRow = y * rowSize;
      rgba.copy(flipped, destRow, srcRow, srcRow + rowSize);
    }
    return { width, height, data: flipped };
  }

  return { width, height, data: rgba };
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
    try {
      const decoded = decodeTgaBuffer(buffer);
      const sharpInstance = sharp(decoded.data, {
        raw: {
          width: decoded.width,
          height: decoded.height,
          channels: 4,
        },
      });

      const thumbnailBuffer = await sharpInstance
        .resize(targetWidth, targetHeight, {
          fit: IMAGE_THUMBNAIL_SPEC.fit,
          withoutEnlargement: IMAGE_THUMBNAIL_SPEC.withoutEnlargement,
        })
        .webp({ quality: webpQuality })
        .toBuffer();

      return {
        metadata: {
          width: decoded.width,
          height: decoded.height,
          format: 'tga',
          channels: 4,
          hasAlpha: true,
        },
        thumbnailBuffer,
      };
    } catch (err) {
      console.warn('TGA processing error:', err);
    }
  }

  if (ext === '.bmp') {
    const decoded = decodeBmpBuffer(buffer);
    const sharpInstance = sharp(decoded.data, {
      raw: {
        width: decoded.width,
        height: decoded.height,
        channels: 4,
      },
    });

    const thumbnailBuffer = await sharpInstance
      .resize(targetWidth, targetHeight, {
        fit: IMAGE_THUMBNAIL_SPEC.fit,
        withoutEnlargement: IMAGE_THUMBNAIL_SPEC.withoutEnlargement,
      })
      .webp({ quality: webpQuality })
      .toBuffer();

    return {
      metadata: {
        width: decoded.width,
        height: decoded.height,
        format: 'bmp',
        channels: decoded.channels,
        hasAlpha: decoded.hasAlpha,
      },
      thumbnailBuffer,
    };
  }

  // Standard sharp pipeline for PNG, JPG, WEBP, GIF, SVG
  const image = sharp(buffer);
  const sharpMeta = await image.metadata();

  const thumbnailBuffer = await image
    .resize(targetWidth, targetHeight, {
      fit: IMAGE_THUMBNAIL_SPEC.fit,
      withoutEnlargement: IMAGE_THUMBNAIL_SPEC.withoutEnlargement,
    })
    .webp({ quality: webpQuality })
    .toBuffer();

  const metadata: ImageMetadata = {
    width: sharpMeta.width,
    height: sharpMeta.height,
    format: sharpMeta.format || ext.replace('.', ''),
    colorSpace: sharpMeta.space,
    channels: sharpMeta.channels,
    hasAlpha: sharpMeta.hasAlpha,
    density: sharpMeta.density,
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
