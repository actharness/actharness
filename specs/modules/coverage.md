# `@actspec/coverage`

Passive, suite-level coverage of `action.yml`/workflow files. Consumes `RunResult`s, never touches execution. Built as an **Istanbul coverage map** so the whole Istanbul reporter ecosystem and `nyc merge` work for free.

## Owns (public surface)
[API.md §9](../../docs/API.md): `actspecCoverage(options?)`, `getCoverage(): CoverageReport`, and the types `CoverageOptions`, `CoverageMetric`, `CoverageReport`/`FileCoverage`/`CoverageStat`.

## Depends on
`@actspec/types` (`RunResult`) only. Plus Istanbul libs (`istanbul-lib-coverage`, `istanbul-reports`) for the map + reporters.

## Behavior (MUST)
1. **Collect** — subscribe to every `run()`'s `RunResult` **via core's `registerRunListener` hook** (the process-global run sink — core exposes it, coverage registers in its setup entry, so adding coverage never changes execution). Each result is source-stamped, with every `if:` outcome and step result (the core recording invariants). Map onto an Istanbul map per source file: **step → statement** (at its YAML line range), **`if:` → branch** (true/false), v0.2 **JS lines → real line coverage** (via inspector API inside the JsSandbox worker thread — see [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes)); plus input/default exercised.
2. **Parallel-safe / disk-first** — `actspec test` runs each test file in its own worker, so write per-file coverage **fragments to a temp dir** during the run and **merge in a final step managed by the CLI** after all workers complete. No in-memory singleton across files. Coverage activates via `--import @actspec/coverage/register` in the CLI's worker `execArgv` — the register module instantiates the collector, subscribes to the run sink, and registers a `process.on('exit', ...)` handler that flushes the fragment synchronously before the worker exits. This works because `actspec test` workers are real child processes (not `worker_threads`), so `process.on('exit', ...)` fires reliably on file completion. No `setupFiles` or `globalTeardown` configuration is needed.
3. **Reporters** — the Istanbul set: `text`,`text-summary`,`html`(default),`html-spa`,`lcov`,`lcovonly`,`cobertura`,`clover`,`teamcity`,`json`(`coverage-final.json`, mergeable),`json-summary`,`none`. Default `['text','html']`. Output to `coverageDir` (default `./coverage`).
4. **Thresholds** — fail the suite when any `CoverageMetric` is below its percentage.
5. **`if:`-branch truth table** — `FileCoverage.ifBranches[].{sawTrue,sawFalse}` so "you never tested the skip path" is a visible, queryable gap.
6. Adding this package **MUST NOT change execution** — it's a consumer only.

## Acceptance
- A suite of composite runs produces: step coverage (ran vs skipped), `if:`-branch (a guard exercised one way shows `sawTrue` xor `sawFalse`; both ways → covered), input/default exercised.
- Reporters: `html` renders the `action.yml` with covered/uncovered steps; `coverage-final.json` is a valid Istanbul map that `nyc merge` accepts alongside ordinary JS coverage; `cobertura` + `json-summary` emit.
- Threshold: a suite under `{ ifBranches: 80 }` fails.
- Parallel: two test files' fragments merge into one report (simulate separate workers).

## Done-when
Istanbul map + disk-first merge + full reporter set (html default) + thresholds + truth table; `nyc merge` interop verified; zero execution impact; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
