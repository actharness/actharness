import { type Token, type Ast } from './types.js';
import { ExpressionError } from './tokenizer.js';

// Binding powers — left denotation (infix/postfix position)
const BP: Partial<Record<string, number>> = {
  OR: 10, AND: 20, EQ: 30, NEQ: 30,
  LT: 40, LTE: 40, GT: 40, GTE: 40,
  DOT: 60, LBRACKET: 60, LPAREN: 60,
};

export function parse(tokens: Token[]): Ast {
  let pos = 0;

  function peek(): Token { return tokens[pos] ?? { kind: 'EOF', raw: '', pos: -1 }; }
  function consume(): Token { return tokens[pos++] ?? { kind: 'EOF', raw: '', pos: -1 }; }
  function expect(kind: string): Token {
    const t = consume();
    if (t.kind !== kind) throw new ExpressionError(`Expected ${kind} but got ${t.kind} ('${t.raw}')`, t.pos);
    return t;
  }

  function parseExpr(rbp = 0): Ast {
    const t = consume();
    let left = nud(t);
    while ((BP[peek().kind] ?? 0) > rbp) {
      left = led(consume(), left);
    }
    return left;
  }

  function nud(t: Token): Ast {
    switch (t.kind) {
      case 'BOOL':    return { kind: 'Literal', value: t.raw === 'true' };
      case 'NULL':    return { kind: 'Literal', value: null };
      case 'NUMBER':  return { kind: 'Literal', value: parseNumber(t.raw) };
      case 'STRING':  return { kind: 'Literal', value: t.raw };

      case 'IDENT': {
        // Function call?
        if (peek().kind === 'LPAREN') {
          consume(); // consume '('
          const args: Ast[] = [];
          if (peek().kind !== 'RPAREN') {
            args.push(parseExpr(0));
            while (peek().kind === 'COMMA') { consume(); args.push(parseExpr(0)); }
          }
          expect('RPAREN');
          return { kind: 'Call', name: t.raw, args };
        }
        return { kind: 'Ident', name: t.raw };
      }

      case 'LPAREN': {
        const inner = parseExpr(0);
        expect('RPAREN');
        return inner;
      }

      case 'BANG':  return { kind: 'Unary', op: '!', operand: parseExpr(50) };
      case 'MINUS': return { kind: 'Unary', op: '-', operand: parseExpr(50) };

      default:
        throw new ExpressionError(`Unexpected token '${t.raw}' (${t.kind})`, t.pos);
    }
  }

  function led(t: Token, left: Ast): Ast {
    switch (t.kind) {
      case 'OR':  return { kind: 'Binary', op: '||', left, right: parseExpr(9)  };
      case 'AND': return { kind: 'Binary', op: '&&', left, right: parseExpr(19) };
      case 'EQ':  return { kind: 'Binary', op: '==', left, right: parseExpr(30) };
      case 'NEQ': return { kind: 'Binary', op: '!=', left, right: parseExpr(30) };
      case 'LT':  return { kind: 'Binary', op: '<',  left, right: parseExpr(40) };
      case 'LTE': return { kind: 'Binary', op: '<=', left, right: parseExpr(40) };
      case 'GT':  return { kind: 'Binary', op: '>',  left, right: parseExpr(40) };
      case 'GTE': return { kind: 'Binary', op: '>=', left, right: parseExpr(40) };

      case 'DOT': {
        const next = consume();
        if (next.kind === 'STAR') return { kind: 'Filter', object: left, variant: 'dot' };
        if (next.kind === 'IDENT' || next.kind === 'STRING')
          return { kind: 'Prop', object: left, key: next.raw };
        throw new ExpressionError(`Expected property name after '.', got '${next.raw}'`, next.pos);
      }

      case 'LBRACKET': {
        // [*] filter
        if (peek().kind === 'STAR') {
          consume();
          expect('RBRACKET');
          return { kind: 'Filter', object: left, variant: 'bracket' };
        }
        const index = parseExpr(0);
        expect('RBRACKET');
        return { kind: 'Index', object: left, index };
      }

      default:
        throw new ExpressionError(`Unexpected infix token '${t.raw}'`, t.pos);
    }
  }

  const ast = parseExpr(0);
  if (peek().kind !== 'EOF') {
    const t = peek();
    throw new ExpressionError(`Unexpected token '${t.raw}' after expression`, t.pos);
  }
  return ast;
}

function parseNumber(raw: string): number {
  if (raw === 'NaN') return NaN;
  if (raw === 'Infinity') return Infinity;
  if (raw.startsWith('0x') || raw.startsWith('0X')) return parseInt(raw, 16);
  return parseFloat(raw);
}
