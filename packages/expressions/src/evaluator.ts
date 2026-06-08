import type { Ast, ExprValue, ExpressionContexts } from './types.js';
import { ExpressionError } from './tokenizer.js';
import {
  coerceToNumber,
  coerceToString,
  isTruthy,
  exprEquals,
  exprCompare,
} from './coerce.js';
import { hashFiles as hashFilesDefault } from './hash-files.js';

// ── Object filter (.*  /  [*]) ───────────────────────────────────────────────

function applyFilter(obj: ExprValue): ExprValue {
  if (obj === null) return null;
  // Array: .* returns the elements themselves (identity).
  if (Array.isArray(obj)) return [...obj] as ExprValue;
  // Object: .* returns the property values.
  if (typeof obj === 'object') return Object.values(obj) as ExprValue[];
  return null;
}

// ── Property / index access ──────────────────────────────────────────────────

function getProperty(obj: ExprValue, key: string): ExprValue {
  if (obj === null) return null;
  // Arrays produced by filters propagate property access over elements (commits.*.author).
  if (Array.isArray(obj)) return obj.map((el) => getProperty(el, key)) as ExprValue;
  if (typeof obj !== 'object') return null;
  const record = obj as Record<string, ExprValue>;
  return Object.prototype.hasOwnProperty.call(record, key) ? (record[key] ?? null) : null;
}

function getIndex(obj: ExprValue, index: ExprValue): ExprValue {
  if (typeof index === 'string') return getProperty(obj, index);
  if (typeof index === 'number') {
    if (!Number.isInteger(index) || index < 0) return null;
    if (!Array.isArray(obj)) return null;
    return index < obj.length ? (obj[index] ?? null) : null;
  }
  return null;
}

// ── Built-in functions ───────────────────────────────────────────────────────

function fnContains(search: ExprValue, item: ExprValue): ExprValue {
  if (Array.isArray(search)) {
    return search.some((el) => exprEquals(el, item));
  }
  // coerce both to string, case-insensitive substring
  const s = coerceToString(search).toLowerCase();
  const it = coerceToString(item).toLowerCase();
  return s.includes(it);
}

function fnStartsWith(s: ExprValue, prefix: ExprValue): ExprValue {
  return coerceToString(s).toLowerCase().startsWith(coerceToString(prefix).toLowerCase());
}

function fnEndsWith(s: ExprValue, suffix: ExprValue): ExprValue {
  return coerceToString(s).toLowerCase().endsWith(coerceToString(suffix).toLowerCase());
}

// INT32_MAX — runner throws "invalid format string" for indices above this value
const INT32_MAX = 2147483647;

function fnFormat(fmt: ExprValue, ...args: ExprValue[]): ExprValue {
  const fmtStr = coerceToString(fmt);
  let result = '';
  let i = 0;
  while (i < fmtStr.length) {
    const ch = fmtStr[i]!;
    if (ch === '{') {
      if (fmtStr[i + 1] === '{') { result += '{'; i += 2; continue; }
      // Find closing }
      const j = fmtStr.indexOf('}', i + 1);
      if (j === -1) throw new ExpressionError('Unclosed brackets in format string', 0);
      const indexStr = fmtStr.slice(i + 1, j);
      const idx = parseInt(indexStr, 10);
      // int32 overflow, non-numeric index, or negative → invalid format string
      if (isNaN(idx) || idx < 0 || idx > INT32_MAX) {
        throw new ExpressionError('invalid format string', 0);
      }
      if (idx >= args.length) {
        throw new ExpressionError(
          `format() references more arguments than were supplied (index ${idx}, ${args.length} args)`,
          0,
        );
      }
      result += coerceToString(args[idx]!);
      i = j + 1;
    } else if (ch === '}') {
      if (fmtStr[i + 1] === '}') { result += '}'; i += 2; continue; }
      throw new ExpressionError('Closing bracket without opening one in format string', 0);
    } else {
      result += ch; i++;
    }
  }
  return result;
}

function fnJoin(arr: ExprValue, sep?: ExprValue): ExprValue {
  // undefined = no arg → default ','; null arg → ''; anything else → coerced string.
  const separator = sep === undefined ? ',' : sep === null ? '' : coerceToString(sep);
  if (!Array.isArray(arr)) return coerceToString(arr);
  return arr.map(coerceToString).join(separator);
}

function fnToJSON(v: ExprValue): ExprValue {
  return JSON.stringify(v, null, 2);
}

function fnFromJSON(v: ExprValue): ExprValue {
  try { return JSON.parse(coerceToString(v)) as ExprValue; }
  catch { throw new ExpressionError('Invalid JSON in fromJSON()', 0); }
}

const BUILTINS: Record<string, (...args: ExprValue[]) => ExprValue> = {
  contains:   (s, i) => fnContains(s ?? null, i ?? null),
  startswith: (s, p) => fnStartsWith(s ?? null, p ?? null),
  endswith:   (s, x) => fnEndsWith(s ?? null, x ?? null),
  format:     (fmt, ...args) => fnFormat(fmt ?? null, ...args),
  join:       (arr, sep) => fnJoin(arr ?? null, sep),
  tojson:     (v) => fnToJSON(v ?? null),
  fromjson:   (v) => fnFromJSON(v ?? null),
  hashfiles:  (...args) => hashFilesDefault(...args),
};

// ── Evaluator ────────────────────────────────────────────────────────────────

export function evaluate(ast: Ast, ctx: ExpressionContexts): ExprValue {
  switch (ast.kind) {
    case 'Literal': return ast.value;

    case 'Ident': {
      const name = ast.name;
      const ctxRecord = ctx as Record<string, unknown>;
      if (Object.prototype.hasOwnProperty.call(ctxRecord, name)) {
        const v = ctxRecord[name];
        return (v === undefined ? null : v) as ExprValue;
      }
      return null;
    }

    case 'Prop': {
      const obj = evaluate(ast.object, ctx);
      return getProperty(obj, ast.key);
    }

    case 'Index': {
      const obj = evaluate(ast.object, ctx);
      const idx = evaluate(ast.index, ctx);
      return getIndex(obj, idx);
    }

    case 'Filter': {
      const obj = evaluate(ast.object, ctx);
      return applyFilter(obj);
    }

    case 'Call': {
      const nameLower = ast.name.toLowerCase();
      // Check runtime-registered functions first (ctx.functions), then builtins.
      const fn = ctx.functions?.[nameLower] ?? ctx.functions?.[ast.name] ?? BUILTINS[nameLower];
      if (!fn) throw new ExpressionError(`Unknown function '${ast.name}'`, 0);
      const args = ast.args.map((a) => evaluate(a, ctx));
      return fn(...args);
    }

    case 'Unary': {
      const v = evaluate(ast.operand, ctx);
      if (ast.op === '!') return !isTruthy(v);
      // '-': numeric negation
      return -coerceToNumber(v);
    }

    case 'Binary': {
      const { op, left, right } = ast;
      if (op === '&&') {
        const lv = evaluate(left, ctx);
        return isTruthy(lv) ? evaluate(right, ctx) : lv;
      }
      if (op === '||') {
        const lv = evaluate(left, ctx);
        return isTruthy(lv) ? lv : evaluate(right, ctx);
      }
      const lv = evaluate(left, ctx);
      const rv = evaluate(right, ctx);
      if (op === '==') return exprEquals(lv, rv);
      if (op === '!=') return !exprEquals(lv, rv);
      return exprCompare(lv, rv, op);
    }
  }
}

// Re-export coerceToString for use in evaluateTemplate
export { coerceToString };
