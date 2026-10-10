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

const FILTER_PREFIXES: Record<string, FilterType> = {
  ext: 'format', format: 'format',
  res: 'resolution', resolution: 'resolution',
  width: 'width', w: 'width',
  height: 'height', h: 'height',
  dur: 'duration', duration: 'duration',
  bpm: 'bpm', tempo: 'bpm',
  tag: 'tag', t: 'tag',
  sprite: 'sprite', spritetype: 'sprite',
  pack: 'pack', p: 'pack',
};

type LexKind = 'atom' | 'and' | 'or' | 'not' | 'open' | 'close';

interface LexToken {
  kind: LexKind;
  start: number;
  end: number;
  text: string;
}

interface ExpressionBase {
  start: number;
  end: number;
  parent: Expression | null;
}

interface AtomExpression extends ExpressionBase {
  kind: 'atom';
  token: LexToken;
}

interface GroupExpression extends ExpressionBase {
  kind: 'group';
  child: Expression;
}

interface NotExpression extends ExpressionBase {
  kind: 'not';
  child: Expression;
}

interface BinaryExpression extends ExpressionBase {
  kind: 'and' | 'or';
  left: Expression;
  right: Expression;
}

type Expression = AtomExpression | GroupExpression | NotExpression | BinaryExpression;

interface FilterOccurrence {
  atom: AtomExpression;
  type: FilterType;
  value: string;
  quoted: boolean;
  editable: boolean;
}

/**
 * Scans search syntax without splitting a quoted literal or bracketed range.
 * Parentheses are expression delimiters only outside those values.
 */
function scanQuery(query: string): LexToken[] | null {
  const tokens: LexToken[] = [];
  let index = 0;

  while (index < query.length) {
    if (/\s/.test(query[index])) {
      index++;
      continue;
    }

    const start = index;
    const character = query[index];
    if (character === '(' || character === ')') {
      index++;
      tokens.push({ kind: character === '(' ? 'open' : 'close', start, end: index, text: character });
      continue;
    }

    let quoted = false;
    let escaped = false;
    let bracketDepth = 0;
    while (index < query.length) {
      const current = query[index];
      if (escaped) {
        escaped = false;
      } else if (current === '\\') {
        escaped = true;
      } else if (current === '"') {
        quoted = !quoted;
      } else if (!quoted && current === '[') {
        bracketDepth++;
      } else if (!quoted && current === ']') {
        if (bracketDepth === 0) return null;
        bracketDepth--;
      } else if (!quoted && bracketDepth === 0 && (/\s/.test(current) || current === '(' || current === ')')) {
        break;
      }
      index++;
    }

    if (quoted || escaped || bracketDepth !== 0) return null;
    const text = query.slice(start, index);
    const keyword = text.toUpperCase();
    const kind: LexKind = keyword === 'AND' ? 'and' : keyword === 'OR' ? 'or' : keyword === 'NOT' ? 'not' : 'atom';
    tokens.push({ kind, start, end: index, text });
  }

  return tokens;
}

/** Parse just enough Boolean structure to tell which spans a single control can edit. */
function parseExpression(tokens: LexToken[]): Expression | null {
  let index = 0;

  const primary = (): Expression | null => {
    const token = tokens[index];
    if (!token) return null;

    if (token.kind === 'not') {
      index++;
      const child = primary();
      if (!child) return null;
      const node: NotExpression = { kind: 'not', start: token.start, end: child.end, child, parent: null };
      child.parent = node;
      return node;
    }

    if (token.kind === 'open') {
      index++;
      const child = sequence();
      const close = tokens[index];
      if (!child || close?.kind !== 'close') return null;
      index++;
      const node: GroupExpression = { kind: 'group', start: token.start, end: close.end, child, parent: null };
      child.parent = node;
      return node;
    }

    if (token.kind !== 'atom') return null;
    index++;
    return { kind: 'atom', start: token.start, end: token.end, token, parent: null };
  };

  const sequence = (): Expression | null => {
    let left = primary();
    if (!left) return null;

    while (index < tokens.length && tokens[index].kind !== 'close') {
      const next = tokens[index];
      let kind: 'and' | 'or' = 'and';
      if (next.kind === 'and' || next.kind === 'or') {
        kind = next.kind;
        index++;
      }
      const right = primary();
      if (!right) return null;
      const node: BinaryExpression = { kind, start: left.start, end: right.end, left, right, parent: null };
      left.parent = node;
      right.parent = node;
      left = node;
    }

    return left;
  };

  const root = sequence();
  return root && index === tokens.length ? root : null;
}

function decodeValue(raw: string): string {
  if (!raw.startsWith('"') || !raw.endsWith('"')) return raw;
  let value = '';
  for (let index = 1; index < raw.length - 1; index++) {
    const character = raw[index];
    if (character === '\\' && index + 1 < raw.length - 1 && (raw[index + 1] === '"' || raw[index + 1] === '\\')) {
      index++;
      value += raw[index];
    } else {
      value += character;
    }
  }
  return value;
}

