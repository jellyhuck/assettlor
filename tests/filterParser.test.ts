import { describe, it, expect } from 'vitest';
import {
  preprocessSearchQuery,
  compileFilterExpression,
} from '../server/src/services/filterParser.js';

describe('Filter Expression Parser (Liqe + Bytes)', () => {
  describe('preprocessSearchQuery', () => {
    it('should convert shorthand #tag to tag:tag', () => {
      expect(preprocessSearchQuery('#coin')).toBe('tag:coin');
      expect(preprocessSearchQuery('knight #pixel-art')).toBe('knight tag:pixel-art');
    });

    it('should convert size:2MB+ to size:>=2MB', () => {
      expect(preprocessSearchQuery('size:2MB+')).toBe('size:>=2MB');
      expect(preprocessSearchQuery('tag:coin size:500KB+')).toBe('tag:coin size:>=500KB');
    });

    it('should convert size:10MB- to size:<=10MB', () => {
      expect(preprocessSearchQuery('size:10MB-')).toBe('size:<=10MB');
    });

    it('should convert res:64x64+ to res:>=64x64 and res:128+ to res:>=128', () => {
      expect(preprocessSearchQuery('res:64x64+')).toBe('res:>=64x64');
      expect(preprocessSearchQuery('resolution:1920x1080-')).toBe('resolution:<=1920x1080');
      expect(preprocessSearchQuery('res:128+')).toBe('res:>=128');
    });

    it('should convert human units in range expressions', () => {
      expect(preprocessSearchQuery('size:[100KB TO 2MB]')).toBe('size:[102400 TO 2097152]');
    });
  });

  describe('compileFilterExpression - Size Filters', () => {
    it('should compile size:<2MB comparison', () => {
      const res = compileFilterExpression('size:<2MB', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('a.size < ?');
      expect(res.args).toEqual([2097152]);
    });

    it('should compile size:>500KB comparison', () => {
      const res = compileFilterExpression('size:>500KB', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('a.size > ?');
      expect(res.args).toEqual([512000]);
    });

    it('should compile size:>=1MB comparison', () => {
      const res = compileFilterExpression('size:>=1MB', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('a.size >= ?');
      expect(res.args).toEqual([1048576]);
    });

    it('should compile size:2MB+ via pre-processor', () => {
      const res = compileFilterExpression('size:2MB+', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('a.size >= ?');
      expect(res.args).toEqual([2097152]);
    });

    it('should compile size:[100KB TO 2MB] range query', () => {
      const res = compileFilterExpression('size:[100KB TO 2MB]', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toBe('(a.size >= ? AND a.size <= ?)');
      expect(res.args).toEqual([102400, 2097152]);
    });
  });

  describe('compileFilterExpression - Tags, Formats & Categories', () => {
    it('should compile tag:coin in flat and stacked views', () => {
      const flat = compileFilterExpression('tag:coin', false);
      expect(flat.sql).toContain('EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)');
      expect(flat.args).toEqual(['coin']);

      const stacked = compileFilterExpression('tag:coin', true);
      expect(stacked.sql).toContain('a.stack_id IS NOT NULL');
      expect(stacked.args).toEqual(['coin', 'coin']);
    });

    it('should compile ext:png and format:wav', () => {
      const extRes = compileFilterExpression('ext:png', false);
      expect(extRes.sql).toBe('LOWER(a.extension) = ?');
      expect(extRes.args).toEqual(['.png']);

      const fmtRes = compileFilterExpression('format:.wav', false);
      expect(fmtRes.sql).toBe('LOWER(a.extension) = ?');
      expect(fmtRes.args).toEqual(['.wav']);
    });

    it('should compile cat:image and type:audio', () => {
      const imgRes = compileFilterExpression('cat:image', false);
      expect(imgRes.sql).toBe('a.category = ?');
      expect(imgRes.args).toEqual(['image']);

      const audStacked = compileFilterExpression('type:audio', true);
      expect(audStacked.sql).toBe("(a.category = 'audio' OR s.type = 'audio_variation')");
    });

    it('should compile path and in queries', () => {
      const pathRes = compileFilterExpression('path:monsters', false);
      expect(pathRes.sql).toBe('LOWER(a.path) LIKE ?');
      expect(pathRes.args).toEqual(['%monsters%']);
    });

    it('should compile boolean is:archive and is:stacked flags', () => {
      const archRes = compileFilterExpression('is:archive', false);
      expect(archRes.sql).toBe('a.is_archive_entry = 1');

      const diskRes = compileFilterExpression('is:disk', false);
      expect(diskRes.sql).toBe('a.is_archive_entry = 0');

      const stackRes = compileFilterExpression('is:stacked', false);
      expect(stackRes.sql).toBe('a.stack_id IS NOT NULL');
    });
  });

  describe('compileFilterExpression - Dimensions & Duration', () => {
    it('should compile width:>128 and height:<=64', () => {
      const wRes = compileFilterExpression('width:>128', false);
      expect(wRes.sql).toBe("CAST(json_extract(a.metadata, '$.width') AS NUMERIC) > ?");
      expect(wRes.args).toEqual([128]);

      const hRes = compileFilterExpression('h:<=64', false);
      expect(hRes.sql).toBe("CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= ?");
      expect(hRes.args).toEqual([64]);
    });

    it('should compile duration expressions with units', () => {
      const durRes = compileFilterExpression('dur:>5s', false);
      expect(durRes.sql).toBe("CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) > ?");
      expect(durRes.args).toEqual([5]);

      const minRes = compileFilterExpression('duration:<1.5m', false);
      expect(minRes.sql).toBe("CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) < ?");
      expect(minRes.args).toEqual([90]);
    });
  });

  describe('compileFilterExpression - Boolean Operators & Negation', () => {
    it('should compile tag:coin OR tag:gem', () => {
      const res = compileFilterExpression('tag:coin OR tag:gem', false);
      expect(res.sql).toBe(
        '((EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)) OR (EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)))'
      );
      expect(res.args).toEqual(['coin', 'gem']);
    });

    it('should compile conjunctions and groupings: (tag:a OR tag:b) AND size:<1MB', () => {
      const res = compileFilterExpression('(tag:a OR tag:b) AND size:<1MB', false);
      expect(res.sql).toContain(')) OR (EXISTS');
      expect(res.sql).toContain('AND (a.size < ?))');
      expect(res.args).toEqual(['a', 'b', 1048576]);
    });

    it('should compile negative filters: NOT ext:wav and -tag:ui', () => {
      const notExt = compileFilterExpression('NOT ext:wav', false);
      expect(notExt.sql).toBe('NOT (LOWER(a.extension) = ?)');
      expect(notExt.args).toEqual(['.wav']);

      const negTag = compileFilterExpression('-tag:ui', false);
      expect(negTag.sql).toBe('NOT (EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?))');
      expect(negTag.args).toEqual(['ui']);
    });
  });

  describe('compileFilterExpression - Image Resolution Filters', () => {
    it('should compile exact resolution: res:64x64 and resolution:1920x1080', () => {
      const resFlat = compileFilterExpression('res:64x64', false);
      expect(resFlat.isParsed).toBe(true);
      expect(resFlat.sql).toContain("a.category = 'image'");
      expect(resFlat.sql).toContain("json_extract(a.metadata, '$.width')");
      expect(resFlat.sql).toContain("json_extract(a.metadata, '$.height')");
      expect(resFlat.args).toEqual([64, 64]);

      const resStacked = compileFilterExpression('resolution:1920x1080', true);
      expect(resStacked.isParsed).toBe(true);
      expect(resStacked.sql).toContain("s.type = 'animation'");
      expect(resStacked.args).toEqual([1920, 1080, 1920, 1080]);
    });

    it('should compile resolution comparisons: res:>512x512, res:<=64x64', () => {
      const resGt = compileFilterExpression('res:>512x512', false);
      expect(resGt.isParsed).toBe(true);
      expect(resGt.sql).toContain("json_extract(a.metadata, '$.width') AS INTEGER) > ?");
      expect(resGt.args).toEqual([512, 512]);

      const resLte = compileFilterExpression('res:<=64x64', false);
      expect(resLte.isParsed).toBe(true);
      expect(resLte.sql).toContain("json_extract(a.metadata, '$.width') AS INTEGER) <= ?");
      expect(resLte.args).toEqual([64, 64]);
    });

    it('should compile aspect ratio presets: res:square, res:landscape, res:portrait', () => {
      const squareRes = compileFilterExpression('res:square', false);
      expect(squareRes.isParsed).toBe(true);
      expect(squareRes.sql).toContain("json_extract(a.metadata, '$.width') AS INTEGER) = CAST(json_extract(a.metadata, '$.height')");

      const landRes = compileFilterExpression('res:landscape', false);
      expect(landRes.isParsed).toBe(true);
      expect(landRes.sql).toContain("json_extract(a.metadata, '$.width') AS INTEGER) > CAST(json_extract(a.metadata, '$.height')");

      const portRes = compileFilterExpression('res:portrait', false);
      expect(portRes.isParsed).toBe(true);
      expect(portRes.sql).toContain("json_extract(a.metadata, '$.width') AS INTEGER) < CAST(json_extract(a.metadata, '$.height')");
    });

    it('should compile resolution size presets: res:tiny, res:small, res:medium, res:large', () => {
      const tinyRes = compileFilterExpression('res:tiny', false);
      expect(tinyRes.isParsed).toBe(true);
      expect(tinyRes.sql).toContain('<= 64');

      const smallRes = compileFilterExpression('res:small', false);
      expect(smallRes.isParsed).toBe(true);
      expect(smallRes.sql).toContain('<= 256');

      const medRes = compileFilterExpression('res:medium', false);
      expect(medRes.isParsed).toBe(true);
      expect(medRes.sql).toContain('<= 1024');

      const largeRes = compileFilterExpression('res:large', false);
      expect(largeRes.isParsed).toBe(true);
      expect(largeRes.sql).toContain('> 1024');
    });

    it('should compile video shortcuts: res:1080p, res:720p, res:4k', () => {
      const fhd = compileFilterExpression('res:1080p', false);
      expect(fhd.isParsed).toBe(true);
      expect(fhd.sql).toContain('1080');

      const fourK = compileFilterExpression('res:4k', false);
      expect(fourK.isParsed).toBe(true);
      expect(fourK.sql).toContain('3840');
    });

    it('should compile resolution range: res:[64x64 TO 512x512]', () => {
      const rangeRes = compileFilterExpression('res:[64x64 TO 512x512]', false);
      expect(rangeRes.isParsed).toBe(true);
      expect(rangeRes.args).toEqual([64, 64, 512, 512]);
    });
  });

  describe('compileFilterExpression - Mixed Queries & Fallback', () => {
    it('should compile mixed query with free text and filters', () => {
      const res = compileFilterExpression('knight tag:character size:<2MB', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain('LOWER(a.name) LIKE ?');
      expect(res.sql).toContain('EXISTS (SELECT 1 FROM tags t');
      expect(res.sql).toContain('a.size < ?');
      expect(res.args).toContain(2097152);
      expect(res.args).toContain('character');
    });

    it('should handle syntax errors gracefully by falling back to text search without throwing', () => {
      const badQuery = 'tag: ( unmatched';
      const res = compileFilterExpression(badQuery, false);
      expect(res.isParsed).toBe(false);
      expect(res.sql).toContain('LOWER(a.name) LIKE ?');
      expect(res.args.length).toBeGreaterThan(0);
    });

    it('should handle empty input cleanly', () => {
      const res = compileFilterExpression('   ', false);
      expect(res.sql).toBe('');
      expect(res.args).toEqual([]);
    });
  });

  describe('compileFilterExpression - BPM Filters (Todo #4)', () => {
    it('should compile bpm:120 exact filter', () => {
      const flat = compileFilterExpression('bpm:120', false);
      expect(flat.isParsed).toBe(true);
      expect(flat.sql).toContain("ROUND(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC)) = ?");
      expect(flat.args).toEqual([120]);

      const stacked = compileFilterExpression('bpm:120', true);
      expect(stacked.isParsed).toBe(true);
      expect(stacked.sql).toContain("s.type = 'audio_variation'");
      expect(stacked.args).toEqual([120, 120]);
    });

    it('should compile bpm comparisons: bpm:>120, bpm:<=90', () => {
      const gt = compileFilterExpression('bpm:>120', false);
      expect(gt.isParsed).toBe(true);
      expect(gt.sql).toBe("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) > ?");
      expect(gt.args).toEqual([120]);

      const lte = compileFilterExpression('bpm:<=90', false);
      expect(lte.isParsed).toBe(true);
      expect(lte.sql).toBe("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= ?");
      expect(lte.args).toEqual([90]);
    });

    it('should compile bpm suffix operators via preprocessor: bpm:120+ and bpm:90-', () => {
      const plus = compileFilterExpression('bpm:120+', false);
      expect(plus.isParsed).toBe(true);
      expect(plus.sql).toBe("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) >= ?");
      expect(plus.args).toEqual([120]);

      const minus = compileFilterExpression('bpm:90-', false);
      expect(minus.isParsed).toBe(true);
      expect(minus.sql).toBe("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= ?");
      expect(minus.args).toEqual([90]);
    });

    it('should compile bpm range expressions: bpm:[80 TO 140]', () => {
      const range = compileFilterExpression('bpm:[80 TO 140]', false);
      expect(range.isParsed).toBe(true);
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) >= ?");
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= ?");
      expect(range.args).toEqual([80, 140]);
    });

    it('should compile bpm tempo presets: bpm:slow, bpm:moderate, bpm:fast, bpm:very-fast', () => {
      const slow = compileFilterExpression('bpm:slow', false);
      expect(slow.isParsed).toBe(true);
      expect(slow.sql).toContain('< 90');

      const mod = compileFilterExpression('bpm:moderate', false);
      expect(mod.isParsed).toBe(true);
      expect(mod.sql).toContain('>= 90 AND');
      expect(mod.sql).toContain('<= 120');

      const fast = compileFilterExpression('bpm:fast', false);
      expect(fast.isParsed).toBe(true);
      expect(fast.sql).toContain('> 120 AND');
      expect(fast.sql).toContain('<= 160');

      const veryFast = compileFilterExpression('bpm:very-fast', false);
      expect(veryFast.isParsed).toBe(true);
      expect(veryFast.sql).toContain('> 160');
    });

    it('should compile bpm status presets: bpm:none, bpm:detected', () => {
      const unclassified = compileFilterExpression('bpm:none', false);
      expect(unclassified.isParsed).toBe(true);
      expect(unclassified.sql).toContain('IS NULL');

      const classified = compileFilterExpression('bpm:detected', false);
      expect(classified.isParsed).toBe(true);
      expect(classified.sql).toContain('IS NOT NULL');
    });
  });

  describe('compileFilterExpression - Width & Height Filters (Todo #4)', () => {
    it('should compile width ranges and presets: width:[64 TO 512], w:tiny, width:large', () => {
      const range = compileFilterExpression('width:[64 TO 512]', false);
      expect(range.isParsed).toBe(true);
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.width') AS NUMERIC) >= ?");
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.width') AS NUMERIC) <= ?");
      expect(range.args).toEqual([64, 512]);

      const tiny = compileFilterExpression('w:tiny', false);
      expect(tiny.isParsed).toBe(true);
      expect(tiny.sql).toContain('<= 64');

      const large = compileFilterExpression('width:large', false);
      expect(large.isParsed).toBe(true);
      expect(large.sql).toContain('> 1024');
    });

    it('should compile height ranges and presets: height:[64 TO 512], h:small', () => {
      const range = compileFilterExpression('height:[64 TO 512]', false);
      expect(range.isParsed).toBe(true);
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.height') AS NUMERIC) >= ?");
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= ?");
      expect(range.args).toEqual([64, 512]);

      const small = compileFilterExpression('h:small', false);
      expect(small.isParsed).toBe(true);
      expect(small.sql).toContain('<= 256');
    });

    it('should compile width and height in stacked view (animations)', () => {
      const stacked = compileFilterExpression('width:>64', true);
      expect(stacked.isParsed).toBe(true);
      expect(stacked.sql).toContain("s.type = 'animation'");
      expect(stacked.args).toEqual([64, 64]);
    });
  });

  describe('compileFilterExpression - Duration Filters (Todo #4)', () => {
    it('should compile duration ranges and presets: dur:[5s TO 30s], dur:short, dur:music', () => {
      const range = compileFilterExpression('dur:[5s TO 30s]', false);
      expect(range.isParsed).toBe(true);
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) >= ?");
      expect(range.sql).toContain("CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) <= ?");
      expect(range.args).toEqual([5, 30]);

      const short = compileFilterExpression('dur:short', false);
      expect(short.isParsed).toBe(true);
      expect(short.sql).toContain('< 5');

      const music = compileFilterExpression('dur:music', false);
      expect(music.isParsed).toBe(true);
      expect(music.sql).toContain('> 120');
    });

    it('should compile duration in stacked view (audio variations)', () => {
      const stacked = compileFilterExpression('dur:>10', true);
      expect(stacked.isParsed).toBe(true);
      expect(stacked.sql).toContain("s.type = 'audio_variation'");
      expect(stacked.args).toEqual([10, 10]);
    });
  });

  describe('compileFallbackQuery - New Filters in Unparseable Queries', () => {
    it('should extract bpm:, width:, height:, dur: from fallback token queries', () => {
      const fallback = compileFilterExpression('bpm:120 unmatched(', false);
      expect(fallback.isParsed).toBe(false);
      expect(fallback.sql).toContain("ROUND(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC)) = ?");
      expect(fallback.args).toContain(120);

      const dimFallback = compileFilterExpression('width:64 height:128 unmatched(', false);
      expect(dimFallback.isParsed).toBe(false);
      expect(dimFallback.sql).toContain("CAST(json_extract(a.metadata, '$.width') AS NUMERIC)");
      expect(dimFallback.sql).toContain("CAST(json_extract(a.metadata, '$.height') AS NUMERIC)");
      expect(dimFallback.args).toContain(64);
      expect(dimFallback.args).toContain(128);
    });
  });

  describe('compileFilterExpression - Sprite Filters (Todo #5)', () => {
    it('should compile sprite:character and sprite:object filters in flat view', () => {
      const res = compileFilterExpression('sprite:character', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain("LOWER(json_extract(a.metadata, '$.spriteType')) = ?");
      expect(res.sql).toContain("EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND (LOWER(t.tag) = ? OR LOWER(t.tag) = ?))");
      expect(res.args).toEqual(['character', 'sprite:character', 'character']);

      const obj = compileFilterExpression('sprite:object', false);
      expect(obj.isParsed).toBe(true);
      expect(obj.args).toEqual(['object', 'sprite:object', 'object']);
    });

    it('should compile sprite:unclassified filter', () => {
      const res = compileFilterExpression('sprite:unclassified', false);
      expect(res.isParsed).toBe(true);
      expect(res.args).toEqual(['unclassified', 'sprite:unclassified', 'unclassified']);
    });

    it('should compile sprite:texture in stacked view', () => {
      const res = compileFilterExpression('sprite:texture', true);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain("a.stack_id IS NOT NULL");
      expect(res.args).toContain('texture');
      expect(res.args).toContain('sprite:texture');
    });

    it('should compile shorthand #sprite:character via preprocessor', () => {
      expect(preprocessSearchQuery('#sprite:character')).toBe('tag:"sprite:character"');
      const res = compileFilterExpression('#sprite:character', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain("EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)");
      expect(res.args).toEqual(['sprite:character']);
    });
  });

  describe('compileFilterExpression - Pack Filters (Todo #6)', () => {
    it('should compile pack:RetroPack exact and p:RetroPack filters', () => {
      const res = compileFilterExpression('pack:RetroPack', false);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain("json_extract(a.metadata, '$.pack')");
      expect(res.args).toContain('retropack');
      expect(res.args).toContain('pack:retropack');

      const pRes = compileFilterExpression('p:Fantasy', false);
      expect(pRes.isParsed).toBe(true);
      expect(pRes.args).toContain('fantasy');
    });

    it('should compile wildcard pack:retro* and status presets pack:none, pack:any', () => {
      const wild = compileFilterExpression('pack:retro*', false);
      expect(wild.isParsed).toBe(true);
      expect(wild.args).toContain('retro%');

      const none = compileFilterExpression('pack:none', false);
      expect(none.isParsed).toBe(true);
      expect(none.sql).toContain("json_extract(a.metadata, '$.pack') IS NULL");

      const any = compileFilterExpression('pack:any', false);
      expect(any.isParsed).toBe(true);
      expect(any.sql).toContain("json_extract(a.metadata, '$.pack') IS NOT NULL");
    });

    it('should compile pack filters in stacked view', () => {
      const res = compileFilterExpression('pack:SciFi', true);
      expect(res.isParsed).toBe(true);
      expect(res.sql).toContain('a.stack_id IS NOT NULL');
      expect(res.args).toContain('scifi');
    });

    it('should extract pack: in fallback query when syntax errors occur', () => {
      const res = compileFilterExpression('pack:RetroPack ( unmatched', false);
      expect(res.isParsed).toBe(false);
      expect(res.sql).toContain("json_extract(a.metadata, '$.pack')");
      expect(res.args).toContain('retropack');
    });
  });
});
