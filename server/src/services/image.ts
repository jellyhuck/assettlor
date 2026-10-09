import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import type { ImageMetadata } from '../../../shared/types.js';
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
  targetWidth = 400,
  targetHeight = 400
): Promise<ImageProcessingResult> {
  const ext = extension.toLowerCase();

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
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
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
    try {
      const bmpData = bmp.decode(buffer);
      const rawBuf = Buffer.from(bmpData.data);

      const sharpInstance = sharp(rawBuf, {
        raw: {
          width: bmpData.width,
          height: bmpData.height,
          channels: 4,
        },
      });

      const thumbnailBuffer = await sharpInstance
        .resize(targetWidth, targetHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ quality: 85 })
        .toBuffer();

      return {
        metadata: {
          width: bmpData.width,
          height: bmpData.height,
          format: 'bmp',
          channels: 4,
          hasAlpha: false,
        },
        thumbnailBuffer,
      };
    } catch {
      // fallback to standard sharp
    }
  }

  // Standard sharp pipeline for PNG, JPG, WEBP, GIF, SVG
  const image = sharp(buffer);
  const sharpMeta = await image.metadata();

  const thumbnailBuffer = await image
    .resize(targetWidth, targetHeight, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: 85 })
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
  targetWidth = 400,
  targetHeight = 400
): Promise<ImageProcessingResult> {
  const ext = path.extname(filePath);
  const buffer = await fs.promises.readFile(filePath);
  return processImageBuffer(buffer, ext, targetWidth, targetHeight);
}
