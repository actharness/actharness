/**
 * Parser/evaluator fuzz tests — CI gate (non-blocking vs act oracle).
 *
 * Property: for any string input, the engine either:
 *   (a) returns an ExprValue, or
 *   (b) throws ExpressionError
 *
 * It must NEVER throw a non-ExpressionError (e.g. TypeError, RangeError).
 * This is the "no crashes; balanced errors for malformed input" criterion.
 */
import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import { evaluate, evaluateTemplate, ExpressionError } from '../src/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeEvaluate(input: string): boolean {
  try {
    evaluate(input);
    return true;
  } catch (e) {
    if (e instanceof ExpressionError) return true;
    // Any other error type is a crash → property fails.
    return false;
  }
}

function safeEvaluateTemplate(input: string): boolean {
  try {
    evaluateTemplate(input);
    return true;
  } catch (e) {
    if (e instanceof ExpressionError) return true;
    return false;
  }
}

// ── Fuzz: arbitrary string inputs ─────────────────────────────────────────────

describe('fuzz: parser/eval never crashes on arbitrary input', () => {
  test('evaluate(arbitrary string) → value or ExpressionError only', () => {
    fc.assert(
      fc.property(fc.string(), (input) => safeEvaluate(input)),
      { numRuns: 10_000, seed: 42 },
    );
  });

  test('evaluateTemplate(arbitrary string) → value or ExpressionError only', () => {
    fc.assert(
      fc.property(fc.string(), (input) => safeEvaluateTemplate(input)),
      { numRuns: 5_000, seed: 42 },
    );
  });
});

// ── Fuzz: grammar-guided inputs ───────────────────────────────────────────────
// Generate structurally plausible expressions from grammar fragments.
// These have a higher chance of exercising deep code paths.

const literal = fc.oneof(
  fc.constant('null'),
  fc.constant('true'),
  fc.constant('false'),
  fc.constant('NaN'),
  fc.constant('Infinity'),
  fc.integer({ min: -1000, max: 1000 }).map(String),
  fc.double({ min: -1e10, max: 1e10, noNaN: true }).map(String),
  fc.stringMatching(/^[a-z0-9 ]*$/).map((s) => `'${s.replace(/'/g, "''")}'`),
);

const identifier = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).map((s) => s);

// Builds a shallow expression (no deep recursion to avoid exponential blowup).
const shallowExpr: fc.Arbitrary<string> = fc.oneof(
  literal,
  identifier,
  fc.tuple(literal, literal).map(([a, b]) => `${a} == ${b}`),
  fc.tuple(literal, literal).map(([a, b]) => `${a} != ${b}`),
  fc.tuple(literal, literal).map(([a, b]) => `${a} || ${b}`),
  fc.tuple(literal, literal).map(([a, b]) => `${a} && ${b}`),
  fc.tuple(literal, literal).map(([a, b]) => `${a} < ${b}`),
  literal.map((v) => `!${v}`),
  literal.map((v) => `contains(${v}, ${v})`),
  literal.map((v) => `format('hi {0}', ${v})`),
  literal.map((v) => `join(fromJSON('[1,2,3]'), ${v})`),
);

describe('fuzz: grammar-guided expressions do not crash', () => {
  test('structurally valid expressions → value or ExpressionError only', () => {
    fc.assert(
      fc.property(shallowExpr, (input) => safeEvaluate(input)),
      { numRuns: 5_000, seed: 42 },
    );
  });
});

// ── Regression: known tricky inputs ──────────────────────────────────────────

describe('fuzz: known tricky inputs never throw non-ExpressionError', () => {
  const tricky = [
    '', ' ', '(', ')', '[[', ']]', '{{', '}}',
    "'", "''", "'''", "''''",
    '==', '!=', '||', '&&',
    'null.foo', 'null[0]', 'null.*',
    'format()', 'format(null)', "format('{}')",
    "format('{0}')", "format('{-1}')", "format('{2147483647}')", "format('{2147483648}')",
    "format('{9999999999}')",
    'contains()', 'join()', 'fromJSON()', "fromJSON('invalid')",
    'toJSON()', 'startsWith()', 'endsWith()',
    'true.foo', 'false[0]', '1.foo',
    'a.b.c.d.e.f.g',
    '!!!!true',
    'null || null || null || null',
  ];

  for (const input of tricky) {
    test(`${JSON.stringify(input)}`, () => {
      expect(safeEvaluate(input)).toBe(true);
    });
  }
});
