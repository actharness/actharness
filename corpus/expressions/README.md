# Expression conformance corpus (seed)

The fidelity gate for `@actspec/expressions`: the engine is "correct" iff green against this corpus. See [docs/EXPRESSIONS.md](../../docs/EXPRESSIONS.md) for the semantics each vector pins.

This is a **seed** — the load-bearing vectors that pin every distinct behavior. The full set is harvested mechanically from the sources below (the `&&`/`||` full type-matrix, ~150 rows, is generated, not hand-listed here).

## Case format
Each file is `{ "cases": Case[] }`.

```jsonc
type Case = {
  expr: string;            // the expression body (no ${{ }})
  context?: object;        // named contexts: { github, env, steps, runner, ... }
  expect?: JsonValue;      // expected result (type-preserved)
  error?: string;          // OR: substring the thrown error message must contain
};
```

**Special numbers** (JSON has no NaN/Infinity): encode an *expected* special number as
`{ "$number": "NaN" | "Infinity" | "-Infinity" }`. A literal string `"NaN"` is just a string.

## Sources (MIT — see NOTICE)
- `nektos/act` — `pkg/exprparser/interpreter_test.go`, `functions_test.go` (table vectors).
- `actions/runner` — `src/Sdk/DTExpressions2/Expressions2/EvaluationResult.cs`, `Sdk/ExpressionUtility.cs`, `ExpressionConstants.cs` (the semantic truth), `src/Test/L0/**/Expressions*`.
- GitHub docs (examples).

## Files
- `literals.json` — booleans, null, numbers (incl `0xff`, exponent), string escaping.
- `coercion.json` — to-number (incl **hex string → 255**) and to-string (incl **G15**, `Array`/`Object`).
- `equality.json` — `==`/`!=`, same- and cross-type, case-insensitive strings, object reference-equality.
- `ordering.json` — `< <= > >=`, same-type string/bool, NaN→false.
- `logical.json` — `&&`/`||` operand-returning (representative slice of the type-matrix), `!`.
- `functions.json` — contains/startsWith/endsWith/format(+errors)/join/toJSON/fromJSON/hashFiles.
- `contexts.json` — context access, missing→null, object filters `.*`.