function filterInAtom(atom: AtomExpression): { type: FilterType; value: string; quoted: boolean; negated: boolean } | null {
  const raw = atom.token.text;
  const negated = raw.startsWith('-');
  const text = negated ? raw.slice(1) : raw;
  if (/^#[\p{L}\p{N}_-]+$/u.test(text)) {
    return { type: 'tag', value: text.slice(1), quoted: false, negated };
  }
  const match = /^([a-zA-Z][a-zA-Z0-9]*):(.*)$/s.exec(text);
  if (!match || !match[2]) return null;
  const type = FILTER_PREFIXES[match[1].toLowerCase()];
  if (!type) return null;
  const quoted = match[2].startsWith('"') && match[2].endsWith('"');
  return { type, value: decodeValue(match[2]), quoted, negated };
}

function collectOccurrences(root: Expression): FilterOccurrence[] {
  const occurrences: FilterOccurrence[] = [];

  const visit = (node: Expression, protectedByBoolean: boolean): void => {
    if (node.kind === 'atom') {
      const filter = filterInAtom(node);
      if (filter) {
        occurrences.push({
          atom: node,
          type: filter.type,
          value: filter.value,
          quoted: filter.quoted,
          editable: !protectedByBoolean && !filter.negated,
        });
      }
    } else if (node.kind === 'group') {
      visit(node.child, protectedByBoolean);
    } else if (node.kind === 'not') {
      visit(node.child, true);
    } else {
      const protectedChild = protectedByBoolean || node.kind === 'or';
      visit(node.left, protectedChild);
      visit(node.right, protectedChild);
    }
  };

  visit(root, false);
  return occurrences;
}

function hasOr(node: Expression): boolean {
  if (node.kind === 'or') return true;
  if (node.kind === 'and') return hasOr(node.left) || hasOr(node.right);
  if (node.kind === 'group' || node.kind === 'not') return hasOr(node.child);
  return false;
}

function removeAtom(query: string, atom: AtomExpression): string {
  let node: Expression = atom;
  while (node.parent?.kind === 'group') node = node.parent;

  const parent = node.parent;
  let start: number;
  let end: number;
  if (parent?.kind === 'and') {
    if (parent.left === node) {
      start = node.start;
      end = parent.right.start;
    } else {
      start = parent.left.end;
      end = node.end;
    }
  } else {
    start = node.start;
    end = node.end;
  }
  return (query.slice(0, start) + query.slice(end)).trim();
}

function normalizedFilterValue(type: FilterType, value: string, quoted: boolean): string {
  // A quoted label is a literal name. Retain its exact spelling so selecting
  // or displaying it again does not alter Unicode or embedded punctuation.
  if (quoted && (type === 'tag' || type === 'pack')) return value;
  const v = value.toLowerCase();
  if (type === 'format') return `.${v.replace(/^\./, '')}`;
  if (type === 'resolution') {
    if (['<=64', '<=64px', 'tiny', 'icon'].includes(v)) return '<=64';
    if (['<=256', '<=256px', 'small'].includes(v)) return '<=256';
    if (['<=1024', '<=1024px', 'medium'].includes(v)) return '<=1024';
    if (['>1024', '>1024px', 'large', 'hd'].includes(v)) return '>1024';
    return /^\d+[xX*×]\d+$/.test(v) ? v.replace(/[xX*×]/, 'x') : v;
  }
  if (type === 'width' || type === 'height') {
    if (['<=64', '<=64px', 'tiny'].includes(v)) return '<=64';
    if (['<=256', '<=256px', 'small'].includes(v)) return '<=256';
    if (['<=1024', '<=1024px', 'medium'].includes(v)) return '<=1024';
    if (['>1024', '>1024px', 'large'].includes(v)) return '>1024';
  }
  if (type === 'duration') {
    if (['<5', '<5s', 'sfx', 'short'].includes(v)) return '<5';
    if (['5-30', '5s-30s', '[5 to 30]', '[5s to 30s]'].includes(v)) return '5-30';
    if (['30-120', '30s-2m', '[30 to 120]', '[30s to 2m]'].includes(v)) return '30-120';
    if (['>120', '>2m', 'music'].includes(v)) return '>120';
  }
  if (type === 'bpm') {
    // Only names represent the sidebar's tempo buckets. Numeric comparisons
    // and ranges must keep their exact bounds instead of becoming presets.
    if (['slow', 'slow-tempo'].includes(v)) return 'slow';
    if (['moderate', 'moderate-tempo', 'mid'].includes(v)) return 'moderate';
    if (['fast', 'fast-tempo'].includes(v)) return 'fast';
    if (['very-fast', 'veryfast', 'high', 'high-tempo', 'uptempo'].includes(v)) return 'very-fast';
  }
  return v;
}

