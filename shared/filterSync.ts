export type FilterType =
  | 'format'
  | 'resolution'
  | 'width'
  | 'height'
  | 'duration'
  | 'bpm'
  | 'tag'
  | 'sprite'
  | 'pack';

export interface ParsedFilters {
  format: string | null;
  resolution: string | null;
  width: string | null;
  height: string | null;
  duration: string | null;
  bpm: string | null;
  tag: string | null;
  sprite: string | null;
  pack: string | null;
}

/**
 * Normalizes and formats a filter value into its canonical search bar token representation.
 */
export function formatFilterToken(filterType: FilterType, value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  switch (filterType) {
    case 'format': {
      const ext = v.replace(/^\./, '').toLowerCase();
      return `ext:${ext}`;
    }
    case 'resolution':
      return `res:${v.toLowerCase()}`;
    case 'width':
      return `width:${v.toLowerCase()}`;
    case 'height':
      return `height:${v.toLowerCase()}`;
    case 'duration':
      return `dur:${v.toLowerCase()}`;
    case 'bpm':
      return `bpm:${v.toLowerCase()}`;
    case 'tag': {
      const clean = v.replace(/^#/, '').trim();
      return clean.includes(' ') ? `tag:"${clean}"` : `tag:${clean}`;
    }
    case 'sprite':
      return `sprite:${v.toLowerCase()}`;
    case 'pack': {
      const clean = v.trim();
      return clean.includes(' ') ? `pack:"${clean}"` : `pack:${clean}`;
    }
    default:
      return null;
  }
}

/**
 * Returns a regular expression that matches any token corresponding to the filter type.
 */
export function getFilterPattern(filterType: FilterType): RegExp {
  switch (filterType) {
    case 'format':
      return /\b(?:ext|format):[^\s]+/gi;
    case 'resolution':
      return /\b(?:res|resolution):[^\s]+/gi;
    case 'width':
      return /\b(?:width|w):[^\s]+/gi;
    case 'height':
      return /\b(?:height|h):[^\s]+/gi;
    case 'duration':
      return /\b(?:dur|duration):(\[[^\]]+\]|[^\s]+)/gi;
    case 'bpm':
      return /\b(?:bpm|tempo):(\[[^\]]+\]|[^\s]+)/gi;
    case 'tag':
      return /(?:^|\s)(?:(?:tag|t):(?:"[^"]*"|[^\s]+)|#[a-zA-Z0-9_\-]+)/gi;
    case 'sprite':
      return /\b(?:sprite|spritetype):[^\s]+/gi;
    case 'pack':
      return /\b(?:pack|p):(?:"[^"]*"|[^\s]+)/gi;
    default:
      return /(?!)/g;
  }
}

/**
 * Extracts all UI filter states from a search query string.
 */
