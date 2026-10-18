import { afterEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import bmp from 'bmp-js';
import { openZipArchive } from '../server/src/services/archive.js';
import { processImageBuffer, processImageFile } from '../server/src/services/image.js';
import {
  cleanupTempDir,
  createTempDir,
  createTestTgaBuffer,
  createTestZipArchive,
  TINY_PNG_BUFFER,
} from './helpers.js';

type Rgb = readonly [number, number, number];

const blockColors: readonly (readonly Rgb[])[] = [
  [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  [[0, 255, 255], [255, 0, 255], [255, 255, 0]],
];

function colorGridPixels(blockSize = 30): { data: Buffer; width: number; height: number } {
  const width = blockSize * 3;
  const height = blockSize * 2;
  const data = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = blockColors[Math.floor(y / blockSize)][Math.floor(x / blockSize)];
      const offset = (y * width + x) * 3;
      data.set(color, offset);
    }
  }

  return { data, width, height };
}

async function pixelAt(buffer: Buffer, x: number, y: number): Promise<[number, number, number, number]> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

function expectColor(actual: readonly number[], expected: Rgb, tolerance = 55): void {
  for (let channel = 0; channel < 3; channel++) {
    expect(Math.abs(actual[channel] - expected[channel])).toBeLessThanOrEqual(tolerance);
  }
}

// Two 1x1 palette frames: red, then blue. Each LZW block starts with a clear
// code and ends with an end code, so the first-frame assertion is unambiguous.
function animatedGif(): Buffer {
  return Buffer.from([
    0x47, 0x49, 0x46, 0x38, 0x39, 0x61,
    0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00,
    0xff, 0x00, 0x00, 0x00, 0x00, 0xff,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x44, 0x01, 0x00,
    0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00,
    0x2c, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0x02, 0x02, 0x4c, 0x01, 0x00,
    0x3b,
  ]);
}

function pngWithHugeDimensions(): Buffer {
  const png = Buffer.from(TINY_PNG_BUFFER);
  png.writeUInt32BE(20_000, 16);
  png.writeUInt32BE(20_000, 20);

  // PNG IHDR CRC covers the chunk type and data (bytes 12 through 28).
  let crc = 0xffffffff;
  for (const byte of png.subarray(12, 29)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  png.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 29);
  return png;
}

