# Spike — expression engine (`@actspec/expressions`)

> **Throwaway-or-promote.** A thin vertical slice that de-risks the **highest-risk component** ([ARCHITECTURE → highest-risk assumptions](../../docs/ARCHITECTURE.md#the-three-highest-risk-assumptions)) *before* the full package is built. It is judged **only** against the oracle-sourced [seed corpus](../../corpus/expressions/) — never against the author's own expectations. This is deliberate: see *Why* below.

## Why this spike

EXPRESSIONS.md records the exact trap this guards against — *"a prototype evaluator written from memory passed its own tests but encoded two wrong rules."* Testing a reimplementation against your own assumptions proves nothing about fidelity. So this spike's value is **conditional on the gate**: it is "passing" only when green against the committed seed (oracle-sourced vectors), and only after it has demonstrably gone **red** on a wrong rule at least once (proof the gate bites).

Building this before `core`/`composite` exist means a fidelity gap is learned cheaply, not after 9 packages ride on the engine.

## The question it answers

Does a hand-written `tokenize → Pratt parse → evaluate` engine, built from the **grounded** semantics in [EXPRESSIONS.md](../../docs/EXPRESSIONS.md), reproduce the seed corpus's expected values — and is the **full vendored-corpus harvest** (the binding v0.0 gate, [D5](../../docs/DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)) actually feasible from the upstream sources?

This is a **seed-first** spike: the full harvest is *probed*, not completed ([D5]; harvest-later per the maintainer's plan).

## Hypotheses to prove

**Engine (H1–H4):**

- **H1 — Pipeline covers the grammar.** Hand-written Pratt / precedence-climbing ([D18](../../docs/DECISIONS.md#d18--hand-written-pratt-expression-parser)) handles the full precedence table, property/index access, object filters (`.*` / `[*]`), and calls — with no parser generator and (ideally) zero runtime deps.
- **H2 — The nasty coercions land exactly.** The behaviors a naïve port gets wrong (the *Nasty dozen* below) all match the seed.
- **H3 — Functions + errors match.** `contains`/`startsWith`/`endsWith`/`format`/`join`/`toJSON`/`fromJSON` behave as specified, including `format`'s **exact error messages** for unbalanced/out-of-range braces.
- **H4 — Template typing is correct.** `evaluate` (single expression) **preserves type**; `evaluateTemplate` (surrounding text / multiple `${{ }}`) **coerces to string and concatenates** (with `Array`/`Object`/G15 string rules).

**Harvest feasibility (H5):**

- **H5 — The full harvest is reachable as written.** The upstream test tables can be mechanically converted into the corpus schema, and act's known divergences are reconcilable against the runner.

## In scope

- A minimal `tokenize`, `parse`, `evaluate`, `evaluateTemplate` — enough surface to run every seed file.
- A `functions` hook **stub** sufficient to register `hashFiles` / status functions as injected values (no real implementations).
- A test harness that loads `corpus/expressions/*.json` (honoring the `$number` sentinel and the `error`-substring form) and reports pass/fail per vector.
- The **harvest probe** (see below).

## Explicitly out of scope

- The **full vendored harvest** (this spike only *probes* it).
- Parser/eval **fuzzing**.
- Dual ESM/CJS build, packaging, `exports` map, `sideEffects`, API Extractor.
- Real `hashFiles` (real glob + digest order) and real **status-function** runtime wiring — those land in the package + `core`.
- Performance, caret-precise error *positions* (messages yes, source `line:col` later), public-API polish.
- The live differential-vs-`act` run (non-blocking even at the gate).

## Success criteria (the spike's gate)

1. **Green on the full committed seed** — all 7 files (`literals`, `coercion`, `equality`, `ordering`, `logical`, `functions`, `contexts`).
2. **Green on the *Nasty dozen*** (called out explicitly so they can't be skipped).
3. **The gate bites** — one deliberately-wrong rule is shown failing a seed vector, then fixed (proves the corpus is a real oracle, not a mirror of our assumptions).
4. **Harvest probe reported** (H5) — findings written to the required **provenance document** (below), even if the answer is "harder than the spec implies." The harvest status must be **explicit**, never inferred.

## The *Nasty dozen* (must be green; drawn from the seed + EXPRESSIONS.md)

These are the load-bearing fidelity cases; a coerce-everything-to-JS-semantics port fails several.

| # | Vector | Pins |
| --- | ------ | ---- |
| 1 | `'0xff' == 255` → `true` | hex **string** → 255 (not `NaN`; docs are imprecise) |
| 2 | `format('{0}', 1.0)` → `'1'` | **G15** integral double |
| 3 | `format('{0}', 12345678901234567890.0)` → `'1.23456789012346E+19'` | **G15** exponential, uppercase `E` |
| 4 | `'b' >= 'a'` → `true` | same-type string = **OrdinalIgnoreCase** order, **not** NaN coercion |
| 5 | `'TEST' == 'test'` → `true` | case-insensitive `==` |
| 6 | `null \|\| 'abc'` → `'abc'`; `'abc' \|\| true` → `'abc'` | `&&`/`\|\|` **return the operand** |
| 7 | `fromJSON('{}') == fromJSON('{}')` → `false` | object equality = **reference** (follow runner, not act's throw) |
| 8 | truthiness of `'false'`, `'0'` → **truthy**; `''`/`0`/`null`/`NaN` → falsy | non-empty strings truthy |
| 9 | `contains(fromJSON('[true]'), 'true')` → `false` | array `contains` loose-`==` (bool vs string → number) |
| 10 | `format('Hello {0} {1}', fromJSON('[1]'), fromJSON('{}'))` → `'Hello Array Object'` | array→`'Array'`, object→`'Object'` |
| 11 | `format('{0')` → **error** (`Unclosed brackets…`) | `format` error messages |
| 12 | `missing.deep.ref` → `null` | missing dereference never throws |

(Plus the typing pair for H4: bare `${{ fromJSON('{"a":1}') }}` preserves the object; the same inside `"x ${{ … }}"` coerces to string.)

## Harvest probe (H5)

> **✅ COMPLETED 2026-06-05. Do not re-run.** Findings are in [`corpus/expressions/PROVENANCE.md`](../../corpus/expressions/PROVENANCE.md). The section below is the original spec preserved for context.

A thin slice of the binding v0.1 gate — enough to *measure* feasibility, not complete it.

- **Pick one source table** — `nektos/act` `pkg/exprparser/interpreter_test.go` **or** `functions_test.go` (table-driven Go).
- **Convert ~10 rows** by hand into the corpus schema `{ expr, context?, expect | error }`, including at least one row that exercises act's **object-compare divergence** (act *throws*; we **follow the runner** → reference-equality, so that row must encode the runner's value, not act's).
- **Report:**
  1. **Access** — can the source be obtained here (git clone / raw fetch / vendoring), and under what license footprint (MIT — preserve in [corpus NOTICE](../../corpus/expressions/NOTICE)).
  2. **Mapping cleanliness** — how mechanical is Go-table → JSON; what fields/patterns resist (special numbers, error cases, context fixtures).
  3. **Oracle reconciliation** — how often act diverges from the runner in the sampled rows (the cases needing a "follow-runner" override).
  4. **Estimate** — rough total vector count and effort for the full harvest, so *seed-first → harvest-later* can be scheduled with real numbers.

- **Reconcile the *existing* corpus.** Before estimating, state plainly **what the committed seed already is**: a hand-authored set encoding the upstream behavior, or the output of a real (partial) harvest. The current NOTICE says only "*derived from*" and the cases carry hand-authoring markers (`_pins`/`_note`) — so this must be resolved and recorded, not assumed. If a harvest was in fact already run, that fact must be captured (what was run, against which upstream commit, how much it produced) instead of being lost.

### Required deliverable — a provenance document

The probe's findings are not a throwaway log; they are written to a **durable, named document** so the harvest status is explicit and survives the spike:

- **Doc:** [`corpus/expressions/PROVENANCE.md`](../../corpus/expressions/PROVENANCE.md), sitting alongside the data it describes and complementing the license-focused [NOTICE](../../corpus/expressions/NOTICE).
- **Must record, explicitly:**
  1. **What the committed corpus is today** — seed vs harvested (the reconciliation above), with the upstream repo + commit/ref it reflects.
  2. **What the probe did** — which source table, how many rows converted, the access method.
  3. **Mapping + oracle-reconciliation findings** (probe report items 2–3).
  4. **Completeness vs the full vendored set** — current vector count vs estimated total, i.e. how far seed-first is from the [D5] gate.
  5. **Status line** — one of *seed only* / *partial harvest* / *full harvest complete*, dated, so a reader never has to infer it.
- **Maintained over time:** updated when the harvest-later work actually lands, so the document always states the *current* truth of the gate.
- **Parallel for the protocol corpus.** The protocol corpus has the same implicit-status problem (its NOTICE also says only "*derived from*"), so it gets a sibling [`corpus/protocol/PROVENANCE.md`](../../corpus/protocol/PROVENANCE.md) with the same structure — owned by the `core` protocol work (the [PROTOCOL.md](../../docs/PROTOCOL.md) round-trip gate), maintained the same way.

> The probe may conclude the full harvest is **more work than the spec implies** (e.g. C# test files are harder to scrape than act's Go tables) — that is a valid, useful outcome and feeds the harvest-later decision. Either way, the conclusion lands in `PROVENANCE.md`.

## Exit — what we decide after

- **If green + harvest looks tractable:** promote the engine toward the real `@actspec/expressions` package (add dual build, fuzz, full API, real `hashFiles`, packaging) and schedule the harvest with the probe's numbers.
- **If divergences surface:** document each against EXPRESSIONS.md (is the *doc* wrong, or our *reading*?), fix the grounding, and re-run — before any dependent package exists.
- **If the harvest proves impractical as specified:** raise it as a gate question ([D5] assumes a full vendored set) rather than silently narrowing the v0.0 bar.

## Results (completed 2026-06-05)

**Status: ✅ COMPLETE — all success criteria met.** Full findings: [expressions-findings.md](expressions-findings.md).

| # | Hypothesis | Result |
| --- | ----------- | ------ |
| H1 | Pipeline covers the grammar | ✅ |
| H2 | Nasty coercions land exactly | ✅ |
| H3 | Functions + errors match | ✅ |
| H4 | Template typing correct | ✅ |
| H5 | Full harvest is reachable | ✅ |

165 / 165 tests passing. 3 corpus-caught bugs (gate bites). Exit decision: promote.

## References

- [docs/EXPRESSIONS.md](../../docs/EXPRESSIONS.md) — binding semantics (the grounding).
- [corpus/expressions/](../../corpus/expressions/) — the seed (the spike's gate) + [NOTICE](../../corpus/expressions/NOTICE).
- [specs/modules/expressions.md](../modules/expressions.md) — the package contract this spike feeds.
- [D5](../../docs/DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz) · [D18](../../docs/DECISIONS.md#d18--hand-written-pratt-expression-parser) · [D20](../../docs/DECISIONS.md#d20--standalone-zero-dep-expression-engine)
