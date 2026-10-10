import { describe, it, expect } from 'vitest';
import {
  formatFilterToken,
  getFilterPattern,
  parseFiltersFromQuery,
  updateSearchFilter,
} from '../shared/filterSync.js';

describe('Filter and Search Bar Synchronization (shared/filterSync)', () => {
  describe('formatFilterToken', () => {
    it('should format file extension / format token', () => {
      expect(formatFilterToken('format', '.png')).toBe('ext:png');
      expect(formatFilterToken('format', 'PNG')).toBe('ext:png');
      expect(formatFilterToken('format', 'wav')).toBe('ext:wav');
      expect(formatFilterToken('format', null)).toBeNull();
      expect(formatFilterToken('format', '')).toBeNull();
    });

    it('should format resolution preset and dimension tokens', () => {
      expect(formatFilterToken('resolution', 'square')).toBe('res:square');
      expect(formatFilterToken('resolution', '<=64')).toBe('res:<=64');
      expect(formatFilterToken('resolution', '<=256')).toBe('res:<=256');
      expect(formatFilterToken('resolution', '<=1024')).toBe('res:<=1024');
      expect(formatFilterToken('resolution', '>1024')).toBe('res:>1024');
      expect(formatFilterToken('resolution', '64x64')).toBe('res:64x64');
      expect(formatFilterToken('resolution', '1920x1080')).toBe('res:1920x1080');
    });

    it('should format width and height tokens', () => {
      expect(formatFilterToken('width', '<=64')).toBe('width:<=64');
      expect(formatFilterToken('width', '>1024')).toBe('width:>1024');
      expect(formatFilterToken('height', '<=256')).toBe('height:<=256');
      expect(formatFilterToken('height', '<=1024')).toBe('height:<=1024');
    });

    it('should format duration tokens', () => {
      expect(formatFilterToken('duration', '<5')).toBe('dur:<5');
      expect(formatFilterToken('duration', '5-30')).toBe('dur:5-30');
      expect(formatFilterToken('duration', '30-120')).toBe('dur:30-120');
      expect(formatFilterToken('duration', '>120')).toBe('dur:>120');
    });

    it('should format bpm tokens', () => {
      expect(formatFilterToken('bpm', 'slow')).toBe('bpm:slow');
      expect(formatFilterToken('bpm', 'moderate')).toBe('bpm:moderate');
      expect(formatFilterToken('bpm', 'fast')).toBe('bpm:fast');
      expect(formatFilterToken('bpm', 'very-fast')).toBe('bpm:very-fast');
      expect(formatFilterToken('bpm', '120')).toBe('bpm:120');
    });

    it('should format tag tokens', () => {
      expect(formatFilterToken('tag', 'coin')).toBe('tag:coin');
      expect(formatFilterToken('tag', '#coin')).toBe('tag:coin');
      expect(formatFilterToken('tag', 'player one')).toBe('tag:"player one"');
    });

    it('should format sprite tokens', () => {
      expect(formatFilterToken('sprite', 'character')).toBe('sprite:character');
      expect(formatFilterToken('sprite', 'texture')).toBe('sprite:texture');
    });

    it('should format pack tokens', () => {
      expect(formatFilterToken('pack', 'RetroPack')).toBe('pack:RetroPack');
      expect(formatFilterToken('pack', 'Fantasy Pack')).toBe('pack:"Fantasy Pack"');
    });
  });

  describe('parseFiltersFromQuery', () => {
    it('should return all nulls for empty or whitespace query', () => {
      const res = parseFiltersFromQuery('');
      expect(res).toEqual({
        format: null,
        resolution: null,
        width: null,
        height: null,
        duration: null,
        bpm: null,
        tag: null,
        sprite: null,
        pack: null,
      });
      expect(parseFiltersFromQuery('   ')).toEqual(res);
    });

    it('should parse format from ext: and format: tokens', () => {
      expect(parseFiltersFromQuery('ext:png').format).toBe('.png');
      expect(parseFiltersFromQuery('ext:.wav').format).toBe('.wav');
      expect(parseFiltersFromQuery('format:ogg').format).toBe('.ogg');
      expect(parseFiltersFromQuery('FORMAT:JPG').format).toBe('.jpg');
    });

    it('should parse resolution presets and dimensions', () => {
      expect(parseFiltersFromQuery('res:square').resolution).toBe('square');
      expect(parseFiltersFromQuery('resolution:square').resolution).toBe('square');
      expect(parseFiltersFromQuery('res:<=64').resolution).toBe('<=64');
      expect(parseFiltersFromQuery('res:<=64px').resolution).toBe('<=64');
      expect(parseFiltersFromQuery('res:tiny').resolution).toBe('<=64');
      expect(parseFiltersFromQuery('res:<=256').resolution).toBe('<=256');
      expect(parseFiltersFromQuery('res:small').resolution).toBe('<=256');
      expect(parseFiltersFromQuery('res:<=1024').resolution).toBe('<=1024');
      expect(parseFiltersFromQuery('res:medium').resolution).toBe('<=1024');
      expect(parseFiltersFromQuery('res:>1024').resolution).toBe('>1024');
      expect(parseFiltersFromQuery('res:large').resolution).toBe('>1024');
      expect(parseFiltersFromQuery('res:64x64').resolution).toBe('64x64');
      expect(parseFiltersFromQuery('res:1920x1080').resolution).toBe('1920x1080');
    });

    it('should parse width and height tokens', () => {
      expect(parseFiltersFromQuery('width:<=64').width).toBe('<=64');
      expect(parseFiltersFromQuery('w:<=256').width).toBe('<=256');
      expect(parseFiltersFromQuery('width:<=1024').width).toBe('<=1024');
      expect(parseFiltersFromQuery('w:>1024').width).toBe('>1024');

      expect(parseFiltersFromQuery('height:<=64').height).toBe('<=64');
      expect(parseFiltersFromQuery('h:<=256').height).toBe('<=256');
      expect(parseFiltersFromQuery('height:<=1024').height).toBe('<=1024');
      expect(parseFiltersFromQuery('h:>1024').height).toBe('>1024');
    });

    it('should parse duration presets and ranges', () => {
      expect(parseFiltersFromQuery('dur:<5').duration).toBe('<5');
      expect(parseFiltersFromQuery('dur:sfx').duration).toBe('<5');
      expect(parseFiltersFromQuery('dur:5-30').duration).toBe('5-30');
      expect(parseFiltersFromQuery('duration:[5 TO 30]').duration).toBe('5-30');
      expect(parseFiltersFromQuery('dur:30-120').duration).toBe('30-120');
      expect(parseFiltersFromQuery('dur:>120').duration).toBe('>120');
      expect(parseFiltersFromQuery('dur:music').duration).toBe('>120');
    });

    it('should parse BPM presets and values', () => {
      expect(parseFiltersFromQuery('bpm:slow').bpm).toBe('slow');
      expect(parseFiltersFromQuery('bpm:slow-tempo').bpm).toBe('slow');
      expect(parseFiltersFromQuery('bpm:moderate').bpm).toBe('moderate');
      expect(parseFiltersFromQuery('tempo:mid').bpm).toBe('moderate');
      expect(parseFiltersFromQuery('bpm:fast').bpm).toBe('fast');
      expect(parseFiltersFromQuery('bpm:very-fast').bpm).toBe('very-fast');
      expect(parseFiltersFromQuery('bpm:high').bpm).toBe('very-fast');
      expect(parseFiltersFromQuery('tempo:uptempo').bpm).toBe('very-fast');
      expect(parseFiltersFromQuery('bpm:120').bpm).toBe('120');
      expect(parseFiltersFromQuery('bpm:144').bpm).toBe('144');
    });

    it('keeps numeric BPM comparisons and ranges literal at bucket boundaries', () => {
      for (const value of ['<80', '<90', '>=80', '<120', '>=120', '<150', '>=150', '>150', '>160', '90-120']) {
        expect(parseFiltersFromQuery(`bpm:${value}`).bpm).toBe(value);
      }
      expect(parseFiltersFromQuery('tempo:[80 TO 120]').bpm).toBe('[80 to 120]');
      expect(parseFiltersFromQuery('bpm:[120 TO 150]').bpm).toBe('[120 to 150]');
      expect(parseFiltersFromQuery('bpm:slow OR bpm:fast').bpm).toBeNull();
    });

    it('should parse tags and shorthand #tag', () => {
      expect(parseFiltersFromQuery('tag:coin').tag).toBe('coin');
      expect(parseFiltersFromQuery('t:gem').tag).toBe('gem');
      expect(parseFiltersFromQuery('#hero').tag).toBe('hero');
      expect(parseFiltersFromQuery('tag:"player one"').tag).toBe('player one');
    });

    it('should parse sprite archetypes', () => {
      expect(parseFiltersFromQuery('sprite:character').sprite).toBe('character');
      expect(parseFiltersFromQuery('spritetype:texture').sprite).toBe('texture');
    });

    it('should parse pack tokens', () => {
      expect(parseFiltersFromQuery('pack:RetroPack').pack).toBe('retropack');
      expect(parseFiltersFromQuery('pack:"Fantasy Pack"').pack).toBe('fantasy pack');
      expect(parseFiltersFromQuery('p:SciFi').pack).toBe('scifi');
    });

    it('should parse multiple filters simultaneously from a complex search query', () => {
      const q = 'knight ext:png res:square width:<=64 height:<=64 dur:5-30 bpm:120 tag:hero sprite:character pack:RetroPack';
      const parsed = parseFiltersFromQuery(q);

      expect(parsed.format).toBe('.png');
      expect(parsed.resolution).toBe('square');
      expect(parsed.width).toBe('<=64');
      expect(parsed.height).toBe('<=64');
      expect(parsed.duration).toBe('5-30');
      expect(parsed.bpm).toBe('120');
      expect(parsed.tag).toBe('hero');
      expect(parsed.sprite).toBe('character');
      expect(parsed.pack).toBe('retropack');
    });
  });

  describe('updateSearchFilter', () => {
    it('should add a filter token to an empty query', () => {
      expect(updateSearchFilter('', 'format', '.png')).toBe('ext:png');
      expect(updateSearchFilter('', 'resolution', 'square')).toBe('res:square');
    });

    it('should append a new filter token without disturbing existing tokens or free text', () => {
      const q1 = updateSearchFilter('knight', 'format', '.png');
      expect(q1).toBe('knight ext:png');

      const q2 = updateSearchFilter(q1, 'resolution', 'square');
      expect(q2).toBe('knight ext:png res:square');

      const q3 = updateSearchFilter(q2, 'width', '<=64');
      expect(q3).toBe('knight ext:png res:square width:<=64');
    });

    it('should replace an existing filter token of the same type in-place', () => {
      const initial = 'hero ext:png res:square tag:knight';
      const updatedFormat = updateSearchFilter(initial, 'format', '.wav');
      expect(updatedFormat).toBe('hero ext:wav res:square tag:knight');

      const updatedRes = updateSearchFilter(updatedFormat, 'resolution', '<=64');
      expect(updatedRes).toBe('hero ext:wav res:<=64 tag:knight');

      const updatedTag = updateSearchFilter(updatedRes, 'tag', 'boss');
      expect(updatedTag).toBe('hero ext:wav res:<=64 tag:boss');
    });

    it('should remove a filter token when value is null while preserving other filters and free text', () => {
      const query = 'hero ext:png res:square width:<=64 tag:knight';

      const withoutRes = updateSearchFilter(query, 'resolution', null);
      expect(withoutRes).toBe('hero ext:png width:<=64 tag:knight');

      const withoutFormat = updateSearchFilter(withoutRes, 'format', null);
      expect(withoutFormat).toBe('hero width:<=64 tag:knight');

      const withoutTag = updateSearchFilter(withoutFormat, 'tag', null);
      expect(withoutTag).toBe('hero width:<=64');

      const withoutWidth = updateSearchFilter(withoutWidthQuery(withoutTag), 'width', null);
      expect(withoutWidth).toBe('hero');

      function withoutWidthQuery(q: string) {
        return q;
      }
    });

    it('should handle removing shorthand #tag properly', () => {
      const query = 'hero #knight ext:png';
      const result = updateSearchFilter(query, 'tag', null);
      expect(result).toBe('hero ext:png');
    });

    it('should handle replacing shorthand #tag with tag:newtag', () => {
      const query = 'hero #knight ext:png';
      const result = updateSearchFilter(query, 'tag', 'dragon');
      expect(result).toBe('hero tag:dragon ext:png');
    });

    it('should clean up double spaces and trim edges cleanly', () => {
      const query = '   ext:png    res:square   ';
      const result = updateSearchFilter(query, 'format', null);
      expect(result).toBe('res:square');
    });

    it('keeps each bracketed range together when parsing, replacing, or removing it', () => {
      const ranges = [
        ['resolution', 'res:[64x64 TO 512x512]', '[64x64 to 512x512]'],
        ['width', 'width:[64 TO 512]', '[64 to 512]'],
        ['height', 'height:[64 TO 512]', '[64 to 512]'],
        ['duration', 'dur:[10 TO 40]', '[10 to 40]'],
        ['bpm', 'bpm:[80 TO 150]', '[80 to 150]'],
      ] as const;

      for (const [type, range, selected] of ranges) {
        expect(parseFiltersFromQuery(range)[type]).toBe(selected);
        expect(updateSearchFilter(`${range}  coin`, type, null)).toBe('coin');
        expect(updateSearchFilter(`${range}  coin`, type, 'fast')).toBe(`${formatFilterToken(type, 'fast')}  coin`);
      }
    });

    it('preserves grouped OR filters and adds a new selection as a separate conjunction', () => {
      const query = '(ext:png OR ext:jpg) coin';
      expect(parseFiltersFromQuery(query).format).toBeNull();
      expect(updateSearchFilter(query, 'format', null)).toBe(query);

      const edited = updateSearchFilter(query, 'format', '.webp');
      expect(edited).toBe('((ext:png OR ext:jpg) coin) AND ext:webp');
      expect(parseFiltersFromQuery(edited).format).toBeNull();
      expect(parseFiltersFromQuery(edited).tag).toBeNull();
    });

    it('edits conjunctions inside parentheses without leaving dangling syntax', () => {
      expect(updateSearchFilter('(ext:png AND tag:coin) hero', 'format', null)).toBe('(tag:coin) hero');
      expect(updateSearchFilter('hero (ext:png)', 'format', null)).toBe('hero');
      expect(updateSearchFilter('(ext:png)', 'format', null)).toBe('');
      expect(updateSearchFilter('(ext:png AND tag:coin) hero', 'format', '.jpg'))
        .toBe('(ext:jpg AND tag:coin) hero');
    });

    it('removes repeated positive filters and leaves negated filters intact', () => {
      const query = 'ext:png AND ext:jpg AND tag:coin';
      expect(parseFiltersFromQuery(query).format).toBeNull();
      expect(updateSearchFilter(query, 'format', null)).toBe('tag:coin');
      expect(updateSearchFilter(query, 'format', '.wav')).toBe('ext:wav AND tag:coin');

      const negated = 'NOT ext:png AND -ext:jpg AND tag:coin';
      expect(parseFiltersFromQuery(negated).format).toBeNull();
      expect(updateSearchFilter(negated, 'format', null)).toBe(negated);
      expect(updateSearchFilter(negated, 'format', '.wav')).toBe(`${negated} ext:wav`);
    });

    it('keeps literal whitespace and quoted operator text byte-for-byte', () => {
      const query = 'tag:"a  b OR ext:png"    pack:"Retro (Pack)"';
      expect(parseFiltersFromQuery(query).tag).toBe('a  b or ext:png');
      expect(parseFiltersFromQuery(query).pack).toBe('retro (pack)');
      expect(updateSearchFilter(query, 'format', '.png')).toBe(`${query} ext:png`);
      expect(updateSearchFilter(`${query}    width:[64 TO 512]`, 'width', null)).toBe(query);
    });

    it('does not rewrite an incomplete expression while the user is typing', () => {
      for (const query of ['(ext:png OR', 'width:[64 TO 512', 'tag:"unfinished', 'ext:png AND']) {
        expect(updateSearchFilter(query, 'format', null)).toBe(query);
        expect(updateSearchFilter(query, 'format', '.jpg')).toBe(query);
      }
    });
  });

  describe('Bidirectional Consistency Verification', () => {
    it('should maintain perfect consistency when simulating user clicks in the UI', () => {
      let query = '';

      // 1. User clicks "png" in sidebar
      query = updateSearchFilter(query, 'format', '.png');
      expect(query).toBe('ext:png');
      expect(parseFiltersFromQuery(query).format).toBe('.png');

      // 2. User clicks "Square" in sidebar
      query = updateSearchFilter(query, 'resolution', 'square');
      expect(query).toBe('ext:png res:square');
      let filters = parseFiltersFromQuery(query);
      expect(filters.format).toBe('.png');
      expect(filters.resolution).toBe('square');

      // 3. User clicks "≤ 64px" in Width
      query = updateSearchFilter(query, 'width', '<=64');
      expect(query).toBe('ext:png res:square width:<=64');
      filters = parseFiltersFromQuery(query);
      expect(filters.width).toBe('<=64');

      // 4. User types "coin" into the search bar
      query = `${query} coin`;
      expect(query).toBe('ext:png res:square width:<=64 coin');
      filters = parseFiltersFromQuery(query);
      expect(filters.format).toBe('.png');
      expect(filters.resolution).toBe('square');
      expect(filters.width).toBe('<=64');

      // 5. User clicks "Square" again to toggle it off
      query = updateSearchFilter(query, 'resolution', null);
      expect(query).toBe('ext:png width:<=64 coin');
      filters = parseFiltersFromQuery(query);
      expect(filters.format).toBe('.png');
      expect(filters.resolution).toBeNull();
      expect(filters.width).toBe('<=64');

      // 6. User clicks "Clear" on Formats
      query = updateSearchFilter(query, 'format', null);
      expect(query).toBe('width:<=64 coin');
      filters = parseFiltersFromQuery(query);
      expect(filters.format).toBeNull();
      expect(filters.width).toBe('<=64');

      // 7. User clicks the clear button in search bar (query becomes empty)
      query = '';
      filters = parseFiltersFromQuery(query);
      expect(filters).toEqual({
        format: null,
        resolution: null,
        width: null,
        height: null,
        duration: null,
        bpm: null,
        tag: null,
        sprite: null,
        pack: null,
      });
    });
  });
});
