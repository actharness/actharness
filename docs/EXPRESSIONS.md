# actspec — Expression language spec (`@actspec/expressions`)

Normative spec for the GitHub Actions `${{ … }}` expression engine. **MUST/MUST NOT** are binding on the implementation.

## Why this doc is grounded, not from memory
The semantics below were reconciled against two authoritative sources, because a from-memory spec was provably wrong in two subtle places (see [Fidelity notes](#fidelity-notes-grounding-history)):
- **`nektos/act`** — `pkg/exprparser/interpreter.go` (implementation) + `interpreter_test.go` (vectors). A mature Go port with tests; used as the **oracle**.
- **GitHub docs** — *Evaluate expressions in workflows and actions* (operators, functions, coercion rules).
- The **C# runner** (`Sdk/DTExpressions`) is the ultimate reference; the conformance corpus harvests its test cases too.

> A prototype evaluator written from memory passed its own tests but encoded two wrong rules. That's the circularity trap: testing a reimplementation against your own expectations proves nothing about fidelity. The corpus (oracle-sourced vectors) is the real gate — see [Conformance corpus](#conformance-corpus).

## Pipeline
`tokenize → parse (precedence climbing) → evaluate(ast, contexts)`. Plus `evaluateTemplate(str, contexts)` for strings with embedded `${{ }}` and surrounding literal text.

## Data types
Six types: **null, boolean, number, string, array, object**. Numbers are IEEE-754 doubles (`NaN` is reachable via coercion). Arrays/objects come from contexts or `fromJSON`.

## Lexical grammar
- **Boolean**: `true`, `false`.
- **Null**: `null`.
- **Number literal**: any JSON number format **plus** hex and exponent — `711`, `-9.2`, `0xff`, `-2.99e-2`. (Note: this is the *literal* grammar; string→number *coercion* is stricter — see below.)
- **String literal**: single-quoted. A literal single quote is escaped by doubling it: `'it''s'` → `it's`. **Double quotes MUST throw.**
- **Identifier**: context property name, `[A-Za-z_][A-Za-z0-9_-]*` (hyphens allowed; ambiguity with `-` is resolved by the tokenizer — `-` is an operator only between operands). Hyphenated/special keys also reachable via `['…']`.
- Whitespace is insignificant.

## Operators & precedence
Lowest → highest binding:

| Prec | Operators | Assoc |
|------|-----------|-------|
| 1 | `\|\|` | left |
| 2 | `&&` | left |
| 3 | `==` `!=` | left |
| 4 | `<` `<=` `>` `>=` | left |
| 5 | `!` (unary), `-` (unary, numeric negation) | right |
| 6 | postfix: `.` `[ ]` `( )` (call), `.*` `[*]` (filter) | left |
| 7 | primary: literal, identifier, `( expr )` | — |

**There are no arithmetic operators** (`+ - * /` as binary ops do not exist). `-` exists only as numeric negation of a literal/operand.

## Semantics

### Coercion to number
| From | To number |
|------|-----------|
| number | itself |
| null | `0` |
| boolean | `true`→`1`, `false`→`0` |
| string | **`ExpressionUtility.ParseNumber`** (≈ JS `Number()`): trim → `''`→`0`; decimal/float/exponent/leading-sign → that value; **`0x…` hex → value; `0o…` octal → value**; `Infinity`/`-Infinity`/`NaN` → those; **else `NaN`** |
| array / object | `NaN` |

> **`'0xff'` (string) → `255`, NOT `NaN`.** The runner parses hex/octal strings (source: `ParseNumber`). The GitHub *docs* say "legal JSON number format," which is **imprecise** — JSON has no hex, but the runner does. Verified against the C# source, not the docs. (This *reverses* an earlier from-docs draft — see [Fidelity notes](#fidelity-notes-grounding-history).)

### Coercion to string (for interpolation / `format`)
- null→`''`, boolean→`'true'`/`'false'`, string→itself.
- **number → C# `"G15"` invariant-culture format**, NOT JS `toString`. Uppercase `E`, ≤15 significant digits: `1.0`→`'1'`, `1.1`→`'1.1'`, `12345678901234567890.0`→`'1.23456789012346E+19'`. The implementation MUST reproduce G15, or large/precise numbers diverge.
- **array→`'Array'`, object→`'Object'`** (the kind name). Source: `ConvertToString` default → `Kind.ToString()`. (Corrects an earlier draft that said arrays/objects have no string form.)

### Truthiness
Falsy: `false`, `0`, `-0`, `NaN`, `''`, `null`. Everything else is truthy — **including the strings `'false'` and `'0'`** (non-empty), and **all arrays/objects** (even empty).

### Equality (`==`, `!=`)
- **Same type:**
  - string ↔ string: **case-insensitive** (`'TEST' == 'test'` → `true`).
  - number ↔ number: numeric (`NaN` equals nothing).
  - boolean ↔ boolean: direct.
  - null ↔ null: `true`.
  - array/object: **reference equality** (`Object.ReferenceEquals`) — never structural. (Note: `nektos/act` instead *throws* on object-vs-object compare; the C# runner does reference-equality. Follow the runner.)
- **Different types:** coerce via the runner's `CoerceTypes` — number↔string casts the string to number; **boolean/null vs anything casts the boolean/null to number first, then recurses**. So `'3' == 3`, `true == 1`, `null == 0`, `'' == 0` → `true`. An **object/array vs a primitive never coerces** → kinds stay unequal → `false`. `NaN` → `false`.
- `!=` is the negation.

### Ordering (`<`, `<=`, `>`, `>=`)
- **Same type:** compare *in that type* — **MUST NOT blindly coerce to number.**
  - string ↔ string: **case-insensitive ordinal** comparison (`'b' >= 'a'` → `true`, `'b' <= 'a'` → `false`).
  - number ↔ number: numeric.
  - boolean ↔ boolean: as numbers (`true > false` → `true`).
- **Different types:** coerce both to number, compare.
- **`NaN` in any relational comparison → always `false`.**

> This is [Correction 2](#fidelity-notes-grounding-history): `'b' >= 'a'` is `true`. A coerce-everything-to-number implementation yields `NaN >= NaN` → `false`, which is **wrong**.

### Logical `&&` / `||` — return the operand, not a boolean
- `a && b`: evaluate `a`; if `truthy(a)` return `b`, else return `a`.
- `a || b`: evaluate `a`; if `truthy(a)` return `a`, else return `b`.
- Results: `null || 'abc'` → `'abc'`; `'abc' || true` → `'abc'`; `false && null` → `false`; `true && false` → `false`.
- `!a` returns a **boolean** = `!truthy(a)`.

### Property / index access
- `a.b` and `a['b']` dereference. Index may be a string (property) or number (array index).
- **Dereferencing null/undefined or a missing key returns `null` — MUST NOT throw.** `missing.deep.ref` → `null`.

### Object filters

- **Object input** (`obj.*`) → `Object.values(obj)` — an array of the property values.
- **Array input** (`array.*`) → the **elements themselves** — the array is returned as-is (identity). `.*` does NOT recursively extract values from each element.
- `[*]` is the index-syntax equivalent of `.*`.
- **Propagation rule** — subsequent property/index access chained after a filter result (which is always an array) **maps over the array elements**. So `commits.*.author.username` means: filter `commits` (→ array of commit objects), then `.author` maps over each commit (→ array of author objects), then `.username` maps over each (→ array of usernames). This propagation applies to all property access on an array value, not only immediately after `.*`. Corpus pins: `(github.event.commits.*.author.username)[0]` → `"someone"`; `contains(needs.*.result, 'success')` → `true`.
- Object key order is **not guaranteed** (objects are unordered), so consumers MUST NOT depend on filter output order.
- Filter over `null` → `null` (not an empty array).

## Functions
Dispatch is **case-insensitive** (`WellKnownFunctions` is an `OrdinalIgnoreCase` map). **Two tiers:** the expression *SDK* defines `contains, startsWith, endsWith, format, join, toJSON, fromJSON` (and an internal `case` not exposed in Actions); the *runner* adds `hashFiles, success, failure, always, cancelled`. The engine MUST allow the runtime to register the runner tier (via the `functions` hook) — they are not pure.

| Function | Behavior |
|----------|----------|
| `contains(search, item)` | array: `true` if `item` loose-`==`s an element — so `contains([true], 'true')` → **`false`** (bool vs string → number → `1 == NaN`), `contains([null], '')` → `true`. string: `true` if `item` is a substring after string-coercion, **case-insensitive**; `contains(3.14, '3.14')` → `true`, `contains(null,'')` → `true`. |
| `startsWith(s, prefix)` / `endsWith(s, suffix)` | **case-insensitive**, both args string-coerced. `startsWith(123,'12')` → `true`, `startsWith(null,'42')` → `false`. |
| `format(fmt, ...args)` | `{N}` → `args[N]` (string-coerced: array→`Array`, object→`Object`, number→G15). `{{`→`{`, `}}`→`}`. **Throws** on unclosed/unbalanced braces (`'{0'`, `'{0}}'`) or an out-of-range/too-many-args index — with the runner's exact messages (see corpus). |
| `join(array, sep?)` | values string-coerced & concatenated; default `sep` is `,`. Non-array → single value; `null` elements/sep → `''`; e.g. `join(['a','b',null], 1)` → `'a1b1'`. |
| `toJSON(value)` | **pretty-printed** JSON (2-space); `toJSON(null)` → `'null'`. |
| `fromJSON(value)` | parse JSON → object/array/number/bool/null/string. Enables type-preservation in single-expression position. |
| `hashFiles(...patterns)` | SHA-256 over the matched file set. **Algorithm (pinned by a fixture):** glob the comma-separated patterns (`!`-negation, `**`) under `GITHUB_WORKSPACE`; in globber (sorted) order, SHA-256 each matched file's bytes; concatenate those digests and SHA-256 the concatenation → lowercase hex. **`''` if nothing matches.** Runner-tier; ships real in v0.0, overridable via the `functions` hook. |

### Status functions (runtime-wired)
`success()`, `failure()`, `always()`, `cancelled()` depend on job/step status, which the *runtime* supplies (not the pure evaluator). They behave differently in `job` vs `step` scope. The engine exposes them via the `status` context hook; `@actspec/core` populates it per the lifecycle.

## Template vs single-expression typing
- A value that is **exactly** `${{ expr }}` (nothing around it) **preserves the expression's type** — `${{ fromJSON('{"a":1}') }}` yields an object.
- A value with **surrounding text or multiple `${{ }}`** coerces each expression **to string** and concatenates.
- `if:` evaluates its expression and **coerces the result to boolean** (truthiness); the `${{ }}` wrapper is optional in `if:`.

## Fidelity notes (grounding history)
This section records what reading the **C# runner source** (`EvaluationResult.cs`, `ExpressionUtility.cs`) changed — including a case where a *from-docs* draft was itself wrong. The lesson: **trust the source, not the docs, and not a reimplementation tested against your own expectations.**

1. **Same-type string ordering is `OrdinalIgnoreCase` comparison, not number coercion.** `'b' >= 'a'` → `true`. A coerce-everything-to-number impl yields `NaN >= NaN` → `false`. Confirmed by `AbstractGreaterThan`/`AbstractLessThan` (`String.Compare(..., OrdinalIgnoreCase)`). **Binding.**
2. **String→number parses hex/octal (≈ JS `Number()`), so `'0xff'` → `255`.** A from-docs draft said the opposite (`NaN`, "JSON-number only") — the GitHub docs are imprecise; `ParseNumber` proves it. **The earlier draft was reverted.** This is the clearest evidence that grounding > docs.
3. **Number→string is C# `"G15"` invariant**, not JS `toString` — large numbers go exponential (`…E+19`).
4. **Array→`'Array'`, object→`'Object'`** under string coercion (not "no string form").
5. **Object/array equality = `ReferenceEquals`** (runner). `nektos/act` *throws* instead — an act-only divergence; follow the runner.
6. **`Infinity`, `-Infinity`, `NaN` are real value-literals** in the runner (`ExpressionConstants`), not act inventions.

Confirmed-correct from the start: case-insensitive `==`, operand-returning `&&`/`||`, `'false'`/`'0'`/empty-collection truthy, cross-type number coercion for `==`, missing-ref → `null`.

## Conformance corpus
The corpus is the **fidelity gate** — the implementation is "correct" iff it's green against it. **v0.0 bar:** green on the **full vendored vector set** (this corpus, harvested complete from the sources below — not just the committed 149-row seed) **+ parser/eval fuzz**; the differential pass below is **recommended but non-blocking** ([D5](DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)).

- **Format:** `{ expr, context?, expect | error }` per case (JSON), under `packages/expressions/corpus/`. A seed is committed at `corpus/expressions/` (this repo) — harvested below.
- **Sources (harvested, MIT — preserve notices in `corpus/NOTICE`):**
  - `nektos/act` — `pkg/exprparser/interpreter_test.go`, `functions_test.go` (table-form vectors; the bulk of the corpus).
  - C# runner (`actions/runner`) — `src/Sdk/DTExpressions2/Expressions2/EvaluationResult.cs` + `Sdk/ExpressionUtility.cs` (semantic truth), `src/Test/L0/Worker/Expressions/`, `src/Test/L0/Sdk/ExpressionParserL0.cs`.
  - GitHub docs examples.
- **Seed vectors** — the load-bearing ones (the `&&`/`||` full type-matrix lives in the JSON, generated):

| expr | expect | pins |
|------|--------|------|
| `'TEST' == 'test'` | `true` | case-insensitive `==` |
| `'3' == 3`, `null == 0`, `'' == 0`, `true == 1` | `true` | cross-type → number |
| `'b' >= 'a'` | `true` | **same-type string order (not NaN)** |
| `true > false` | `true` | bool ordered as number |
| `null \|\| 'abc'` | `'abc'` | logical ops return the operand |
| `true && false` | `false` | `&&` short-circuit |
| `0xff` (literal) | `255` | hex literal |
| `format('{0}', '0xff')`… see below | — | — |
| `'0xff'` coerced (e.g. `'0xff' == 255`) | `true` | **hex *string* → 255 (not NaN)** |
| `format('{0} {1}', 1.0, 12345678901234567890.0)` | `'1 1.23456789012346E+19'` | **G15 number→string** |
| `format('Hello {0} {1}', fromJSON('[1]'), fromJSON('{}'))` | `'Hello Array Object'` | array/object→string |
| `format('{0')` | error `Unclosed brackets…` | format errors |
| `contains(fromJSON('[true]'), 'true')` | `false` | array contains loose-`==` |
| `contains('HELLO','ll')`, `cOnTaInS('Hi','i')` | `true` | contains + fn-name case-insensitive |
| `join(fromJSON('["a","b",null]'), 1)` | `'a1b1'` | join coercion |
| `fromJSON('{}') == fromJSON('{}')` | `false` | object eq = reference |
| `steps.x.outcome == 'success'`, `missing.deep.ref` | `true` / `null` | context + missing→null |

- **Differential testing (recommended):** run the engine and act over the *same* generated inputs and diff — catches divergences the static corpus misses. Fuzz the parser against the grammar.

## Public surface
See [API.md §7](API.md). Summary:
```ts
evaluate(expr: string, contexts: ExpressionContexts): ExprValue;            // single expression, type preserved
evaluateTemplate(input: string, contexts: ExpressionContexts): ExprValue;   // mixed text → string
tokenize(expr): Token[]; parse(tokens): Ast;                               // for tooling
```
The `ExpressionContexts.functions` hook lets tests override built-ins (e.g. a deterministic `hashFiles`).
