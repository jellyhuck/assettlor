import { parse } from 'liqe';
import bytes from 'bytes';

export interface CompiledFilterResult {
  sql: string;
  args: any[];
  isParsed: boolean;
}

/**
 * Pre-processes user input before handing off to the Liqe parser:
 * - Shorthand '#tag' -> 'tag:tag'
 * - Leading dot in format 'format:.wav' -> 'format:wav'
 * - Duration units 'dur:>5s' -> 'dur:>5', 'duration:<1.5m' -> 'duration:<90'
 * - Suffix operator 'size:2MB+' -> 'size:>=2MB'
 * - Suffix operator 'size:2MB-' -> 'size:<=2MB'
 * - Human units in range 'size:[100KB TO 2MB]' -> 'size:[102400 TO 2097152]'
 */
export function preprocessSearchQuery(query: string): string {
  let q = query.trim();

  // Convert shorthand #tag to tag:tag (when preceded by start of string or whitespace)
  q = q.replace(/(^|\s)#([a-zA-Z0-9_\-]+(?::[a-zA-Z0-9_\-]+)?)/g, (match, prefix, tag) => {
    return tag.includes(':') ? `${prefix}tag:"${tag}"` : `${prefix}tag:${tag}`;
  });

  // Strip leading dot in format/ext: e.g. format:.wav -> format:wav
  q = q.replace(/\b(ext|format):\.([a-zA-Z0-9]+)/gi, '$1:$2');

  // Convert human units in range expressions: e.g. size:[100KB TO 2MB]
  q = q.replace(/\bsize:\[\s*([0-9.]+[a-zA-Z]+)\s+TO\s+([0-9.]+[a-zA-Z]+)\s*\]/gi, (_match, minStr, maxStr) => {
    const minBytes = bytes.parse(minStr);
    const maxBytes = bytes.parse(maxStr);
    if (minBytes !== null && maxBytes !== null) {
      return `size:[${minBytes} TO ${maxBytes}]`;
    }
    return _match;
  });

  // Convert duration with units in range expressions: e.g. dur:[5s TO 30s]
  q = q.replace(/\b(dur|duration):\[\s*([0-9.]+)(s|m|h)?\s+TO\s+([0-9.]+)(s|m|h)?\s*\]/gi, (_match, f, minNum, minUnit, maxNum, maxUnit) => {
    let minS = parseFloat(minNum);
    if (minUnit === 'm') minS *= 60;
    if (minUnit === 'h') minS *= 3600;
    let maxS = parseFloat(maxNum);
    if (maxUnit === 'm') maxS *= 60;
    if (maxUnit === 'h') maxS *= 3600;
    return `${f}:[${minS} TO ${maxS}]`;
  });

  // Strip px suffix in width/height: e.g. width:64px -> width:64, width:[64px TO 512px] -> width:[64 TO 512]
  q = q.replace(/\b(width|height|w|h):\[\s*(\d+)px\s+TO\s+(\d+)px\s*\]/gi, '$1:[$2 TO $3]');
  q = q.replace(/\b(width|height|w|h):(>=|<=|>|<|=|:)?(\d+)px\b/gi, '$1:$2$3');

  // Strip bpm suffix in bpm: e.g. bpm:120bpm -> bpm:120
  q = q.replace(/\b(bpm|tempo):(>=|<=|>|<|=|:)?(\d+)bpm\b/gi, '$1:$2$3');

  // Convert duration ranges: dur:5-30 or dur:5s-30s -> dur:[5 TO 30] or dur:[5s TO 30s]
  q = q.replace(/\b(dur|duration):([0-9.]+[smh]?)-([0-9.]+[smh]?)\b/gi, '$1:[$2 TO $3]');

  // Convert bpm ranges: bpm:90-120 -> bpm:[90 TO 120]
  q = q.replace(/\b(bpm|tempo):(\d+)-(\d+)\b/gi, '$1:[$2 TO $3]');

  // Convert size:2MB+ to size:>=2MB
  q = q.replace(/\b([a-zA-Z]+):([0-9.]+[a-zA-Z]*)\+/g, '$1:>=$2');

  // Convert size:2MB- to size:<=2MB (when not followed by digits)
  q = q.replace(/\b([a-zA-Z]+):([0-9.]+[a-zA-Z]*)\-(?!\d)/g, '$1:<=$2');

  // Convert resolution ranges: res:[64x64 TO 512x512] -> (res:>=64x64 AND res:<=512x512)
  q = q.replace(/\b(res|resolution):\[\s*(\d+x\d+)\s+TO\s+(\d+x\d+)\s*\]/gi, '($1:>=$2 AND $1:<=$3)');

  // Convert resolution suffix operators: res:64x64+ -> res:>=64x64, res:64x64- -> res:<=64x64
  q = q.replace(/\b(res|resolution):(\d+x\d+)\+/gi, '$1:>=$2');
  q = q.replace(/\b(res|resolution):(\d+x\d+)\-/gi, '$1:<=$2');
  q = q.replace(/\b(res|resolution):(\d+)\+/gi, '$1:>=$2');
  q = q.replace(/\b(res|resolution):(\d+)\-/gi, '$1:<=$2');

  // Convert duration with units: e.g. dur:>5s -> dur:>5, duration:<1.5m -> duration:<90
  q = q.replace(/\b(dur|duration):(>=|<=|>|<|=|:)?([0-9.]+)(s|m|h)?\b/gi, (_match, f, op, num, unit) => {
    let s = parseFloat(num);
    if (unit === 'm') s *= 60;
    if (unit === 'h') s *= 3600;
    return `${f}:${op || ''}${s}`;
  });

  return q;
}

/**
 * Maps Liqe comparison operator to SQL comparison operator.
 */
function mapComparisonOperator(op?: string): string {
  switch (op) {
    case ':>': return '>';
    case ':>=': return '>=';
    case ':<': return '<';
    case ':<=': return '<=';
    case ':=':
    case ':':
    default: return '=';
  }
}

