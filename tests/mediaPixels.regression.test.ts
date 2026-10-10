import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { decodeBmpBuffer, decodeTgaBuffer, processImageBuffer } from '../server/src/services/image.js';

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

function makeTga(
  width: number,
  height: number,
  pixels: Pixel[],
  pixelDepth: 24 | 32 = 24,
  topDown = false,
  rightToLeft = false
): Buffer {
  const bytesPerPixel = pixelDepth / 8;
  const header = Buffer.alloc(18);
  header[2] = 2;
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = pixelDepth;
  header[17] = (topDown ? 0x20 : 0) | (rightToLeft ? 0x10 : 0) |
    (pixelDepth === 32 ? 8 : 0);
  const data = Buffer.alloc(width * height * bytesPerPixel);
  for (let fileY = 0; fileY < height; fileY++) {
    for (let fileX = 0; fileX < width; fileX++) {
      const x = rightToLeft ? width - fileX - 1 : fileX;
      const y = topDown ? fileY : height - fileY - 1;
      const [r, g, b, a] = pixels[y * width + x];
      const offset = (fileY * width + fileX) * bytesPerPixel;
      data[offset] = b;
      data[offset + 1] = g;
      data[offset + 2] = r;
      if (pixelDepth === 32) data[offset + 3] = a;
    }
  }
  return Buffer.concat([header, data]);
}

