# Spike findings — expression engine (`@actspec/expressions`)

**Date:** 2026-06-05
**Status: ✅ COMPLETE — all success criteria met.**
**Spec:** [expressions.md](expressions.md)

---

## Hypothesis outcomes

| # | Hypothesis | Result |
| --- | ----------- | ------ |
| H1 | Pipeline covers the grammar | ✅ Pratt parser handles full precedence table, property/index/filter/call — no parser generator, zero runtime deps |
| H2 | Nasty coercions land exactly | ✅ All 12 nasty-dozen cases green |
| H3 | Functions + errors match | ✅ All 7 built-ins pass, including `format` exact error messages |
| H4 | Template typing correct | ✅ Single-expr type preserved; surrounding text coerces to string and concatenates |
| H5 | Full harvest is reachable | ✅ Access confirmed (22 660 bytes, MIT); ~387 rows estimated; 1–2 day effort for full harvest |

## Test results

**165 / 165 tests passing** across all 7 corpus files (literals, coercion, equality, ordering, logical, functions, contexts) plus the Nasty dozen stand-alone tests.

## Gate-bites evidence

Three corpus-driven bugs were found and fixed — proving the seed is a real oracle, not a mirror of assumptions:

| # | Bug | Corpus pin | Fix |
| --- | --- | --- | --- |
| 1 | **Filter propagation on arrays** — `getProperty` on an array returned `null` instead of mapping over elements | `(github.event.commits.*.author.username)[0]` → `"someone"` | `if (Array.isArray(obj)) return obj.map(el => getProperty(el, key))` |
| 2 | **`join` default separator** — `sep === undefined` (no arg) treated identically to `sep === null` (explicit null arg) | `join(fromJSON('["a","b"]'))` → `"a,b"` | `sep === undefined ? ',' : sep === null ? '' : coerceToString(sep)` |
| 3 | **`applyFilter` on arrays** — `array.*` used `flatMap` + recursive value extraction, returning object *values* instead of the array *elements* | `contains([{"result":"success"}].*.result, 'success')` → `true` | `if (Array.isArray(obj)) return [...obj]` (identity for arrays) |

## Design gaps / doc clarifications

Bug 3 exposed a gap in [docs/EXPRESSIONS.md](../../docs/EXPRESSIONS.md) — the Object filters section was ambiguous about what `.*` returns for an array input vs. an object input. The doc was updated to state explicitly:

- **Object input** (`obj.*`) → `Object.values(obj)` — the property values as an array.
- **Array input** (`array.*`) → the elements themselves — the array is returned as-is (identity). `.*` does NOT recursively extract values from each element.
- **Propagation rule** — subsequent property/index access on a filter result (always an array) maps over elements. So `commits.*.author.username` maps `.author` then `.username` over each element.

No other spec changes were needed. All other behaviors in [EXPRESSIONS.md](../../docs/EXPRESSIONS.md) were confirmed correct as written.

## Harvest probe findings (H5)

Full record: [`corpus/expressions/PROVENANCE.md`](../../corpus/expressions/PROVENANCE.md).

| Field | Finding |
| --- | --- |
| **Access** | SUCCESS — 22 660 bytes, MIT, raw fetch from `nektos/act` master |
| **Corpus status** | SEED — 149 hand-curated vectors; **full harvest NOT run** |
| **Missing from seed** | The `&&`/`||` full type-matrix (~150 rows) is described as "generated" but not present (33 representative cases only) |
| **Harvest tooling** | None in the repo — no mechanical parser for Go struct-literal tables |
| **Estimated full harvest** | ~387 rows in `interpreter_test.go`; 1–2 days of Go-table-parsing tooling; `&&`/`||` matrix warrants a code generator |
| **Oracle divergences (sample)** | 0 in 10-row sample; known divergence: act *throws* on object compare, runner returns reference-equality false — rows with this pattern need the runner value |
| **D5 gate met?** | **No** — gate requires full vendored corpus + fuzz; seed is the starting point only |

## Exit decision

**Promote.** All hypotheses confirmed, gate bites (3 corpus-caught bugs), harvest is tractable with real numbers.

Next steps:
1. Build `@actspec/expressions` — dual ESM/CJS build, real `hashFiles`, full public API, API Extractor snapshot.
2. Schedule the full vendored harvest (against the probe's estimates: ~387 act rows + runner test files + generated `&&`/`||` matrix).
3. Add parser/eval fuzz to CI.

## References

- [expressions.md](expressions.md) — the original spike spec.
- [docs/EXPRESSIONS.md](../../docs/EXPRESSIONS.md) — binding semantics, updated with filter clarifications from this spike.
- [corpus/expressions/PROVENANCE.md](../../corpus/expressions/PROVENANCE.md) — full harvest probe record (H5).
- [spike/expressions/](../../spike/expressions/) — the spike implementation.