/**
 * Builds free-text search SQL fragment for a single token/phrase,
 * matching asset name, path, and tags (in stacked and unstacked views).
 */
function buildFreeTextClause(term: string, isStackedView: boolean): { sql: string; args: any[] } {
  const cleanTerm = term.toLowerCase().trim();
  const tParam = `%${cleanTerm}%`;

  if (isStackedView) {
    return {
      sql: `(
        LOWER(a.name) LIKE ? OR
        REPLACE(LOWER(a.name), '_', ' ') LIKE ? OR
        REPLACE(LOWER(a.name), '-', ' ') LIKE ? OR
        LOWER(a.path) LIKE ? OR
        (s.id IS NOT NULL AND (
          LOWER(s.name) LIKE ? OR
          REPLACE(LOWER(s.name), '_', ' ') LIKE ?
        )) OR
        EXISTS (
          SELECT 1 FROM tags t
          WHERE t.asset_id = a.id
            AND (LOWER(t.tag) LIKE ? OR LOWER(t.tag) = ?)
        ) OR
        (a.stack_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM assets m
          WHERE m.stack_id = a.stack_id
            AND (
              LOWER(m.name) LIKE ? OR
              REPLACE(LOWER(m.name), '_', ' ') LIKE ? OR
              REPLACE(LOWER(m.name), '-', ' ') LIKE ? OR
              LOWER(m.path) LIKE ? OR
              EXISTS (
                SELECT 1 FROM tags mt
                WHERE mt.asset_id = m.id
                  AND (LOWER(mt.tag) LIKE ? OR LOWER(mt.tag) = ?)
              )
            )
        ))
      )`,
      args: [
        tParam, tParam, tParam, tParam,
        tParam, tParam,
        tParam, cleanTerm,
        tParam, tParam, tParam, tParam,
        tParam, cleanTerm,
      ],
    };
  }

  return {
    sql: `(
      LOWER(a.name) LIKE ? OR
      REPLACE(LOWER(a.name), '_', ' ') LIKE ? OR
      REPLACE(LOWER(a.name), '-', ' ') LIKE ? OR
      LOWER(a.path) LIKE ? OR
      (s.id IS NOT NULL AND LOWER(s.name) LIKE ?) OR
      EXISTS (
        SELECT 1 FROM tags t
        WHERE t.asset_id = a.id
          AND (LOWER(t.tag) LIKE ? OR LOWER(t.tag) = ?)
      )
    )`,
    args: [
      tParam, tParam, tParam, tParam,
      tParam,
      tParam, cleanTerm,
    ],
  };
}

/**
 * Compiles an individual AST node to a SQL expression and parameters.
 */