function makeRleTga(
  uncompressed: Buffer,
  packets: { kind: 'raw' | 'run'; count: number }[]
): Buffer {
  const header = Buffer.from(uncompressed.subarray(0, 18));
  header[2] = header[2] === 2 ? 10 : 11;
  const bytesPerPixel = header[16] / 8;
  const chunks: Buffer[] = [header];
  let pixelIndex = 0;
  for (const { kind, count } of packets) {
    if (count < 1 || count > 128) throw new Error('Invalid test packet');
    chunks.push(Buffer.from([(kind === 'run' ? 0x80 : 0) | (count - 1)]));
    const start = 18 + pixelIndex * bytesPerPixel;
    const end = start + (kind === 'run' ? 1 : count) * bytesPerPixel;
    chunks.push(uncompressed.subarray(start, end));
    pixelIndex += count;
  }
  return Buffer.concat(chunks);
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

describe('TGA header and pixel normalization', () => {
  const pixels: Pixel[] = [
    [255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255],
    [255, 255, 255, 255], [255, 128, 0, 255], [30, 90, 210, 255],
  ];

  it.each([
    [false, false], [false, true], [true, false], [true, true],
  ])('maps topDown=%s and rightToLeft=%s into display order', (topDown, rightToLeft) => {
    const decoded = decodeTgaBuffer(makeTga(3, 2, pixels, 24, topDown, rightToLeft));
    const output: number[][] = [];
    for (let i = 0; i < decoded.data.length; i += 4) {
      output.push([...decoded.data.subarray(i, i + 4)]);
    }
    expect(output).toEqual(pixels);
    expect(decoded).toMatchObject({ width: 3, height: 2, channels: 3, hasAlpha: false });
  });

  it('preserves 32-bit alpha and grayscale source metadata', async () => {
    const color = makeTga(1, 1, [[220, 40, 80, 72]], 32, true);
    const decoded = decodeTgaBuffer(color);
    expect([...decoded.data]).toEqual([220, 40, 80, 72]);
    const result = await processImageBuffer(color, '.tga');
    expect(result.metadata).toMatchObject({ channels: 4, hasAlpha: true });

    const gray = Buffer.alloc(20);
    gray[2] = 3;
    gray.writeUInt16LE(1, 12);
    gray.writeUInt16LE(1, 14);
    gray[16] = 16;
    gray[17] = 8;
    gray[18] = 90;
    gray[19] = 120;
    expect([...decodeTgaBuffer(gray).data]).toEqual([90, 90, 90, 120]);
    expect(decodeTgaBuffer(gray)).toMatchObject({ channels: 2, hasAlpha: true });
  });

  it('rejects truncated headers, IDs, pixels, unsupported depths, and huge dimensions', async () => {
    const valid = makeTga(1, 1, [[255, 0, 0, 255]]);
    const withId = Buffer.from(valid);
    withId[0] = 10;
    const colorMap = Buffer.from(valid);
    colorMap[1] = 1;
    const badDepth = Buffer.from(valid);
    badDepth[16] = 16;
    const interleaved = Buffer.from(valid);
    interleaved[17] = 0x40;
    const huge = Buffer.from(valid);
    huge.writeUInt16LE(65535, 12);
    huge.writeUInt16LE(65535, 14);
    const cases: [Buffer, RegExp][] = [
      [Buffer.alloc(17), /TGA.*header/],
      [withId, /TGA.*truncated/],
      [valid.subarray(0, valid.length - 1), /TGA.*truncated/],
      [colorMap, /TGA color map/],
      [badDepth, /TGA pixel depth/],
      [interleaved, /TGA interleaving/],
      [huge, /TGA dimensions/],
    ];
    for (const [input, message] of cases) {
      expect(() => decodeTgaBuffer(input)).toThrow(message);
      await expect(processImageBuffer(input, '.tga')).rejects.toThrow(message);
    }
  });
});

describe('TGA RLE decoding', () => {
  it('matches uncompressed true-color pixels across raw and run packets', async () => {
    const pixels: Pixel[] = [
      [255, 0, 0, 255], [255, 0, 0, 255], [255, 0, 0, 255],
      [0, 255, 0, 255], [0, 0, 255, 255], [0, 0, 255, 255],
    ];
    const uncompressed = makeTga(6, 1, pixels, 24, true);
    const compressed = makeRleTga(uncompressed, [
      { kind: 'run', count: 3 }, { kind: 'raw', count: 2 }, { kind: 'run', count: 1 },
    ]);
    expect(decodeTgaBuffer(compressed)).toEqual(decodeTgaBuffer(uncompressed));
    const rawPreview = await processImageBuffer(uncompressed, '.tga');
    const rlePreview = await processImageBuffer(compressed, '.tga');
    expect(rlePreview.metadata).toEqual(rawPreview.metadata);
    expect(rlePreview.thumbnailBuffer.equals(rawPreview.thumbnailBuffer)).toBe(true);
    expect(compressed[2]).toBe(10);
  });

  it('decodes 128-pixel packet boundaries and right-to-left origins', () => {
    const pixels: Pixel[] = Array.from({ length: 130 }, (_, index) =>
      [index, 255 - index, (index * 7) % 256, 255]
    );
    const uncompressed = makeTga(130, 1, pixels, 24, true, true);
    const compressed = makeRleTga(uncompressed, [
      { kind: 'raw', count: 128 }, { kind: 'raw', count: 2 },
    ]);
    expect(decodeTgaBuffer(compressed)).toEqual(decodeTgaBuffer(uncompressed));

    const repeated = makeTga(129, 1, Array(129).fill([90, 30, 210, 255]), 24, true);
    expect(decodeTgaBuffer(makeRleTga(repeated, [
      { kind: 'run', count: 128 }, { kind: 'run', count: 1 },
    ]))).toEqual(decodeTgaBuffer(repeated));
  });

  it('decodes grayscale raw/run packets', async () => {
    const header = Buffer.alloc(18);
    header[2] = 3;
    header.writeUInt16LE(4, 12);
    header.writeUInt16LE(1, 14);
    header[16] = 8;
    header[17] = 0x20;
    const uncompressed = Buffer.concat([header, Buffer.from([20, 40, 100, 100])]);
    const compressed = makeRleTga(uncompressed, [
      { kind: 'raw', count: 2 }, { kind: 'run', count: 2 },
    ]);
    expect(compressed[2]).toBe(11);
    expect(decodeTgaBuffer(compressed)).toEqual(decodeTgaBuffer(uncompressed));
    const result = await processImageBuffer(compressed, '.tga');
    expect(result.metadata).toMatchObject({ format: 'tga', channels: 1, hasAlpha: false });
    expect((await sharp(result.thumbnailBuffer).metadata()).format).toBe('webp');
  });

  it('rejects packet overruns and truncated headers or pixels', () => {
    const pixels: Pixel[] = Array(3).fill([10, 20, 30, 255]);
    const source = makeTga(3, 1, pixels, 24, true);
    const compressed = makeRleTga(source, [{ kind: 'run', count: 3 }]);
    const overrun = Buffer.from(compressed);
    overrun[18] = 0x83;
    expect(() => decodeTgaBuffer(overrun)).toThrow(/RLE packet exceeds/);
    expect(() => decodeTgaBuffer(compressed.subarray(0, 18))).toThrow(/truncated RLE packet header/);
    expect(() => decodeTgaBuffer(compressed.subarray(0, 20))).toThrow(/truncated RLE packet pixels/);
    const raw = makeRleTga(source, [{ kind: 'raw', count: 3 }]);
    expect(() => decodeTgaBuffer(raw.subarray(0, raw.length - 1))).toThrow(/truncated RLE packet pixels/);
  });
});