describe('image preview consistency', () => {
  let tempDir: string | undefined;

  afterEach(() => {
    if (tempDir) cleanupTempDir(tempDir);
    tempDir = undefined;
  });

  it('applies EXIF orientation to JPEG pixels and reported dimensions', async () => {
    const { data, width, height } = colorGridPixels();
    const jpeg = await sharp(data, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
      .withMetadata({ orientation: 6 })
      .toBuffer();
    expect((await sharp(jpeg).metadata()).orientation).toBe(6);

    const result = await processImageBuffer(jpeg, '.jpg');
    const thumbnail = await sharp(result.thumbnailBuffer).metadata();
    expect([thumbnail.width, thumbnail.height]).toEqual([height, width]);
    expect([result.metadata.width, result.metadata.height]).toEqual([height, width]);
    expect(result.metadata.orientation).toBe(6);

    // EXIF orientation 6 rotates the source 90 degrees clockwise.
    const expected: readonly (readonly Rgb[])[] = [
      [[0, 255, 255], [255, 0, 0]],
      [[255, 0, 255], [0, 255, 0]],
      [[255, 255, 0], [0, 0, 255]],
    ];
    for (let row = 0; row < expected.length; row++) {
      for (let column = 0; column < expected[row].length; column++) {
        expectColor(await pixelAt(result.thumbnailBuffer, column * 30 + 15, row * 30 + 15), expected[row][column]);
      }
    }
  });

  it('preserves transparency in PNG previews', async () => {
    const width = 16;
    const height = 8;
    const pixels = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const offset = (y * width + x) * 4;
        pixels.set(x < width / 2 ? [255, 0, 0, 255] : [0, 0, 255, 0], offset);
      }
    }
    const png = await sharp(pixels, { raw: { width, height, channels: 4 } }).png().toBuffer();

    const result = await processImageBuffer(png, '.png');
    expect(result.metadata.hasAlpha).toBe(true);
    expect([result.metadata.width, result.metadata.height]).toEqual([width, height]);
    expect((await pixelAt(result.thumbnailBuffer, 3, 4))[3]).toBe(255);
    expect((await pixelAt(result.thumbnailBuffer, 12, 4))[3]).toBe(0);
    expectColor(await pixelAt(result.thumbnailBuffer, 3, 4), [255, 0, 0]);
  });

  it('uses the first frame of an animated GIF for its still preview', async () => {
    const gif = animatedGif();
    expect((await sharp(gif).metadata()).pages).toBe(2);

    const result = await processImageBuffer(gif, '.gif');
    expect(result.metadata.format).toBe('gif');
    expect([result.metadata.width, result.metadata.height]).toEqual([1, 1]);
    expectColor(await pixelAt(result.thumbnailBuffer, 0, 0), [255, 0, 0]);
  });

  it('uses an SVG viewBox as its intrinsic size and preserves aspect ratio', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">' +
      '<rect width="60" height="60" fill="red"/>' +
      '<rect x="60" width="60" height="60" fill="blue"/></svg>'
    );

    const result = await processImageBuffer(svg, '.svg', 72, 72);
    expect([result.metadata.width, result.metadata.height]).toEqual([120, 60]);
    expect(result.metadata.format).toBe('svg');
    const thumbnail = await sharp(result.thumbnailBuffer).metadata();
    expect([thumbnail.width, thumbnail.height]).toEqual([72, 36]);
    expectColor(await pixelAt(result.thumbnailBuffer, 12, 18), [255, 0, 0]);
    expectColor(await pixelAt(result.thumbnailBuffer, 60, 18), [0, 0, 255]);
  });

  it('produces identical disk, extracted-buffer, and ZIP-entry previews', async () => {
    tempDir = createTempDir('media-consistency-');
    const { data, width, height } = colorGridPixels();
    const png = await sharp(data, { raw: { width, height, channels: 3 } }).png().toBuffer();
    const bmpPixels = Buffer.alloc(4 * 4 * 4, 255);
    const fixtures = [
      { name: 'colors.png', bytes: png },
      { name: 'colors.tga', bytes: createTestTgaBuffer(4, 4, true) },
      { name: 'colors.bmp', bytes: bmp.encode({ data: bmpPixels, width: 4, height: 4 }).data },
    ];
    const zipPath = path.join(tempDir, 'assets.zip');
    createTestZipArchive(zipPath, fixtures.map(({ name, bytes }) => ({
      name: `nested/${name}`, content: bytes,
    })));
    const inventory = await openZipArchive(zipPath, 'assets.zip', 'fixture');
    expect(inventory.entries).toHaveLength(fixtures.length);

    for (const { name, bytes } of fixtures) {
      const diskPath = path.join(tempDir, name);
      fs.writeFileSync(diskPath, bytes);
      const disk = await processImageFile(diskPath, undefined, undefined, 67);
      const entry = inventory.entries.find((candidate) => candidate.entryName.endsWith(name));
      expect(entry).toBeDefined();
      const archive = await inventory.processEntry(entry!, { quality: 67 });
      const extracted = await processImageBuffer(bytes, path.extname(name), undefined, undefined, 67);

      expect(archive.metadata).toEqual(disk.metadata);
      expect(archive.thumbnailBuffer.equals(disk.thumbnailBuffer)).toBe(true);
      expect(extracted.metadata).toEqual(disk.metadata);
      expect(extracted.thumbnailBuffer.equals(disk.thumbnailBuffer)).toBe(true);
    }
  });

  it.each([
    ['raster PNG', pngWithHugeDimensions(), '.png'],
    ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="20000"/>'), '.svg'],
  ])('rejects an oversized %s before decoding pixels', async (_label, input, extension) => {
    await expect(processImageBuffer(input, extension)).rejects.toThrow(/pixel|size|limit|large|dimension/i);
  });

  it.each([
    ['TGA', '.tga'],
    ['BMP', '.bmp'],
  ])('reports %s decode failures with format context', async (format, extension) => {
    await expect(processImageBuffer(TINY_PNG_BUFFER, extension)).rejects.toThrow(new RegExp(format, 'i'));
  });
});