function compileAstNode(
  node: any,
  isStackedView: boolean
): { sql: string; args: any[] } | null {
  if (!node || node.type === 'EmptyExpression') {
    return null;
  }

  if (node.type === 'LogicalExpression') {
    const leftRes = compileAstNode(node.left, isStackedView);
    const rightRes = compileAstNode(node.right, isStackedView);

    if (!leftRes && !rightRes) return null;
    if (!leftRes) return rightRes;
    if (!rightRes) return leftRes;

    const op = node.operator && node.operator.operator === 'OR' ? 'OR' : 'AND';
    return {
      sql: `(${leftRes.sql} ${op} ${rightRes.sql})`,
      args: [...leftRes.args, ...rightRes.args],
    };
  }

  if (node.type === 'ParenthesizedExpression') {
    const innerRes = compileAstNode(node.expression, isStackedView);
    if (!innerRes) return null;
    return {
      sql: `(${innerRes.sql})`,
      args: innerRes.args,
    };
  }

  if (node.type === 'UnaryOperator') {
    const operandRes = compileAstNode(node.operand, isStackedView);
    if (!operandRes) return null;
    return {
      sql: `NOT (${operandRes.sql})`,
      args: operandRes.args,
    };
  }

  if (node.type === 'Tag') {
    // 1. Free-text token (ImplicitField)
    if (node.field.type === 'ImplicitField') {
      const term = node.expression?.value !== undefined ? String(node.expression.value) : '';
      if (!term.trim()) return null;
      return buildFreeTextClause(term, isStackedView);
    }

    const fieldName = (node.field.name || '').toLowerCase();
    const op = node.operator?.operator || ':';
    const expr = node.expression;

    if (!expr || expr.type === 'EmptyExpression') {
      return null;
    }

    // 2. Tag: tag:coin, t:coin
    if (fieldName === 'tag' || fieldName === 't') {
      const cleanTag = String(expr.value || '').toLowerCase().trim();
      if (!cleanTag) return null;

      if (isStackedView) {
        return {
          sql: `(
            EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?) OR
            (a.stack_id IS NOT NULL AND EXISTS (
              SELECT 1 FROM assets m JOIN tags mt ON mt.asset_id = m.id
              WHERE m.stack_id = a.stack_id AND LOWER(mt.tag) = ?
            ))
          )`,
          args: [cleanTag, cleanTag],
        };
      }

      return {
        sql: `EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND LOWER(t.tag) = ?)`,
        args: [cleanTag],
      };
    }

    // 2b. Sprite category: sprite:character, sprite:object, sprite:texture, sprite:background, sprite:unclassified
    if (fieldName === 'sprite' || fieldName === 'spritetype') {
      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      return parseSpriteClause(rawVal, isStackedView);
    }

    // 2c. Pack: pack:RetroPack, p:RetroPack
    if (fieldName === 'pack' || fieldName === 'p') {
      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      return parsePackClause(rawVal, isStackedView);
    }

    // 3. Size: size:<2MB, size:>500KB, size:>=1MB, size:[100KB TO 2MB]
    if (fieldName === 'size' || fieldName === 's') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minVal = expr.range.min;
        const maxVal = expr.range.max;
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';
        return {
          sql: `(a.size ${minOp} ? AND a.size ${maxOp} ?)`,
          args: [minVal, maxVal],
        };
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const parsedBytes = bytes.parse(rawVal);
      const byteCount = parsedBytes !== null ? parsedBytes : (Number(rawVal) || 0);
      const sqlOp = mapComparisonOperator(op);

      return {
        sql: `a.size ${sqlOp} ?`,
        args: [byteCount],
      };
    }

    // 4. Extension / Format: ext:png, format:wav
    if (fieldName === 'ext' || fieldName === 'format') {
      let extVal = String(expr.value || '').toLowerCase().trim();
      if (!extVal.startsWith('.')) {
        extVal = '.' + extVal;
      }

      if (isStackedView) {
        return {
          sql: `(LOWER(a.extension) = ? OR (a.stack_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND LOWER(m.extension) = ?
          )))`,
          args: [extVal, extVal],
        };
      }

      return {
        sql: `LOWER(a.extension) = ?`,
        args: [extVal],
      };
    }

    // 5. Category: cat:image, type:audio
    if (fieldName === 'cat' || fieldName === 'type' || fieldName === 'category') {
      const catVal = String(expr.value || '').toLowerCase().trim();
      if (isStackedView) {
        if (catVal === 'image') {
          return { sql: `(a.category = 'image' OR s.type = 'animation')`, args: [] };
        } else if (catVal === 'audio') {
          return { sql: `(a.category = 'audio' OR s.type = 'audio_variation')`, args: [] };
        } else {
          return { sql: `a.category = ?`, args: [catVal] };
        }
      }
      return { sql: `a.category = ?`, args: [catVal] };
    }

    // 6. Path / directory: path:monsters, in:sprites, dir:characters
    if (fieldName === 'path' || fieldName === 'in' || fieldName === 'dir') {
      const pathVal = String(expr.value || '').toLowerCase().trim();
      return {
        sql: `LOWER(a.path) LIKE ?`,
        args: [`%${pathVal}%`],
      };
    }

    // 7. Boolean flags: is:archive, is:disk, is:stacked, is:flat, is:audio, is:image
    if (fieldName === 'is') {
      const flagVal = String(expr.value || '').toLowerCase().trim();
      switch (flagVal) {
        case 'archive':
        case 'zip':
          return { sql: `a.is_archive_entry = 1`, args: [] };
        case 'disk':
        case 'file':
          return { sql: `a.is_archive_entry = 0`, args: [] };
        case 'stacked':
        case 'stack':
          return { sql: `a.stack_id IS NOT NULL`, args: [] };
        case 'flat':
        case 'standalone':
          return { sql: `a.stack_id IS NULL`, args: [] };
        case 'image':
          return isStackedView
            ? { sql: `(a.category = 'image' OR s.type = 'animation')`, args: [] }
            : { sql: `a.category = 'image'`, args: [] };
        case 'audio':
          return isStackedView
            ? { sql: `(a.category = 'audio' OR s.type = 'audio_variation')`, args: [] }
            : { sql: `a.category = 'audio'`, args: [] };
        default:
          return null;
      }
    }

    // 8. Width: width:>128, w:64, width:[64 TO 512], width:tiny
    if (fieldName === 'width' || fieldName === 'w') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minVal = Number(expr.range.min);
        const maxVal = Number(expr.range.max);
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';
        if (isStackedView) {
          return {
            sql: `(((CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${maxOp} ?)) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) ${minOp} ? AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) ${maxOp} ?)))`,
            args: [minVal, maxVal, minVal, maxVal],
          };
        }
        return {
          sql: `(CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${maxOp} ?)`,
          args: [minVal, maxVal],
        };
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const sqlOp = mapComparisonOperator(op);
      return parseWidthClause(rawVal, isStackedView, sqlOp);
    }

    // 9. Height: height:>128, h:64, height:[64 TO 512], height:tiny
    if (fieldName === 'height' || fieldName === 'h') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minVal = Number(expr.range.min);
        const maxVal = Number(expr.range.max);
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';
        if (isStackedView) {
          return {
            sql: `(((CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${maxOp} ?)) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) ${minOp} ? AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) ${maxOp} ?)))`,
            args: [minVal, maxVal, minVal, maxVal],
          };
        }
        return {
          sql: `(CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${maxOp} ?)`,
          args: [minVal, maxVal],
        };
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const sqlOp = mapComparisonOperator(op);
      return parseHeightClause(rawVal, isStackedView, sqlOp);
    }

    // 10. Duration: dur:>5s, duration:<1m, dur:[5 TO 30], dur:short, dur:music
    if (fieldName === 'dur' || fieldName === 'duration') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minVal = Number(expr.range.min);
        const maxVal = Number(expr.range.max);
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';
        if (isStackedView) {
          return {
            sql: `(((CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${maxOp} ?)) OR (s.type = 'audio_variation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) ${minOp} ? AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) ${maxOp} ?)))`,
            args: [minVal, maxVal, minVal, maxVal],
          };
        }
        return {
          sql: `(CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${maxOp} ?)`,
          args: [minVal, maxVal],
        };
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const sqlOp = mapComparisonOperator(op);
      return parseDurationClause(rawVal, isStackedView, sqlOp);
    }

    // 11. BPM / Tempo: bpm:120, bpm:>120, bpm:[80 TO 120], bpm:slow, bpm:fast
    if (fieldName === 'bpm' || fieldName === 'tempo') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minVal = Number(expr.range.min);
        const maxVal = Number(expr.range.max);
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';
        if (isStackedView) {
          return {
            sql: `(((CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) ${maxOp} ?)) OR (s.type = 'audio_variation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) ${minOp} ? AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) ${maxOp} ?)))`,
            args: [minVal, maxVal, minVal, maxVal],
          };
        }
        return {
          sql: `(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) ${minOp} ? AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) ${maxOp} ?)`,
          args: [minVal, maxVal],
        };
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const sqlOp = mapComparisonOperator(op);
      return parseBpmClause(rawVal, isStackedView, sqlOp);
    }

    // 12. Image Resolution: res:64x64, resolution:1920x1080, res:>512x512, res:square, res:1080p, res:tiny, etc.
    if (fieldName === 'res' || fieldName === 'resolution') {
      if (expr.type === 'RangeExpression' && expr.range) {
        const minStr = String(expr.range.min !== undefined ? expr.range.min : '').toLowerCase().trim();
        const maxStr = String(expr.range.max !== undefined ? expr.range.max : '').toLowerCase().trim();
        const minOp = expr.range.minInclusive ? '>=' : '>';
        const maxOp = expr.range.maxInclusive ? '<=' : '<';

        const minMatch = minStr.match(/^(\d+)(?:x(\d+))?$/);
        const maxMatch = maxStr.match(/^(\d+)(?:x(\d+))?$/);

        if (minMatch && maxMatch) {
          const minW = parseInt(minMatch[1], 10);
          const minH = minMatch[2] ? parseInt(minMatch[2], 10) : minW;
          const maxW = parseInt(maxMatch[1], 10);
          const maxH = maxMatch[2] ? parseInt(maxMatch[2], 10) : maxW;

          if (isStackedView) {
            return {
              sql: `((a.category = 'image' AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) ${minOp} ? AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${minOp} ? AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) ${maxOp} ? AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${maxOp} ?) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND CAST(json_extract(m.metadata, '$.width') AS INTEGER) ${minOp} ? AND CAST(json_extract(m.metadata, '$.height') AS INTEGER) ${minOp} ? AND CAST(json_extract(m.metadata, '$.width') AS INTEGER) ${maxOp} ? AND CAST(json_extract(m.metadata, '$.height') AS INTEGER) ${maxOp} ?)))`,
              args: [minW, minH, maxW, maxH, minW, minH, maxW, maxH],
            };
          }
          return {
            sql: `(a.category = 'image' AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) ${minOp} ? AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${minOp} ? AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) ${maxOp} ? AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${maxOp} ?)`,
            args: [minW, minH, maxW, maxH],
          };
        }
      }

      const rawVal = expr.value !== undefined ? String(expr.value) : '';
      const sqlOp = mapComparisonOperator(op);
      return parseResolutionClause(rawVal, isStackedView, sqlOp);
    }

    // Fallback: treat unrecognized field:value as free-text token
    return buildFreeTextClause(`${fieldName}:${expr.value}`, isStackedView);
  }

  return null;
}

