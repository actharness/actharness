// Public ExprValue — the six types the expression engine operates on.
export type ExprValue =
  | null
  | boolean
  | number
  | string
  | ExprValue[]
  | { [k: string]: ExprValue };

// ── Token ────────────────────────────────────────────────────────────────────

export type TokenKind =
  | 'BOOL' | 'NULL' | 'NUMBER' | 'STRING' | 'IDENT'
  | 'LPAREN' | 'RPAREN' | 'LBRACKET' | 'RBRACKET'
  | 'DOT' | 'STAR' | 'COMMA'
  | 'BANG' | 'MINUS'
  | 'AND' | 'OR'
  | 'EQ' | 'NEQ' | 'LT' | 'LTE' | 'GT' | 'GTE'
  | 'EOF';

export interface Token {
  kind: TokenKind;
  raw: string;
  pos: number;
}

// ── AST ──────────────────────────────────────────────────────────────────────

export type Ast =
  | { kind: 'Literal'; value: ExprValue }
  | { kind: 'Ident'; name: string }
  | { kind: 'Prop'; object: Ast; key: string }
  | { kind: 'Index'; object: Ast; index: Ast }
  | { kind: 'Filter'; object: Ast; variant: 'dot' | 'bracket' }
  | { kind: 'Call'; name: string; args: Ast[] }
  | { kind: 'Unary'; op: '!' | '-'; operand: Ast }
  | { kind: 'Binary'; op: '||' | '&&' | '==' | '!=' | '<' | '<=' | '>' | '>='; left: Ast; right: Ast };

// ── ExpressionContexts ───────────────────────────────────────────────────────

export interface ExpressionContexts {
  github?: unknown;
  env?: unknown;
  inputs?: unknown;
  steps?: unknown;
  runner?: unknown;
  secrets?: unknown;
  matrix?: unknown;
  strategy?: unknown;
  job?: unknown;
  needs?: unknown;
  vars?: unknown;
  status?: { success: boolean; failure: boolean; cancelled: boolean };
  functions?: Record<string, (...args: ExprValue[]) => ExprValue>;
}
