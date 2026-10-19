import { describe, it, expect } from 'vitest';
import {
  Asset,
  AssetStack,
  AppSettings,
  CopyAssetRequest,
  CopyAssetResult,
  ScanProgressEvent,
  getImageDisplayUrl,
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

  it('should validate AppSettings with multiple libraryPaths and projectPaths', () => {
    const settings: AppSettings = {
      libraryPath: '/lib1',
      libraryPaths: ['/lib1', '/lib2'],
      activeProjectPath: '/proj1',
      projectPaths: ['/proj1', '/proj2', '/proj3'],
      thumbnailQuality: 80,
      autoStackAnimations: true,
      autoStackAudio: true,
      defaultFps: 12,
      catalogPaging: 'load-more',
    };

    expect(settings.libraryPaths).toHaveLength(2);
    expect(settings.projectPaths).toHaveLength(3);
    expect(settings.activeProjectPath).toBe(settings.projectPaths[0]);
    expect(settings.libraryPath).toBe(settings.libraryPaths[0]);
  });

  describe('getImageDisplayUrl', () => {
    it('should prioritize thumbnailUrl for TGA assets because browsers do not support TGA in img tags', () => {
      const tgaAsset = {
        extension: '.tga',
        fileUrl: '/api/assets/tile_tga/file',
        thumbnailUrl: '/api/assets/tile_tga/thumbnail',
      };
      expect(getImageDisplayUrl(tgaAsset)).toBe('/api/assets/tile_tga/thumbnail');
    });

    it('should prioritize fileUrl for browser-supported images like PNG or JPEG', () => {
      const pngAsset = {
        extension: '.png',
        fileUrl: '/api/assets/hero_png/file',
        thumbnailUrl: '/api/assets/hero_png/thumbnail',
      };
      expect(getImageDisplayUrl(pngAsset)).toBe('/api/assets/hero_png/file');
    });

    it('should prioritize thumbnailUrl for PNG when preferThumbnail is true', () => {
      const pngAsset = {
        extension: '.png',
        fileUrl: '/api/assets/hero_png/file',
        thumbnailUrl: '/api/assets/hero_png/thumbnail',
      };
      expect(getImageDisplayUrl(pngAsset, true)).toBe('/api/assets/hero_png/thumbnail');
    });

    it('should fallback gracefully when thumbnailUrl or fileUrl is missing', () => {
      expect(getImageDisplayUrl(null)).toBe('');
      expect(getImageDisplayUrl(undefined)).toBe('');

      const tgaNoThumb = {
        extension: '.tga',
        fileUrl: '/api/assets/raw_tga/file',
        thumbnailUrl: '',
      };
      expect(getImageDisplayUrl(tgaNoThumb)).toBe('/api/assets/raw_tga/file');

      const pngNoFile = {
        extension: '.png',
        fileUrl: '',
        thumbnailUrl: '/api/assets/raw_png/thumbnail',
      };
      expect(getImageDisplayUrl(pngNoFile)).toBe('/api/assets/raw_png/thumbnail');
    });
  });
});

