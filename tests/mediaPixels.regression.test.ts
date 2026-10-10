import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeBmpBuffer, processImageBuffer } from '../server/src/services/image.js';

type Pixel = readonly [number, number, number, number];

function makeBmp(
  width: number,
  height: number,
  pixels: Pixel[],
  bitDepth: 24 | 32,
  topDown = false
): Buffer {
  const bytesPerPixel = bitDepth / 8;
  const stride = Math.ceil(width * bytesPerPixel / 4) * 4;
  const dataOffset = 54;
  const buffer = Buffer.alloc(dataOffset + stride * height);
  buffer.write('BM', 0);
  buffer.writeUInt32LE(buffer.length, 2);
  buffer.writeUInt32LE(dataOffset, 10);
  buffer.writeUInt32LE(40, 14);
  buffer.writeInt32LE(width, 18);
  buffer.writeInt32LE(topDown ? -height : height, 22);
  buffer.writeUInt16LE(1, 26);
  buffer.writeUInt16LE(bitDepth, 28);
  buffer.writeUInt32LE(stride * height, 34);

  for (let fileY = 0; fileY < height; fileY++) {
    const displayY = topDown ? fileY : height - fileY - 1;
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixels[displayY * width + x];
      const offset = dataOffset + fileY * stride + x * bytesPerPixel;
      buffer[offset] = b;
      buffer[offset + 1] = g;
      buffer[offset + 2] = r;
      if (bitDepth === 32) buffer[offset + 3] = a;
    }
  }
  return buffer;
}

function decodedPixels(buffer: Buffer): number[][] {
  const decoded = decodeBmpBuffer(buffer);
  const pixels: number[][] = [];
  for (let i = 0; i < decoded.data.length; i += 4) {
    pixels.push([...decoded.data.subarray(i, i + 4)]);
  }
  return pixels;
}

describe('BMP pixel normalization', () => {
  it.each([
    ['red', [255, 0, 0, 255]],
    ['green', [0, 255, 0, 255]],
    ['blue', [0, 0, 255, 255]],
    ['white', [255, 255, 255, 255]],
  ] as const)('preserves %s 24-bit pixels as opaque RGBA', async (_name, pixel) => {
    const bmp = makeBmp(1, 1, [pixel], 24);
    expect(decodedPixels(bmp)).toEqual([pixel]);
    const result = await processImageBuffer(bmp, '.bmp', 1, 1, 100);
    expect(result.metadata).toMatchObject({ channels: 3, hasAlpha: false });
    const { data } = await sharp(result.thumbnailBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let channel = 0; channel < 3; channel++) {
      expect(Math.abs(data[channel] - pixel[channel])).toBeLessThan(25);
    }
    expect(data[3]).toBe(255);
  });

  it.each([false, true])('preserves asymmetric colors, row padding, and topDown=%s', (topDown) => {
    const pixels: Pixel[] = [
      [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
      [255, 255, 255, 255], [255, 128, 0, 255], [30, 90, 210, 255],
    ];
    const bmp = makeBmp(3, 2, pixels, 24, topDown);
    expect(decodedPixels(bmp)).toEqual(pixels);
  });

  it('preserves meaningful 32-bit alpha and treats reserved zero alpha as opaque', async () => {
    const translucent: Pixel[] = [[200, 40, 20, 96], [20, 90, 220, 255]];
    const alphaBmp = makeBmp(2, 1, translucent, 32);
    expect(decodedPixels(alphaBmp)).toEqual(translucent);
    const alphaResult = await processImageBuffer(alphaBmp, '.bmp', 2, 1, 100);
    expect(alphaResult.metadata).toMatchObject({ channels: 4, hasAlpha: true });
    const { data } = await sharp(alphaResult.thumbnailBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(Math.abs(data[3] - 96)).toBeLessThan(8);
    expect(data[7]).toBe(255);

    const opaqueBmp = makeBmp(1, 1, [[200, 40, 20, 0]], 32);
    expect(decodedPixels(opaqueBmp)).toEqual([[200, 40, 20, 255]]);
    const opaqueResult = await processImageBuffer(opaqueBmp, '.bmp');
    expect(opaqueResult.metadata).toMatchObject({ channels: 3, hasAlpha: false });
  });
});