/**
 * Compiles an image resolution condition into parameterized SQLite SQL and arguments.
 * Supports:
 * - Exact WxH ('64x64', '1920x1080')
 * - Comparison operators ('>512x512', '<=64x64', '>=256x256')
 * - Aspect ratio presets ('square', 'landscape', 'portrait')
 * - Resolution presets ('tiny', 'small', 'medium', 'large', 'icon', 'hd', '<=64', '<=256', '<=1024', '>1024')
 * - Common formats ('1080p', '720p', '4k')
 * - Single dimension ('64', '>512')
 */
export function parseResolutionClause(
  rawVal: string,
  isStackedView: boolean,
  defaultOp: string = '='
): { sql: string; args: any[] } | null {
  const str = rawVal.trim().toLowerCase();
  if (!str) return null;

  let operator = defaultOp;
  let val = str;
  const leadingOpMatch = str.match(/^(>=|<=|>|<|=)(.*)$/);
  if (leadingOpMatch) {
    operator = leadingOpMatch[1];
    val = leadingOpMatch[2].trim();
  }

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    memberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `((a.category = 'image' AND ${flatCondition}) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND ${stackedMemberCondition})))`,
        args: [...flatArgs, ...memberArgs],
      };
    }
    return {
      sql: `(a.category = 'image' AND ${flatCondition})`,
      args: flatArgs,
    };
  };

  // 1. Aspect ratio presets
  if (val === 'square') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS INTEGER) > 0 AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) = CAST(json_extract(a.metadata, '$.height') AS INTEGER)`,
      `CAST(json_extract(m.metadata, '$.width') AS INTEGER) > 0 AND CAST(json_extract(m.metadata, '$.width') AS INTEGER) = CAST(json_extract(m.metadata, '$.height') AS INTEGER)`,
      [],
      []
    );
  }

  if (val === 'landscape') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS INTEGER) > CAST(json_extract(a.metadata, '$.height') AS INTEGER)`,
      `CAST(json_extract(m.metadata, '$.width') AS INTEGER) > CAST(json_extract(m.metadata, '$.height') AS INTEGER)`,
      [],
      []
    );
  }

  if (val === 'portrait') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS INTEGER) < CAST(json_extract(a.metadata, '$.height') AS INTEGER) AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) > 0`,
      `CAST(json_extract(m.metadata, '$.width') AS INTEGER) < CAST(json_extract(m.metadata, '$.height') AS INTEGER) AND CAST(json_extract(m.metadata, '$.width') AS INTEGER) > 0`,
      [],
      []
    );
  }

  // 2. Video / screen resolution shortcuts
  if (val === '1080p') {
    const cmpOp = operator === '=' ? '>=' : operator;
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${cmpOp} 1080`,
      `CAST(json_extract(m.metadata, '$.height') AS INTEGER) ${cmpOp} 1080`,
      [],
      []
    );
  }

  if (val === '720p') {
    const cmpOp = operator === '=' ? '>=' : operator;
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${cmpOp} 720 AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) < 1080`,
      `CAST(json_extract(m.metadata, '$.height') AS INTEGER) ${cmpOp} 720 AND CAST(json_extract(m.metadata, '$.height') AS INTEGER) < 1080`,
      [],
      []
    );
  }

  if (val === '4k') {
    return buildFinalSql(
      `(CAST(json_extract(a.metadata, '$.width') AS INTEGER) >= 3840 OR CAST(json_extract(a.metadata, '$.height') AS INTEGER) >= 2160)`,
      `(CAST(json_extract(m.metadata, '$.width') AS INTEGER) >= 3840 OR CAST(json_extract(m.metadata, '$.height') AS INTEGER) >= 2160)`,
      [],
      []
    );
  }

  // 3. Preset categories
  if (val === 'tiny' || val === 'icon' || val === '<=64' || val === '<=64px') {
    return buildFinalSql(
      `MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) <= 64 AND CAST(json_extract(a.metadata, '$.width') AS INTEGER) > 0`,
      `MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) <= 64 AND CAST(json_extract(m.metadata, '$.width') AS INTEGER) > 0`,
      [],
      []
    );
  }

  if (val === 'small' || val === '<=256' || val === '<=256px') {
    return buildFinalSql(
      `MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) <= 256 AND MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) > 64`,
      `MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) <= 256 AND MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) > 64`,
      [],
      []
    );
  }

  if (val === 'medium' || val === '<=1024' || val === '<=1024px') {
    return buildFinalSql(
      `MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) <= 1024 AND MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) > 256`,
      `MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) <= 1024 AND MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) > 256`,
      [],
      []
    );
  }

  if (val === 'large' || val === 'hd' || val === '>1024' || val === '>1024px') {
    return buildFinalSql(
      `MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) > 1024`,
      `MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) > 1024`,
      [],
      []
    );
  }

  // 4. Exact or compared dimension: WxH (e.g. 64x64, 1920x1080)
  const dimMatch = val.match(/^(\d+)\s*[xX*×]\s*(\d+)$/);
  if (dimMatch) {
    const w = parseInt(dimMatch[1], 10);
    const h = parseInt(dimMatch[2], 10);
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS INTEGER) ${operator} ? AND CAST(json_extract(a.metadata, '$.height') AS INTEGER) ${operator} ?`,
      `CAST(json_extract(m.metadata, '$.width') AS INTEGER) ${operator} ? AND CAST(json_extract(m.metadata, '$.height') AS INTEGER) ${operator} ?`,
      [w, h],
      [w, h]
    );
  }

  // 5. Single dimension value (e.g. res:>512 or res:64)
  const numMatch = val.match(/^(\d+)(?:px)?$/);
  if (numMatch) {
    const n = parseInt(numMatch[1], 10);
    return buildFinalSql(
      `MAX(CAST(json_extract(a.metadata, '$.width') AS INTEGER), CAST(json_extract(a.metadata, '$.height') AS INTEGER)) ${operator} ?`,
      `MAX(CAST(json_extract(m.metadata, '$.width') AS INTEGER), CAST(json_extract(m.metadata, '$.height') AS INTEGER)) ${operator} ?`,
      [n],
      [n]
    );
  }

  return null;
}

