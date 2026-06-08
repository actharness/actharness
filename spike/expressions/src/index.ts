import { type ExprValue, type ExpressionContexts, type Token, type Ast } from './types.js';
import { tokenize as _tokenize } from './tokenizer.js';
import { parse as _parse } from './parser.js';
import { evaluate as _evaluate } from './evaluator.js';
import { coerceToString } from './evaluator.js';

export { ExpressionError } from './tokenizer.js';
export type { ExprValue, ExpressionContexts, Token, Ast };

/**
 * Evaluate a single expression body (no surrounding `${{ }}`).
 * Type is preserved: fromJSON('{...}') → object, not string.
 */
export function evaluate(expr: string, contexts: ExpressionContexts = {}): ExprValue {
  const tokens = _tokenize(expr);
  const ast = _parse(tokens);
  return _evaluate(ast, contexts);
}

/**
 * Evaluate a full template string (may contain one or more `${{ ... }}` embedded in text).
 * - Exactly `${{ expr }}` (nothing else) → preserves the expression's type.
 * - Surrounding text or multiple `${{ }}` → each expression coerced to string, concatenated.
 */
export function evaluateTemplate(input: string, contexts: ExpressionContexts = {}): ExprValue {
  // Collect all segments: literal text and `${{ expr }}` blocks.
  const segments: Array<{ kind: 'text'; text: string } | { kind: 'expr'; body: string }> = [];
  let i = 0;
  while (i < input.length) {
    const start = input.indexOf('${{', i);
    if (start === -1) { segments.push({ kind: 'text', text: input.slice(i) }); break; }
    if (start > i) segments.push({ kind: 'text', text: input.slice(i, start) });
    const end = input.indexOf('}}', start + 3);
    if (end === -1) { segments.push({ kind: 'text', text: input.slice(start) }); break; }
    segments.push({ kind: 'expr', body: input.slice(start + 3, end).trim() });
    i = end + 2;
  }

  // If the entire input is exactly one expression block, preserve its type.
  const exprSegs = segments.filter(s => s.kind === 'expr' || s.text !== '');
  const nonEmpty = exprSegs.filter(s => s.kind === 'expr' || (s.kind === 'text' && s.text.length > 0));
  if (nonEmpty.length === 1 && nonEmpty[0]!.kind === 'expr') {
    return evaluate(nonEmpty[0]!.body, contexts);
  }

  // Mixed — coerce every expression to string and concatenate.
  let result = '';
  for (const seg of segments) {
    if (seg.kind === 'text') { result += seg.text; continue; }
    const val = evaluate(seg.body, contexts);
    result += coerceToString(val);
  }
  return result;
}

// Lower-level access for tooling.
export { _tokenize as tokenize, _parse as parse };
