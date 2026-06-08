# Expression corpus — provenance & harvest status

Records **how this corpus was produced** and **how complete it is** against the full
vendored vector set that the v0.0 expression gate requires
([D5](../../docs/DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)).
Complements [NOTICE](NOTICE) (which covers *license/attribution*); this file covers
*what was actually done* so the harvest status is **explicit, never inferred**.

> Why this exists: the harvest status was previously only *implied* — NOTICE says the
> vectors are "*derived from*" upstream, which does not say whether a real harvest was
> run or whether these are hand-authored. This document resolves that ambiguity and is
> kept current as the harvest-later work lands.

## Status

| Field | Value |
|-------|-------|
| **Status** | `FULL HARVEST` — complete mechanical harvest from `nektos/act` test tables |
| **As of** | 2026-06-07 |
| **Vectors committed** | **459** across 7 files (`coercion` 16, `contexts` 45, `equality` 15, `functions` 72, `literals` 10, `logical` 277, `ordering` 12) |
| **Full vendored harvest run?** | **Yes** — all table rows from `interpreter_test.go` + `functions_test.go` converted |
| **Upstream ref reflected** | `nektos/act` `master` branch, fetched 2026-06-07 (22 660 bytes) |
| **Gate met ([D5])?** | **Partial** — full corpus green (459/459); parser/eval fuzz not yet in CI (remaining gate item) |

## Sources reflected (see [NOTICE](NOTICE) for license)
- `nektos/act` — `pkg/exprparser/interpreter_test.go`, `pkg/exprparser/functions_test.go` (table-driven Go; the bulk of the intended full set). **Oracle, imperfect** — its object-compare *throws*; we follow the runner.
- `actions/runner` — `src/Sdk/DTExpressions2/Expressions2/**` (`EvaluationResult.cs`, `ExpressionUtility.cs`, `ExpressionConstants.cs`) + `src/Test/L0/**/Expressions*`. **Semantic source of truth.**
- GitHub docs (examples).

## Completed work

All harvest tasks completed on 2026-06-07 (see probe findings below for details):

1. ✅ Upstream commit/ref pinned — `nektos/act` `master`, fetched 2026-06-07 (22 660 bytes).
2. ✅ Full vendored harvest — all rows from `interpreter_test.go` + `functions_test.go` converted; act-vs-runner divergences reconciled toward the runner.
3. ✅ `&&`/`||` type-matrix generated — included in `logical.json` (277 vectors).
4. ✅ Status table updated.

**Remaining gate item (D5):** parser/eval fuzz not yet in CI — ships as part of building `@actspec/expressions`.

## Change log

- **2026-06-07** — `FULL HARVEST` (459 vectors). Full mechanical harvest from `nektos/act` `interpreter_test.go` + `functions_test.go`; `&&`/`||` type-matrix generated. Upstream ref pinned. Probe findings archived below.
- **2026-06-05** — `SEED` (149 vectors). Provenance documented; full harvest not yet run/committed.

## Harvest probe findings (H5)

> Historical record — accurate as of 2026-06-06. The full harvest was completed on 2026-06-07; see Status table and Completed work above.

**Access:** SUCCESS — fetched 22660 bytes from `nektos/act` at `master` branch.
Upstream license: MIT (see NOTICE).

**What the committed corpus was at probe time (2026-06-06):**
The committed corpus was a **hand-curated seed** (149 vectors) — not a mechanical dump
of the upstream test tables. The `&&`/`||` full type-matrix was not present (logical.json
had 33 representative cases). This resolved the open question in PROVENANCE.md: **status
was SEED at probe time**. The full harvest was subsequently completed on 2026-06-07.

**Probe: ~10 sampled rows converted**

```json
[
  {
    "expr": "true",
    "expect": true,
    "_probe_note": "true"
  },
  {
    "expr": "false",
    "expect": false,
    "_probe_note": "false"
  },
  {
    "expr": "null",
    "expect": null,
    "_probe_note": "null"
  },
  {
    "expr": "123",
    "expect": 123,
    "_probe_note": "integer"
  },
  {
    "expr": "-9.7",
    "expect": -9.7,
    "_probe_note": "float"
  },
  {
    "expr": "0xff",
    "expect": 255,
    "_probe_note": "hex"
  },
  {
    "expr": "-2.99e-2",
    "expect": -0.0299,
    "_probe_note": "exponential"
  },
  {
    "expr": "'foo'",
    "expect": "foo",
    "_probe_note": "string"
  },
  {
    "expr": "'it''s foo'",
    "expect": "it's foo",
    "_probe_note": "string"
  },
  {
    "expr": "!null",
    "expect": true,
    "_probe_note": "not-null"
  }
]
```

**Mapping cleanliness:**
- Simple boolean/numeric/string rows map cleanly.
- Go special values (`math.NaN()`, `math.Inf(1)`) require a translation step → handled.
- Object/struct literal return values (e.g. `interface{}`) resist direct mapping.
- Unmapped values in sample: 0

**Oracle reconciliation (act vs runner):**
- act diverges from the runner on object comparison: act *throws*, runner returns
  reference-equality result (false for distinct instances). Rows with this pattern
  need the runner value, not act's.
- Divergences in sample: 0

**Estimated full harvest (at probe time):**
- Rough row count in interpreter_test.go: ~387 table entries.
- Estimated effort: 1–2 days of tooling to parse Go struct-literal tables, handle
  all special values, and reconcile act-vs-runner divergences systematically.
- The `&&`/`||` type-matrix is the largest single section (~100+ rows from
  `TestOperatorsBooleanEvaluation`). A code generator is the right tool for it.

**Status after probe:** `SEED` at probe time — full harvest subsequently completed 2026-06-07 (459 vectors; see Status table).

**Date:** 2026-06-06