export function parseFiltersFromQuery(query: string): ParsedFilters {
  const q = (query || '').trim();
  const res: ParsedFilters = {
    format: null,
    resolution: null,
    width: null,
    height: null,
    duration: null,
    bpm: null,
    tag: null,
    sprite: null,
    pack: null,
  };

  if (!q) return res;

  // 1. Format: ext:png, format:wav, ext:.png
  const fmtMatch = q.match(/\b(?:ext|format):\.?([a-zA-Z0-9]+)\b/i);
  if (fmtMatch) {
    res.format = `.${fmtMatch[1].toLowerCase()}`;
  }

  // 2. Resolution: res:square, res:<=64, res:64x64, etc.
  const resMatch = q.match(/\b(?:res|resolution):([^\s]+)/i);
  if (resMatch) {
    const val = resMatch[1].toLowerCase();
    if (val === 'square') {
      res.resolution = 'square';
    } else if (val === '<=64' || val === '<=64px' || val === 'tiny' || val === 'icon') {
      res.resolution = '<=64';
    } else if (val === '<=256' || val === '<=256px' || val === 'small') {
      res.resolution = '<=256';
    } else if (val === '<=1024' || val === '<=1024px' || val === 'medium') {
      res.resolution = '<=1024';
    } else if (val === '>1024' || val === '>1024px' || val === 'large' || val === 'hd') {
      res.resolution = '>1024';
    } else if (/^\d+[xX*×]\d+$/.test(val)) {
      res.resolution = val.replace(/[X*×]/, 'x');
    } else {
      res.resolution = val;
    }
  }

  // 3. Width: width:<=64, w:64, etc.
  const wMatch = q.match(/\b(?:width|w):([^\s]+)/i);
  if (wMatch) {
    const val = wMatch[1].toLowerCase();
    if (val === '<=64' || val === '<=64px' || val === 'tiny') res.width = '<=64';
    else if (val === '<=256' || val === '<=256px' || val === 'small') res.width = '<=256';
    else if (val === '<=1024' || val === '<=1024px' || val === 'medium') res.width = '<=1024';
    else if (val === '>1024' || val === '>1024px' || val === 'large') res.width = '>1024';
    else res.width = val;
  }

  // 4. Height: height:<=64, h:64, etc.
  const hMatch = q.match(/\b(?:height|h):([^\s]+)/i);
  if (hMatch) {
    const val = hMatch[1].toLowerCase();
    if (val === '<=64' || val === '<=64px' || val === 'tiny') res.height = '<=64';
    else if (val === '<=256' || val === '<=256px' || val === 'small') res.height = '<=256';
    else if (val === '<=1024' || val === '<=1024px' || val === 'medium') res.height = '<=1024';
    else if (val === '>1024' || val === '>1024px' || val === 'large') res.height = '>1024';
    else res.height = val;
  }

  // 5. Duration: dur:<5, dur:5-30, dur:30-120, dur:>120
  const durMatch = q.match(/\b(?:dur|duration):(\[[^\]]+\]|[^\s]+)/i);
  if (durMatch) {
    const val = durMatch[1].toLowerCase();
    if (val === '<5' || val === '<5s' || val === 'sfx' || val === 'short') res.duration = '<5';
    else if (val === '5-30' || val === '5s-30s' || val === '[5 to 30]' || val === '[5s to 30s]') res.duration = '5-30';
    else if (val === '30-120' || val === '30s-2m' || val === '[30 to 120]' || val === '[30s to 2m]') res.duration = '30-120';
    else if (val === '>120' || val === '>2m' || val === 'music') res.duration = '>120';
    else res.duration = val;
  }

  // 6. BPM: bpm:slow, bpm:moderate, bpm:fast, bpm:very-fast, bpm:120
  const bpmMatch = q.match(/\b(?:bpm|tempo):(\[[^\]]+\]|[^\s]+)/i);
  if (bpmMatch) {
    const val = bpmMatch[1].toLowerCase();
    if (val === 'slow' || val === 'slow-tempo' || val === '<90' || val === '<80') res.bpm = 'slow';
    else if (val === 'moderate' || val === 'moderate-tempo' || val === 'mid' || val === '90-120' || val === '[90 to 120]') res.bpm = 'moderate';
    else if (val === 'fast' || val === 'fast-tempo' || val === '120-160' || val === '[120 to 160]') res.bpm = 'fast';
    else if (val === 'very-fast' || val === 'veryfast' || val === '>160' || val === 'uptempo' || val === '>150') res.bpm = 'very-fast';
    else res.bpm = val;
  }

  // 7. Tag: tag:coin, #coin, tag:"player one"
  const tagMatch = q.match(/\b(?:tag|t):"([^"]+)"|\b(?:tag|t):([^\s]+)|(?:^|\s)#([a-zA-Z0-9_\-]+)/i);
  if (tagMatch) {
    res.tag = (tagMatch[1] || tagMatch[2] || tagMatch[3]).toLowerCase();
  }

  // 8. Sprite: sprite:character, spritetype:object
  const spriteMatch = q.match(/\b(?:sprite|spritetype):([^\s]+)/i);
  if (spriteMatch) {
    res.sprite = spriteMatch[1].toLowerCase();
  }

  // 9. Pack: pack:RetroPack, pack:"Fantasy Pack", p:RetroPack
  const packMatch = q.match(/\b(?:pack|p):"([^"]+)"|\b(?:pack|p):([^\s]+)/i);
  if (packMatch) {
    res.pack = (packMatch[1] || packMatch[2]).toLowerCase();
  }

  return res;
}

/**
 * Updates a search query string by adding, replacing, or removing a specific filter token.
 * All other filter tokens and free-text queries are preserved.
 */
export function updateSearchFilter(
  currentQuery: string,
  filterType: FilterType,
  value: string | null
): string {
  const token = formatFilterToken(filterType, value);
  const pattern = getFilterPattern(filterType);

  let updated: string;
  if (!value || !token) {
    // Remove all tokens of this filter type
    updated = currentQuery.replace(pattern, ' ');
  } else {
    pattern.lastIndex = 0;
    if (pattern.test(currentQuery)) {
      pattern.lastIndex = 0;
      let replaced = false;
      updated = currentQuery.replace(pattern, (match) => {
        if (!replaced) {
          replaced = true;
          const prefix = match.startsWith(' ') ? ' ' : '';
          return prefix + token;
        }
        return ' ';
      });
    } else {
      const trimmed = currentQuery.trim();
      updated = trimmed ? `${trimmed} ${token}` : token;
    }
  }

  return updated.replace(/\s+/g, ' ').trim();
}
