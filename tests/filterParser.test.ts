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
        '(EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?) OR EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?))'
      );
      expect(res.args).toEqual(['coin', 'gem']);
    });

    it('should compile conjunctions and groupings: (tag:a OR tag:b) AND size:<1MB', () => {
      const res = compileFilterExpression('(tag:a OR tag:b) AND size:<1MB', false);
      expect(res.sql).toBe(
        '(((EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?) OR EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?))) AND a.size < ?)'
      );
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
});