/**
 * Sidebar labels are exact names. In search text, an unquoted pack `*` is a
 * wildcard operator and unquoted pack status names are presets; the quoted
 * forms are literal labels. Quote all syntax or SQL wildcard characters so
 * the server can distinguish those meanings without guessing.
 */
function formatLiteralLabel(type: 'tag' | 'pack', value: string): string {
  const simple = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(value);
  const booleanWord = /^(?:AND|OR|NOT)$/i.test(value);
  const packPreset = type === 'pack' && /^(?:any|none|classified|unanalyzed)$/i.test(value);
  if (simple && !booleanWord && !packPreset) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Normalizes and formats a filter value into its search bar token. */
export function formatFilterToken(filterType: FilterType, value: string | null): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;

  switch (filterType) {
    case 'format':
      return `ext:${v.replace(/^\./, '').toLowerCase()}`;
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
      return clean ? `tag:${formatLiteralLabel('tag', clean)}` : null;
    }
    case 'sprite':
      return `sprite:${v.toLowerCase()}`;
    case 'pack':
      return `pack:${formatLiteralLabel('pack', v)}`;
  }
}

/** Legacy token pattern for callers that only need a rough text match. */
export function getFilterPattern(filterType: FilterType): RegExp {
  switch (filterType) {
    case 'format': return /\b(?:ext|format):[^\s]+/gi;
    case 'resolution': return /\b(?:res|resolution):[^\s]+/gi;
    case 'width': return /\b(?:width|w):[^\s]+/gi;
    case 'height': return /\b(?:height|h):[^\s]+/gi;
    case 'duration': return /\b(?:dur|duration):(\[[^\]]+\]|[^\s]+)/gi;
    case 'bpm': return /\b(?:bpm|tempo):(\[[^\]]+\]|[^\s]+)/gi;
    case 'tag': return /(?:^|\s)(?:(?:tag|t):(?:"[^"]*"|[^\s]+)|#[a-zA-Z0-9_\-]+)/gi;
    case 'sprite': return /\b(?:sprite|spritetype):[^\s]+/gi;
    case 'pack': return /\b(?:pack|p):(?:"[^"]*"|[^\s]+)/gi;
  }
}

/** Extracts only unambiguous positive sidebar selections from a query. */
export function parseFiltersFromQuery(query: string): ParsedFilters {
  const result: ParsedFilters = {
    format: null, resolution: null, width: null, height: null,
    duration: null, bpm: null, tag: null, sprite: null, pack: null,
  };
  const tokens = scanQuery(query || '');
  if (!tokens?.length) return result;
  const expression = parseExpression(tokens);
  if (!expression) return result;

  const occurrences = collectOccurrences(expression);
  for (const type of Object.keys(result) as FilterType[]) {
    const matching = occurrences.filter((item) => item.type === type);
    if (!matching.length || matching.some((item) => !item.editable)) continue;
    const values = matching.map((item) => normalizedFilterValue(type, item.value, item.quoted));
    if (values.every((value) => value === values[0])) result[type] = values[0];
  }
  return result;
}

/**
 * Edits positive conjunctive tokens in place. A token within OR or NOT is
 * protected because a single sidebar control cannot represent that logic.
 * Clearing such a token leaves the expression unchanged; setting a value adds
 * a new conjunct without changing the protected expression.
 */
export function updateSearchFilter(currentQuery: string, filterType: FilterType, value: string | null): string {
  const token = formatFilterToken(filterType, value);
  let query = currentQuery || '';
  const firstScan = scanQuery(query);
  if (!firstScan) return query;
  const firstExpression = firstScan.length ? parseExpression(firstScan) : null;
  if (firstScan.length && !firstExpression) return query;

  // Remove from the right so earlier source offsets and literal slices stay intact.
  while (query) {
    const scanned = scanQuery(query);
    const expression = scanned?.length ? parseExpression(scanned) : null;
    if (!expression) break;
    const editable = collectOccurrences(expression)
      .filter((item) => item.type === filterType && item.editable);
    if (editable.length <= (token ? 1 : 0)) break;
    query = removeAtom(query, editable[editable.length - 1].atom);
  }

  if (!token) return query.trim();

  const scanned = scanQuery(query);
  const expression = scanned?.length ? parseExpression(scanned) : null;
  const editable = expression ? collectOccurrences(expression)
    .find((item) => item.type === filterType && item.editable) : null;
  if (editable) {
    return (query.slice(0, editable.atom.start) + token + query.slice(editable.atom.end)).trim();
  }

  if (!query.trim()) return token;
  // Wrapping preserves the meaning of existing OR branches when adding an AND.
  return expression && hasOr(expression) ? `(${query.trim()}) AND ${token}` : `${query.trim()} ${token}`;
}
