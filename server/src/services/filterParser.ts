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
  q = q.replace(/(^|\s)#([a-zA-Z0-9_\-]+)/g, (match, prefix, tag) => {
    return `${prefix}tag:${tag}`;
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

  // Convert size:2MB+ to size:>=2MB
  q = q.replace(/\b([a-zA-Z]+):([0-9.]+[a-zA-Z]*)\+/g, '$1:>=$2');

  // Convert size:2MB- to size:<=2MB
  q = q.replace(/\b([a-zA-Z]+):([0-9.]+[a-zA-Z]*)\-/g, '$1:<=$2');

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

    // 8. Dimensions: width:>128, w:64, height:<=512, h:32
    if (fieldName === 'width' || fieldName === 'w') {
      const num = Number(expr.value);
      if (isNaN(num)) return null;
      const sqlOp = mapComparisonOperator(op);
      return {
        sql: `CAST(json_extract(a.metadata, '$.width') AS NUMERIC) ${sqlOp} ?`,
        args: [num],
      };
    }

    if (fieldName === 'height' || fieldName === 'h') {
      const num = Number(expr.value);
      if (isNaN(num)) return null;
      const sqlOp = mapComparisonOperator(op);
      return {
        sql: `CAST(json_extract(a.metadata, '$.height') AS NUMERIC) ${sqlOp} ?`,
        args: [num],
      };
    }

    // 9. Duration: dur:>5s, duration:<1m
    if (fieldName === 'dur' || fieldName === 'duration') {
      const num = Number(expr.value);
      if (isNaN(num)) return null;
      const sqlOp = mapComparisonOperator(op);
      return {
        sql: `CAST(json_extract(a.metadata, '$.duration') AS NUMERIC) ${sqlOp} ?`,
        args: [num],
      };
    }

    // Fallback: treat unrecognized field:value as free-text token
    return buildFreeTextClause(`${fieldName}:${expr.value}`, isStackedView);
  }

  return null;
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