/**
 * Compiles an image width condition into parameterized SQLite SQL and arguments.
 */
export function parseWidthClause(
  rawVal: string,
  isStackedView: boolean,
  defaultOp: string = '='
): { sql: string; args: any[] } | null {
  const str = rawVal.trim().toLowerCase();
  if (!str) return null;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    memberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `((${flatCondition}) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND ${stackedMemberCondition})))`,
        args: [...flatArgs, ...memberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  // Range formats: [64 TO 512], 64-512, 64 TO 512
  const rangeMatch = str.match(/^\[?\s*(\d+)\s*(?:TO|-)\s*(\d+)\s*\]?$/i);
  if (rangeMatch) {
    const minW = parseInt(rangeMatch[1], 10);
    const maxW = parseInt(rangeMatch[2], 10);
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) >= ? AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) <= ?`,
      `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) >= ? AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) <= ?`,
      [minW, maxW],
      [minW, maxW]
    );
  }

  // Presets
  if (str === 'tiny' || str === '<=64' || str === '<=64px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) <= 64 AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) > 0`,
      `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) <= 64 AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) > 0`,
      [],
      []
    );
  }
  if (str === 'small' || str === '<=256' || str === '<=256px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) <= 256 AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) > 64`,
      `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) <= 256 AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) > 64`,
      [],
      []
    );
  }
  if (str === 'medium' || str === '<=1024' || str === '<=1024px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) <= 1024 AND CAST(json_extract(a.metadata, '$.width') AS NUMERIC) > 256`,
      `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) <= 1024 AND CAST(json_extract(m.metadata, '$.width') AS NUMERIC) > 256`,
      [],
      []
    );
  }
  if (str === 'large' || str === '>1024' || str === '>1024px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) > 1024`,
      `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) > 1024`,
      [],
      []
    );
  }

  let operator = defaultOp;
  let val = str;
  const leadingOpMatch = str.match(/^(>=|<=|>|<|=)(.*)$/);
  if (leadingOpMatch) {
    operator = leadingOpMatch[1];
    val = leadingOpMatch[2].trim();
  }

  const numMatch = val.match(/^(\d+)(?:px)?$/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[1], 10);

  return buildFinalSql(
    `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${operator} ?`,
    `CAST(json_extract(m.metadata, '$.width') AS NUMERIC) ${operator} ?`,
    [num],
    [num]
  );
}

/**
 * Compiles an image height condition into parameterized SQLite SQL and arguments.
 */
