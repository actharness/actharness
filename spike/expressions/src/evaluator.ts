import { type Ast, type ExprValue, type ExpressionContexts } from './types.js';
import { numberToG15 } from './g15.js';
import { ExpressionError } from './tokenizer.js';

// ── Coercions ────────────────────────────────────────────────────────────────

export function coerceToNumber(v: ExprValue): number {
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const trimmed = v.trim();
    if (trimmed === '') return 0;
    // ParseNumber: hex, octal, scientific, decimal (≈ JS Number())
    const n = Number(trimmed);
    return isNaN(n) ? NaN : n;
  }
  // array / object → NaN
  return NaN;
}

export function coerceToString(v: ExprValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberToG15(v);
  if (Array.isArray(v)) return 'Array';
  return 'Object';
}

export function isTruthy(v: ExprValue): boolean {
  if (v === null || v === false || v === '' || v === 0) return false;
  if (typeof v === 'number' && isNaN(v)) return false;
  // -0 is falsy
  if (Object.is(v, -0)) return false;
  // arrays, objects, non-empty strings, non-zero numbers, true → truthy
  return true;
}

// ── Equality (== / !=) ───────────────────────────────────────────────────────

function typeKind(v: ExprValue): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

function isCollection(v: ExprValue): boolean {
  return Array.isArray(v) || (v !== null && typeof v === 'object');
}

export function exprEquals(a: ExprValue, b: ExprValue): boolean {
  const ka = typeKind(a);
  const kb = typeKind(b);

  if (ka === kb) {
    // Same type comparison
    if (ka === 'null') return true;
    if (ka === 'number') {
      if (isNaN(a as number) || isNaN(b as number)) return false;
      return a === b;
    }
    if (ka === 'boolean') return a === b;
    if (ka === 'string') return (a as string).toLowerCase() === (b as string).toLowerCase();
    // array / object: reference equality — always false for distinct instances
    return a === b;
  }

  // Different types: coerce per CoerceTypes rules.
  // Object/array vs anything → false (no coercion).
  if (isCollection(a) || isCollection(b)) return false;

  // boolean/null cast to number first, then recurse.
  if (ka === 'boolean') return exprEquals(coerceToNumber(a), b);
  if (kb === 'boolean') return exprEquals(a, coerceToNumber(b));
  if (ka === 'null') return exprEquals(coerceToNumber(a), b);
  if (kb === 'null') return exprEquals(a, coerceToNumber(b));

  // string ↔ number: cast string to number.
  const na = coerceToNumber(a);
  const nb = coerceToNumber(b);
  if (isNaN(na) || isNaN(nb)) return false;
  return na === nb;
}

// ── Ordering (< <= > >=) ─────────────────────────────────────────────────────

export function exprCompare(a: ExprValue, b: ExprValue, op: '<' | '<=' | '>' | '>='): boolean {
  const ka = typeKind(a);
  const kb = typeKind(b);

  // Objects/arrays never coerce for ordering → false.
  if (isCollection(a) || isCollection(b)) return false;

  if (ka === kb) {
    if (ka === 'string') {
      // OrdinalIgnoreCase — NOT number coercion.
      const la = (a as string).toLowerCase();
      const lb = (b as string).toLowerCase();
      const ordCmp = la < lb ? -1 : la > lb ? 1 : 0;
      if (op === '<') return ordCmp < 0;
      if (op === '<=') return ordCmp <= 0;
      if (op === '>') return ordCmp > 0;
      return ordCmp >= 0;
    }
    // number, boolean: numeric comparison
  }

  // Different types or non-string same-type: coerce both to number.
  const na = coerceToNumber(a);
  const nb = coerceToNumber(b);
  if (isNaN(na) || isNaN(nb)) return false;
  if (op === '<') return na < nb;
  if (op === '<=') return na <= nb;
  if (op === '>') return na > nb;
  return na >= nb;
}

// ── Object filter (.*  /  [*]) ───────────────────────────────────────────────

function applyFilter(obj: ExprValue): ExprValue {
  if (obj === null) return null;
  // Array: .* returns the elements themselves (the array is already a collection).
  if (Array.isArray(obj)) return [...obj] as ExprValue;
  // Object: .* returns the property values.
  if (typeof obj === 'object') return Object.values(obj) as ExprValue[];
  return null;
}

// ── Property / index access ──────────────────────────────────────────────────

function getProperty(obj: ExprValue, key: string): ExprValue {
  if (obj === null) return null;
  // Arrays produced by filters propagate property access over elements (fruits.*.name).
  if (Array.isArray(obj)) return obj.map(el => getProperty(el, key)) as ExprValue;
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
    return search.some(el => exprEquals(el, item));
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
      if (isNaN(idx) || idx < 0) throw new ExpressionError(`Invalid format index '${indexStr}'`, 0);
      if (idx >= args.length) throw new ExpressionError(`format() references more arguments than were supplied (index ${idx}, ${args.length} args)`, 0);
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
  contains: (s, i) => fnContains(s ?? null, i ?? null),
  startswith: (s, p) => fnStartsWith(s ?? null, p ?? null),
  endswith: (s, x) => fnEndsWith(s ?? null, x ?? null),
  format: (fmt, ...args) => fnFormat(fmt ?? null, ...args),
  join: (arr, sep) => fnJoin(arr ?? null, sep),
  tojson: (v) => fnToJSON(v ?? null),
  fromjson: (v) => fnFromJSON(v ?? null),
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
        // Coerce non-ExprValue context values to ExprValue tree (plain objects/arrays pass through)
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
      // Check runtime-registered functions first, then builtins.
      const fn = ctx.functions?.[nameLower] ?? ctx.functions?.[ast.name] ?? BUILTINS[nameLower];
      if (!fn) throw new ExpressionError(`Unknown function '${ast.name}'`, 0);
      const args = ast.args.map(a => evaluate(a, ctx));
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
