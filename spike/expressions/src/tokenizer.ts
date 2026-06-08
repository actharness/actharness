import { type Token, type TokenKind } from './types.js';

export class ExpressionError extends Error {
  constructor(message: string, public pos: number) {
    super(message);
    this.name = 'ExpressionError';
  }
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    // Skip whitespace
    if (/\s/.test(input[i]!)) { i++; continue; }

    const pos = i;
    const ch = input[i]!;

    // Two-char operators (check before single-char)
    const two = input.slice(i, i + 2);
    if (two === '||') { tokens.push({ kind: 'OR',  raw: two, pos }); i += 2; continue; }
    if (two === '&&') { tokens.push({ kind: 'AND', raw: two, pos }); i += 2; continue; }
    if (two === '==') { tokens.push({ kind: 'EQ',  raw: two, pos }); i += 2; continue; }
    if (two === '!=') { tokens.push({ kind: 'NEQ', raw: two, pos }); i += 2; continue; }
    if (two === '<=') { tokens.push({ kind: 'LTE', raw: two, pos }); i += 2; continue; }
    if (two === '>=') { tokens.push({ kind: 'GTE', raw: two, pos }); i += 2; continue; }
    if (two === '.*') { tokens.push({ kind: 'DOT', raw: '.', pos }); tokens.push({ kind: 'STAR', raw: '*', pos: pos + 1 }); i += 2; continue; }

    // Single-char tokens
    const singleKind: Record<string, TokenKind> = {
      '(': 'LPAREN', ')': 'RPAREN', '[': 'LBRACKET', ']': 'RBRACKET',
      '.': 'DOT', '*': 'STAR', ',': 'COMMA', '!': 'BANG',
      '<': 'LT', '>': 'GT', '-': 'MINUS',
    };
    if (ch in singleKind) {
      tokens.push({ kind: singleKind[ch]!, raw: ch, pos }); i++; continue;
    }

    // Number: digits, or 0x hex
    if (/[0-9]/.test(ch)) {
      const start = i;
      if (input[i] === '0' && (input[i + 1] === 'x' || input[i + 1] === 'X')) {
        i += 2;
        while (i < input.length && /[0-9a-fA-F]/.test(input[i]!)) i++;
      } else {
        while (i < input.length && /[0-9]/.test(input[i]!)) i++;
        if (i < input.length && input[i] === '.') {
          i++;
          while (i < input.length && /[0-9]/.test(input[i]!)) i++;
        }
        if (i < input.length && (input[i] === 'e' || input[i] === 'E')) {
          i++;
          if (i < input.length && (input[i] === '+' || input[i] === '-')) i++;
          while (i < input.length && /[0-9]/.test(input[i]!)) i++;
        }
      }
      const raw = input.slice(start, i);
      tokens.push({ kind: 'NUMBER', raw, pos });
      continue;
    }

    // String: single-quoted, '' escape
    if (ch === "'") {
      i++;
      let value = '';
      while (i < input.length) {
        if (input[i] === "'") {
          if (input[i + 1] === "'") { value += "'"; i += 2; }
          else { i++; break; }
        } else {
          value += input[i++];
        }
      }
      tokens.push({ kind: 'STRING', raw: value, pos });
      continue;
    }

    // Identifiers and keywords: [A-Za-z_][A-Za-z0-9_-]*
    // Hyphens are allowed mid-identifier (e.g. fail-fast, step-id).
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < input.length && /[A-Za-z0-9_\-]/.test(input[i]!)) i++;
      const raw = input.slice(start, i);

      if (raw === 'true')      { tokens.push({ kind: 'BOOL',   raw, pos }); continue; }
      if (raw === 'false')     { tokens.push({ kind: 'BOOL',   raw, pos }); continue; }
      if (raw === 'null')      { tokens.push({ kind: 'NULL',   raw, pos }); continue; }
      if (raw === 'NaN')       { tokens.push({ kind: 'NUMBER', raw, pos }); continue; }
      if (raw === 'Infinity')  { tokens.push({ kind: 'NUMBER', raw, pos }); continue; }
      tokens.push({ kind: 'IDENT', raw, pos });
      continue;
    }

    throw new ExpressionError(`Unexpected character '${ch}'`, i);
  }

  tokens.push({ kind: 'EOF', raw: '', pos: input.length });
  return tokens;
}
