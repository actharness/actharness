/**
 * Corpus test harness — runs every case in corpus/expressions/*.json.
 *
 * Gate: all 149 seed vectors must pass (H1–H3 hypotheses).
 * Also verifies H4 (template typing) with a small inline fixture.
 * hashFiles is stubbed via the functions hook (real impl is out of spike scope).
 */
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluate, evaluateTemplate, ExpressionError } from '../src/index.js';
import type { ExprValue, ExpressionContexts } from '../src/index.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const corpusDir = join(__dir, '../../../corpus/expressions');

// ── $number sentinel ─────────────────────────────────────────────────────────

function decodeExpected(raw: unknown): ExprValue | { $number: string } {
  return raw as ExprValue | { $number: string };
}

function matchesExpected(actual: ExprValue, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && '$number' in expected) {
    const special = (expected as { $number: string }).$number;
    if (special === 'NaN') return typeof actual === 'number' && isNaN(actual);
    if (special === 'Infinity') return actual === Infinity;
    if (special === '-Infinity') return actual === -Infinity;
  }
  // Deep equality for plain values and nested objects.
  return JSON.stringify(actual) === JSON.stringify(expected);
}

// ── Case types ────────────────────────────────────────────────────────────────

interface CorpusCase {
  expr: string;
  context?: Record<string, unknown>;
  expect?: unknown;
  error?: string;
  // metadata ignored
  [k: string]: unknown;
}

interface CorpusFile {
  context?: Record<string, unknown>; // file-level default context
  cases: CorpusCase[];
}

// ── hashFiles stub ────────────────────────────────────────────────────────────
// Real implementation (glob + SHA-256) is out of spike scope.
// The only corpus case is `hashFiles('**/non-extant-files')` → '' which
// the stub satisfies since nothing matches in the spike dir.
function hashFilesStub(_pattern: ExprValue): ExprValue { return ''; }

function makeCtx(raw: Record<string, unknown> | undefined): ExpressionContexts {
  if (!raw) return { functions: { hashfiles: hashFilesStub } };
  return { ...raw, functions: { hashfiles: hashFilesStub } } as ExpressionContexts;
}

// ── Load and run each corpus file ─────────────────────────────────────────────

const files = readdirSync(corpusDir)
  .filter(f => f.endsWith('.json'))
  .sort();

for (const file of files) {
  const raw = JSON.parse(readFileSync(join(corpusDir, file), 'utf8')) as CorpusFile;
  const fileCtx = raw.context;

  describe(file, () => {
    for (const c of raw.cases) {
      const label = c.expr.length > 80 ? c.expr.slice(0, 77) + '…' : c.expr;
      test(label, () => {
        // Merge file-level context with case-level context (case wins).
        const ctx = makeCtx(c.context ?? fileCtx);

        if (c.error !== undefined) {
          expect(() => evaluate(c.expr, ctx), `should throw for: ${c.expr}`)
            .toThrow(c.error);
          return;
        }

        const actual = evaluate(c.expr, ctx);
        expect(
          matchesExpected(actual, c.expect),
          `expr: ${c.expr}\nexpected: ${JSON.stringify(c.expect)}\nactual:   ${JSON.stringify(actual)}`
        ).toBe(true);
      });
    }
  });
}

// ── H4: template typing ───────────────────────────────────────────────────────

describe('evaluateTemplate — H4 template typing', () => {
  test('bare ${{ fromJSON(...) }} preserves object type', () => {
    const result = evaluateTemplate("${{ fromJSON('{\"a\":1}') }}", {});
    expect(result).toEqual({ a: 1 });
    expect(typeof result).toBe('object');
  });

  test('${{ ... }} in surrounding text coerces to string', () => {
    const result = evaluateTemplate("value is ${{ fromJSON('{\"a\":1}') }}!", {});
    expect(result).toBe('value is Object!');
  });

  test('multiple expressions concatenated as strings', () => {
    const result = evaluateTemplate('${{ true }}-${{ 1 }}', {});
    expect(result).toBe('true-1');
  });

  test('no expressions → literal passthrough', () => {
    expect(evaluateTemplate('hello world', {})).toBe('hello world');
  });
});

// ── Nasty dozen — named explicitly so they can't be skipped ──────────────────
// These are re-run as a named group for the spike gate (they also appear in the
// corpus files above; duplicating here proves the gate bites on each one).

describe('nasty dozen (gate bites)', () => {
  test('N01 hex string → 255 (not NaN)', () => {
    expect(evaluate("'0xff' == 255")).toBe(true);
  });
  test('N02 G15 integral double', () => {
    expect(evaluate("format('{0}', 1.0)")).toBe('1');
  });
  test('N03 G15 exponential uppercase E', () => {
    expect(evaluate("format('{0}', 12345678901234567890.0)")).toBe('1.23456789012346E+19');
  });
  test('N04 same-type string ordering is OrdinalIgnoreCase, not NaN', () => {
    expect(evaluate("'b' >= 'a'")).toBe(true);
  });
  test('N05 case-insensitive string equality', () => {
    expect(evaluate("'TEST' == 'test'")).toBe(true);
  });
  test('N06 && / || return the operand', () => {
    expect(evaluate("null || 'abc'")).toBe('abc');
    expect(evaluate("'abc' || true")).toBe('abc');
    expect(evaluate("false && null")).toBe(false);
  });
  test("N07 object equality = reference (two fromJSON instances → false)", () => {
    expect(evaluate("fromJSON('{}') == fromJSON('{}')")).toBe(false);
  });
  test("N08 'false' and '0' are truthy; '', 0, null, NaN are falsy", () => {
    expect(evaluate("!'false'")).toBe(false);
    expect(evaluate("!'0'")).toBe(false);
    expect(evaluate("!''")).toBe(true);
    expect(evaluate("!0")).toBe(true);
    expect(evaluate("!null")).toBe(true);
  });
  test('N09 array contains uses loose == (bool vs string → NaN → false)', () => {
    expect(evaluate("contains(fromJSON('[true]'), 'true')")).toBe(false);
  });
  test('N10 array/object coerce to Array/Object under string coercion', () => {
    expect(evaluate("format('Hello {0} {1}', fromJSON('[1]'), fromJSON('{}'))"))
      .toBe('Hello Array Object');
  });
  test('N11 format error messages', () => {
    expect(() => evaluate("format('{0', '{1}', 'World')")).toThrow('Unclosed brackets');
    expect(() => evaluate("format('{0}}', '{1}', 'World')")).toThrow('Closing bracket');
  });
  test('N12 missing dereference → null, never throws', () => {
    expect(evaluate('missing.deep.ref')).toBe(null);
  });
});