export function parseHeightClause(
  rawVal: string,
  isStackedView: boolean,
  defaultOp: string = '='
): { sql: string; args: any[] } | null {
  const str = rawVal.trim().toLowerCase();
  if (!str) return null;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    memberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `((${flatCondition}) OR (s.type = 'animation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND ${stackedMemberCondition})))`,
        args: [...flatArgs, ...memberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  // Range formats: [64 TO 512], 64-512, 64 TO 512
  const rangeMatch = str.match(/^\[?\s*(\d+)\s*(?:TO|-)\s*(\d+)\s*\]?$/i);
  if (rangeMatch) {
    const minH = parseInt(rangeMatch[1], 10);
    const maxH = parseInt(rangeMatch[2], 10);
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) >= ? AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= ?`,
      `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) >= ? AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) <= ?`,
      [minH, maxH],
      [minH, maxH]
    );
  }

  // Presets
  if (str === 'tiny' || str === '<=64' || str === '<=64px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= 64 AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) > 0`,
      `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) <= 64 AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) > 0`,
      [],
      []
    );
  }
  if (str === 'small' || str === '<=256' || str === '<=256px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= 256 AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) > 64`,
      `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) <= 256 AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) > 64`,
      [],
      []
    );
  }
  if (str === 'medium' || str === '<=1024' || str === '<=1024px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) <= 1024 AND CAST(json_extract(a.metadata, '$.height') AS NUMERIC) > 256`,
      `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) <= 1024 AND CAST(json_extract(m.metadata, '$.height') AS NUMERIC) > 256`,
      [],
      []
    );
  }
  if (str === 'large' || str === '>1024' || str === '>1024px') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) > 1024`,
      `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) > 1024`,
      [],
      []
    );
  }

  let operator = defaultOp;
  let val = str;
  const leadingOpMatch = str.match(/^(>=|<=|>|<|=)(.*)$/);
  if (leadingOpMatch) {
    operator = leadingOpMatch[1];
    val = leadingOpMatch[2].trim();
  }

  const numMatch = val.match(/^(\d+)(?:px)?$/);
  if (!numMatch) return null;
  const num = parseInt(numMatch[1], 10);

  return buildFinalSql(
    `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${operator} ?`,
    `CAST(json_extract(m.metadata, '$.height') AS NUMERIC) ${operator} ?`,
    [num],
    [num]
  );
}

/**
 * Compiles an audio duration condition into parameterized SQLite SQL and arguments.
 */
export function parseDurationClause(
  rawVal: string,
  isStackedView: boolean,
  defaultOp: string = '='
): { sql: string; args: any[] } | null {
  const str = rawVal.trim().toLowerCase();
  if (!str) return null;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    memberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `((${flatCondition}) OR (s.type = 'audio_variation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND ${stackedMemberCondition})))`,
        args: [...flatArgs, ...memberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  const parseSec = (valStr: string): number | null => {
    const m = valStr.trim().match(/^([0-9.]+)(s|m|h)?$/);
    if (!m) return null;
    let s = parseFloat(m[1]);
    if (isNaN(s)) return null;
    if (m[2] === 'm') s *= 60;
    if (m[2] === 'h') s *= 3600;
    return s;
  };

  // Range formats: [5 TO 30], 5s-30s, 5-30, [5s TO 1m]
  const rangeMatch = str.match(/^\[?\s*([0-9.]+[smh]?)\s*(?:TO|-)\s*([0-9.]+[smh]?)\s*\]?$/i);
  if (rangeMatch) {
    const minS = parseSec(rangeMatch[1]);
    const maxS = parseSec(rangeMatch[2]);
    if (minS !== null && maxS !== null) {
      return buildFinalSql(
        `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) >= ? AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) <= ?`,
        `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) >= ? AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) <= ?`,
        [minS, maxS],
        [minS, maxS]
      );
    }
  }

  // Presets
  if (str === 'short' || str === 'sfx' || str === '<5' || str === '<5s') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) < 5 AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) > 0`,
      `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) < 5 AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) > 0`,
      [],
      []
    );
  }
  if (str === 'medium' || str === '5-30' || str === '5s-30s') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) >= 5 AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) <= 30`,
      `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) >= 5 AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) <= 30`,
      [],
      []
    );
  }
  if (str === 'long' || str === '30-120' || str === '30s-2m') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) > 30 AND CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) <= 120`,
      `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) > 30 AND CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) <= 120`,
      [],
      []
    );
  }
  if (str === 'music' || str === '>120' || str === '>2m') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) > 120`,
      `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) > 120`,
      [],
      []
    );
  }

  let operator = defaultOp;
  let val = str;
  const leadingOpMatch = str.match(/^(>=|<=|>|<|=)(.*)$/);
  if (leadingOpMatch) {
    operator = leadingOpMatch[1];
    val = leadingOpMatch[2].trim();
  }

  const s = parseSec(val);
  if (s === null) return null;

  return buildFinalSql(
    `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${operator} ?`,
    `CAST(json_extract(m.metadata, '$.duration') AS NUMERIC) ${operator} ?`,
    [s],
    [s]
  );
}

/**
 * Compiles a BPM (tempo) condition into parameterized SQLite SQL and arguments.
 */
