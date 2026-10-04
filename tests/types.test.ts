import { describe, it, expect } from 'vitest';
import {
  Asset,
  AssetStack,
  AppSettings,
  CopyAssetRequest,
  CopyAssetResult,
  ScanProgressEvent,
} from '../shared/types.js';

describe('Shared Data Types and Contracts', () => {
  it('should validate Asset structure and fields', () => {
    const asset: Asset = {
      id: 'test_asset',
      path: 'sprites/hero.png',
      absolutePath: '/full/path/sprites/hero.png',
      name: 'hero.png',
      extension: '.png',
      category: 'image',
      size: 1024,
      mtime: Date.now(),
      hash: 'hash_val',
      isArchiveEntry: false,
      thumbnailUrl: '/api/assets/test_asset/thumbnail',
      fileUrl: '/api/assets/test_asset/file',
      metadata: { width: 64, height: 64, format: 'png' },
      tags: ['hero', 'pixel-art'],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    expect(asset.category).toBe('image');
    expect(asset.isArchiveEntry).toBe(false);
    expect(asset.tags).toContain('hero');
  });

  it('should validate AssetStack structure with animation type', () => {
    const stack: AssetStack = {
      id: 'stack_hero_walk',
      name: 'Hero Walk',
      type: 'animation',
      itemCount: 4,
      representativeAssetId: 'hero_01',
      tags: ['hero', 'walk'],
      metadata: { fps: 12 },
      createdAt: Date.now(),
    };

    expect(stack.type).toBe('animation');
    expect(stack.itemCount).toBe(4);
    expect(stack.metadata?.fps).toBe(12);
  });

  it('should validate ScanProgressEvent states', () => {
    const events: ScanProgressEvent[] = [
      { status: 'idle', libraryPath: '', scannedCount: 0, indexedCount: 0 },
      { status: 'scanning', libraryPath: '/path', scannedCount: 10, indexedCount: 5 },
      { status: 'completed', libraryPath: '/path', scannedCount: 10, indexedCount: 10 },
      { status: 'error', libraryPath: '/path', scannedCount: 0, indexedCount: 0, error: 'fail' },
    ];

    expect(events.map((e) => e.status)).toEqual(['idle', 'scanning', 'completed', 'error']);
  });
});
