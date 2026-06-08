import { describe, test, expect } from 'vitest';
import { evaluate, evaluateTemplate, parse, ExpressionError } from '../src/index.js';
import type { Token } from '../src/index.js';

// ── Number formatting edge cases (g15) ───────────────────────────────────────

describe('evaluate: number-to-string edge cases', () => {
  test('-Infinity coerces to string "-Infinity"', () => {
    expect(evaluate("format('{0}', a)", { a: -Infinity })).toBe('-Infinity');
  });

  test('1e14 formats without decimal point (dp=0 fixed path)', () => {
    expect(evaluate("format('{0}', a)", { a: 1e14 })).toBe('100000000000000');
  });
});

// ── Coerce: array / object → NaN ─────────────────────────────────────────────

describe('evaluate: coerceToNumber on collection', () => {
  test('unary minus on array yields NaN', () => {
    // coerceToNumber([1,2]) hits the array/object → NaN fallback
    expect(evaluate("-fromJSON('[1,2]')")).toBeNaN();
  });
});

// ── Evaluator: applyFilter on scalar ─────────────────────────────────────────

describe('evaluate: filter on scalar', () => {
  test('(1).* → null (scalar is not a collection)', () => {
    expect(evaluate('(1).*')).toBe(null);
  });
});

// ── Parser: EOF synthetic token fallbacks ────────────────────────────────────

describe('parse: synthetic EOF fallback', () => {
  test('empty token array — consume() fallback triggers, nud(EOF) throws', () => {
    expect(() => parse([] as Token[])).toThrow(ExpressionError);
  });

  test('single token — peek() fallback returns synthetic EOF after consuming it', () => {
    const ast = parse([{ kind: 'NUMBER', raw: '42', pos: 0 }]);
    expect(ast).toEqual({ kind: 'Literal', value: 42 });
  });
});

// ── String ordering: equal strings and >= operator ───────────────────────────

describe('evaluate: string ordering edge cases', () => {
  test("'a' >= 'a' → true (ordCmp=0, >= falls through all if-checks to final return)", () => {
    expect(evaluate("'a' >= 'a'")).toBe(true);
  });

  test("'b' > 'a' → true (exercises op === '>' true branch in string compare)", () => {
    expect(evaluate("'b' > 'a'")).toBe(true);
  });
});

// ── getProperty / getIndex edge cases ────────────────────────────────────────

describe('evaluate: property and index access edge cases', () => {
  test('property not found on object → null (hasOwnProperty false path)', () => {
    expect(evaluate('github.nonexistent', { github: {} })).toBe(null);
  });

  test('property with undefined value → null (record[key] ?? null path)', () => {
    // github: { b: undefined } — key is own property but value is undefined
    expect(evaluate('github.b', { github: { b: undefined } as unknown })).toBe(null);
  });

  test('array index out of bounds → null', () => {
    expect(evaluate('github[10]', { github: [1, 2, 3] as unknown })).toBe(null);
  });

  test('array element undefined → null (obj[index] ?? null path)', () => {
    expect(evaluate('github[0]', { github: [undefined] as unknown })).toBe(null);
  });
});

// ── Ident: undefined context value ───────────────────────────────────────────

describe('evaluate: context value edge cases', () => {
  test('context key present with undefined value → null', () => {
    // v === undefined ? null : v — the null branch
    expect(evaluate('github', { github: undefined })).toBe(null);
  });
});

// ── Call: function lookup edge cases ─────────────────────────────────────────

describe('evaluate: function call edge cases', () => {
  test('camelCase ctx.functions key matched by original ast.name', () => {
    // ctx.functions['hashfiles'] is absent; ctx.functions['hashFiles'] is present
    const result = evaluate("hashFiles('x')", { functions: { hashFiles: () => 'camel' } });
    expect(result).toBe('camel');
  });

  test('unknown function throws ExpressionError', () => {
    // fn is undefined → !fn branch
    expect(() => evaluate('unknownFunc()')).toThrow(ExpressionError);
  });
});

// ── evaluateTemplate edge cases ───────────────────────────────────────────────

describe('evaluateTemplate: edge cases', () => {
  test('plain text with no expressions returns the text as-is', () => {
    // nonEmpty has one text segment (not expr) → takes the concat path
    expect(evaluateTemplate('hello world')).toBe('hello world');
  });

  test('unclosed ${{ is returned as literal text', () => {
    // indexOf("}}") returns -1 → pushes remaining input as text and breaks
    expect(evaluateTemplate('${{ unclosed')).toBe('${{ unclosed');
  });
});
