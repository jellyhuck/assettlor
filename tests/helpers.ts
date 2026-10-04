import fs from 'fs';
import path from 'path';
import os from 'os';
import AdmZip from 'adm-zip';
import { closeDatabase, initDatabase } from '../server/src/db/database.js';

export function createTempDir(prefix = 'assettlor-test-'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

export function cleanupTempDir(dir: string): void {
  try {
    closeDatabase();
  } catch {
    // ignore
  }
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export function createTestZipArchive(destPath: string, files: { name: string; content: Buffer | string }[]): string {
  const zip = new AdmZip();
  for (const f of files) {
    const data = typeof f.content === 'string' ? Buffer.from(f.content) : f.content;
    zip.addFile(f.name, data);
  }
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  zip.writeZip(destPath);
  return destPath;
}

// Minimal valid 1x1 RGBA PNG buffer
export const TINY_PNG_BUFFER = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

// Minimal valid 1-second 8kHz mono 16-bit PCM WAV buffer
export function createTestWavBuffer(durationSec = 0.1, sampleRate = 8000): Buffer {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const numSamples = Math.floor(sampleRate * durationSec);
  const dataSize = numSamples * blockAlign;
  const buffer = Buffer.alloc(44 + dataSize);

  // RIFF identifier
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);

  // fmt subchunk
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // Subchunk1Size
  buffer.writeUInt16LE(1, 20); // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  // data subchunk
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Sine wave samples
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const sample = Math.sin(2 * Math.PI * 440 * t) * 32767 * 0.5;
    buffer.writeInt16LE(Math.floor(sample), 44 + i * 2);
  }

  return buffer;
}

// Minimal valid 2x2 24-bit uncompressed TGA buffer
export function createTestTgaBuffer(width = 2, height = 2, topDown = false): Buffer {
  const header = Buffer.alloc(18);
  header[2] = 2; // uncompressed true-color image
  header.writeUInt16LE(width, 12);
  header.writeUInt16LE(height, 14);
  header[16] = 24; // 24-bit RGB
  if (topDown) {
    header[17] = 0x20; // top-down descriptor bit
  }

  const pixelData = Buffer.alloc(width * height * 3);
  // Fill with dummy BGR colors
  for (let i = 0; i < pixelData.length; i += 3) {
    pixelData[i] = 255; // Blue
    pixelData[i + 1] = 0; // Green
    pixelData[i + 2] = 128; // Red
  }

  return Buffer.concat([header, pixelData]);
}
