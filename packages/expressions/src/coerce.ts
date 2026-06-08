import type { ExprValue } from './types.js';
import { numberToG15 } from './g15.js';

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
  return true;
}

// ── Equality (== / !=) ───────────────────────────────────────────────────────

export function typeKind(v: ExprValue): 'null' | 'boolean' | 'number' | 'string' | 'array' | 'object' {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return 'boolean';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'array';
  return 'object';
}

export function isCollection(v: ExprValue): boolean {
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