export function parseBpmClause(
  rawVal: string,
  isStackedView: boolean,
  defaultOp: string = '='
): { sql: string; args: any[] } | null {
  const str = rawVal.trim().toLowerCase();
  if (!str) return null;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    memberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `((${flatCondition}) OR (s.type = 'audio_variation' AND EXISTS (SELECT 1 FROM assets m WHERE m.stack_id = a.stack_id AND ${stackedMemberCondition})))`,
        args: [...flatArgs, ...memberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  // Presets
  if (str === 'slow' || str === 'slow-tempo' || str === '<90' || str === '<80') {
    return buildFinalSql(
      `(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) > 0 AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) < 90) OR LOWER(json_extract(a.metadata, '$.tempoDescription')) = 'slow-tempo'`,
      `(CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) > 0 AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) < 90) OR LOWER(json_extract(m.metadata, '$.tempoDescription')) = 'slow-tempo'`,
      [],
      []
    );
  }
  if (str === 'moderate' || str === 'moderate-tempo' || str === 'mid' || str === '90-120') {
    return buildFinalSql(
      `(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) >= 90 AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= 120) OR LOWER(json_extract(a.metadata, '$.tempoDescription')) = 'moderate-tempo'`,
      `(CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) >= 90 AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) <= 120) OR LOWER(json_extract(m.metadata, '$.tempoDescription')) = 'moderate-tempo'`,
      [],
      []
    );
  }
  if (str === 'fast' || str === 'fast-tempo' || str === '120-160') {
    return buildFinalSql(
      `(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) > 120 AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= 160) OR LOWER(json_extract(a.metadata, '$.tempoDescription')) = 'fast-tempo'`,
      `(CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) > 120 AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) <= 160) OR LOWER(json_extract(m.metadata, '$.tempoDescription')) = 'fast-tempo'`,
      [],
      []
    );
  }
  if (str === 'very-fast' || str === 'veryfast' || str === '>160' || str === 'uptempo' || str === '>150') {
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) > 160 OR LOWER(json_extract(a.metadata, '$.tempoDescription')) = 'uptempo'`,
      `CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) > 160 OR LOWER(json_extract(m.metadata, '$.tempoDescription')) = 'uptempo'`,
      [],
      []
    );
  }
  if (str === 'none' || str === 'unclassified' || str === 'unanalyzed') {
    return buildFinalSql(
      `(json_extract(a.metadata, '$.bpm') IS NULL OR CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= 0)`,
      `(json_extract(m.metadata, '$.bpm') IS NULL OR CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) <= 0)`,
      [],
      []
    );
  }
  if (str === 'any' || str === 'classified' || str === 'analyzed' || str === 'detected') {
    return buildFinalSql(
      `json_extract(a.metadata, '$.bpm') IS NOT NULL AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) > 0`,
      `json_extract(m.metadata, '$.bpm') IS NOT NULL AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) > 0`,
      [],
      []
    );
  }

  // Range formats: [80 TO 120], 80-120, 80 TO 120
  const rangeMatch = str.match(/^\[?\s*(\d+)\s*(?:TO|-)\s*(\d+)\s*\]?$/i);
  if (rangeMatch) {
    const minBpm = parseInt(rangeMatch[1], 10);
    const maxBpm = parseInt(rangeMatch[2], 10);
    return buildFinalSql(
      `CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) >= ? AND CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) <= ?`,
      `CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) >= ? AND CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) <= ?`,
      [minBpm, maxBpm],
      [minBpm, maxBpm]
    );
  }

  let operator = defaultOp;
  let val = str;
  const leadingOpMatch = str.match(/^(>=|<=|>|<|=)(.*)$/);
  if (leadingOpMatch) {
    operator = leadingOpMatch[1];
    val = leadingOpMatch[2].trim();
  }

  const num = parseFloat(val);
  if (isNaN(num)) {
    // If not a number, allow direct match on tempoDescription
    return buildFinalSql(
      `LOWER(json_extract(a.metadata, '$.tempoDescription')) = ?`,
      `LOWER(json_extract(m.metadata, '$.tempoDescription')) = ?`,
      [str],
      [str]
    );
  }

  if (operator === '=') {
    return buildFinalSql(
      `ROUND(CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC)) = ?`,
      `ROUND(CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC)) = ?`,
      [Math.round(num)],
      [Math.round(num)]
    );
  }

  return buildFinalSql(
    `CAST(json_extract(a.metadata, '$.bpm') AS NUMERIC) ${operator} ?`,
    `CAST(json_extract(m.metadata, '$.bpm') AS NUMERIC) ${operator} ?`,
    [num],
    [num]
  );
}

/**
 * Compiles a sprite category condition into parameterized SQLite SQL and arguments.
 * Allows searching by sprite label: sprite:character, sprite:object, sprite:texture, sprite:background, sprite:unclassified
 */
export function parseSpriteClause(
  rawVal: string,
  isStackedView: boolean
): { sql: string; args: any[] } | null {
  const spriteVal = rawVal.toLowerCase().trim();
  if (!spriteVal) return null;
  const spriteTag = `sprite:${spriteVal}`;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    stackedMemberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `(
          ${flatCondition} OR
          (a.stack_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM assets m
            WHERE m.stack_id = a.stack_id AND (
              ${stackedMemberCondition}
            )
          ))
        )`,
        args: [...flatArgs, ...stackedMemberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  // Status presets: sprite:none / sprite:unanalyzed
  if (spriteVal === 'none' || spriteVal === 'unanalyzed') {
    return buildFinalSql(
      `(json_extract(a.metadata, '$.spriteType') IS NULL OR LOWER(json_extract(a.metadata, '$.spriteType')) = 'unclassified')`,
      `(json_extract(m.metadata, '$.spriteType') IS NULL OR LOWER(json_extract(m.metadata, '$.spriteType')) = 'unclassified')`,
      [],
      []
    );
  }

  // Status presets: sprite:any / sprite:detected / sprite:classified
  if (spriteVal === 'any' || spriteVal === 'detected' || spriteVal === 'classified') {
    return buildFinalSql(
      `(json_extract(a.metadata, '$.spriteType') IS NOT NULL AND LOWER(json_extract(a.metadata, '$.spriteType')) != 'unclassified')`,
      `(json_extract(m.metadata, '$.spriteType') IS NOT NULL AND LOWER(json_extract(m.metadata, '$.spriteType')) != 'unclassified')`,
      [],
      []
    );
  }

  // Standard category: character, object, texture, background, unclassified
  // Preserves backward-compatible check for manual/legacy tags if present, while matching metadata
  return buildFinalSql(
    `(LOWER(json_extract(a.metadata, '$.spriteType')) = ? OR EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND (LOWER(t.tag) = ? OR LOWER(t.tag) = ?)))`,
    `(LOWER(json_extract(m.metadata, '$.spriteType')) = ? OR EXISTS (SELECT 1 FROM tags mt WHERE mt.asset_id = m.id AND (LOWER(mt.tag) = ? OR LOWER(mt.tag) = ?)))`,
    [spriteVal, spriteTag, spriteVal],
    [spriteVal, spriteTag, spriteVal]
  );
}

/**
 * Builds SQL condition for pack filter: pack:RetroPack, pack:retro*, pack:none, pack:any
 */
export function parsePackClause(
  rawVal: string,
  isStackedView: boolean
): { sql: string; args: any[] } | null {
  const packVal = rawVal.toLowerCase().trim();
  if (!packVal) return null;

  const buildFinalSql = (
    flatCondition: string,
    stackedMemberCondition: string,
    flatArgs: any[],
    stackedMemberArgs: any[]
  ) => {
    if (isStackedView) {
      return {
        sql: `(
          ${flatCondition} OR
          (a.stack_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM assets m
            WHERE m.stack_id = a.stack_id AND (
              ${stackedMemberCondition}
            )
          ))
        )`,
        args: [...flatArgs, ...stackedMemberArgs],
      };
    }
    return {
      sql: flatCondition,
      args: flatArgs,
    };
  };

  // Status presets: pack:none / pack:unanalyzed
  if (packVal === 'none' || packVal === 'unanalyzed') {
    return buildFinalSql(
      `json_extract(a.metadata, '$.pack') IS NULL`,
      `json_extract(m.metadata, '$.pack') IS NULL`,
      [],
      []
    );
  }

  // Status presets: pack:any / pack:classified
  if (packVal === 'any' || packVal === 'classified') {
    return buildFinalSql(
      `json_extract(a.metadata, '$.pack') IS NOT NULL`,
      `json_extract(m.metadata, '$.pack') IS NOT NULL`,
      [],
      []
    );
  }

  const isWildcard = packVal.includes('*') || packVal.includes('%');
  const sqlPattern = isWildcard ? packVal.replace(/\*/g, '%') : `%${packVal}%`;
  const packTag = `pack:${packVal}`;

  return buildFinalSql(
    `(
      LOWER(json_extract(a.metadata, '$.pack')) LIKE ? OR
      LOWER(json_extract(a.metadata, '$.pack')) = ? OR
      EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND (LOWER(t.tag) = ? OR LOWER(t.tag) = ? OR LOWER(t.tag) LIKE ?))
    )`,
    `(
      LOWER(json_extract(m.metadata, '$.pack')) LIKE ? OR
      LOWER(json_extract(m.metadata, '$.pack')) = ? OR
      EXISTS (SELECT 1 FROM tags mt WHERE mt.asset_id = m.id AND (LOWER(mt.tag) = ? OR LOWER(mt.tag) = ? OR LOWER(mt.tag) LIKE ?))
    )`,
    [sqlPattern, packVal, packTag, packVal, sqlPattern],
    [sqlPattern, packVal, packTag, packVal, sqlPattern]
  );
}

/**
 * Fallback parser used when Liqe throws an error (e.g. while a user is actively typing).
 * Splits raw query into simple whitespace-separated keywords and applies fuzzy LIKE matching.
 */
function compileFallbackQuery(rawQuery: string, isStackedView: boolean): CompiledFilterResult {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return { sql: '', args: [], isParsed: false };
  }

  const clauses: string[] = [];
  const args: any[] = [];

  for (const token of tokens) {
    if (token.startsWith('#')) {
      const cleanTag = token.slice(1).toLowerCase().trim();
      const tLikeParam = `%${cleanTag}%`;
      if (isStackedView) {
        clauses.push(`(
          EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND (LOWER(t.tag) = ? OR LOWER(t.tag) LIKE ?)) OR
          (a.stack_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM assets m
            JOIN tags mt ON mt.asset_id = m.id
            WHERE m.stack_id = a.stack_id AND (LOWER(mt.tag) = ? OR LOWER(mt.tag) LIKE ?)
          ))
        )`);
        args.push(cleanTag, tLikeParam, cleanTag, tLikeParam);
      } else {
        clauses.push(`EXISTS (SELECT 1 FROM tags t WHERE t.asset_id = a.id AND (LOWER(t.tag) = ? OR LOWER(t.tag) LIKE ?))`);
        args.push(cleanTag, tLikeParam);
      }
    } else if (token.toLowerCase().startsWith('res:') || token.toLowerCase().startsWith('resolution:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const resClause = parseResolutionClause(val, isStackedView);
      if (resClause) {
        clauses.push(resClause.sql);
        args.push(...resClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('bpm:') || token.toLowerCase().startsWith('tempo:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const bpmClause = parseBpmClause(val, isStackedView);
      if (bpmClause) {
        clauses.push(bpmClause.sql);
        args.push(...bpmClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('sprite:') || token.toLowerCase().startsWith('spritetype:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const spriteClause = parseSpriteClause(val, isStackedView);
      if (spriteClause) {
        clauses.push(spriteClause.sql);
        args.push(...spriteClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('pack:') || token.toLowerCase().startsWith('p:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const packClause = parsePackClause(val, isStackedView);
      if (packClause) {
        clauses.push(packClause.sql);
        args.push(...packClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('width:') || token.toLowerCase().startsWith('w:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const widthClause = parseWidthClause(val, isStackedView);
      if (widthClause) {
        clauses.push(widthClause.sql);
        args.push(...widthClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('height:') || token.toLowerCase().startsWith('h:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const heightClause = parseHeightClause(val, isStackedView);
      if (heightClause) {
        clauses.push(heightClause.sql);
        args.push(...heightClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else if (token.toLowerCase().startsWith('dur:') || token.toLowerCase().startsWith('duration:')) {
      const colonIdx = token.indexOf(':');
      const val = token.slice(colonIdx + 1);
      const durClause = parseDurationClause(val, isStackedView);
      if (durClause) {
        clauses.push(durClause.sql);
        args.push(...durClause.args);
      } else {
        const freeRes = buildFreeTextClause(token, isStackedView);
        clauses.push(freeRes.sql);
        args.push(...freeRes.args);
      }
    } else {
      const freeRes = buildFreeTextClause(token, isStackedView);
      clauses.push(freeRes.sql);
      args.push(...freeRes.args);
    }
  }

  return {
    sql: clauses.join(' AND '),
    args,
    isParsed: false,
  };
}

/**
 * Main entry point: Compiles a user search query into parameterized SQLite SQL and arguments.
 *
 * @param query Raw search query from input box or API
 * @param isStackedView Whether the query executes under stacked view rules
 */
export function compileFilterExpression(
  query: string,
  isStackedView: boolean
): CompiledFilterResult {
  if (!query || !query.trim()) {
    return { sql: '', args: [], isParsed: false };
  }

  const preprocessed = preprocessSearchQuery(query);

  try {
    const ast = parse(preprocessed);
    const compiled = compileAstNode(ast, isStackedView);

    if (!compiled || !compiled.sql.trim()) {
      return { sql: '', args: [], isParsed: true };
    }

    return {
      sql: compiled.sql,
      args: compiled.args,
      isParsed: true,
    };
  } catch (_err) {
    // Graceful fallback for any parse error during typing
    return compileFallbackQuery(query, isStackedView);
  }
}
