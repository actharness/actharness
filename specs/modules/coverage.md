# `@actharness/coverage`

Passive, suite-level coverage of `action.yml`/workflow files. Consumes `RunResult`s, never touches execution. Built as an **Istanbul coverage map** so the whole Istanbul reporter ecosystem and `nyc merge` work for free.

## Owns (public surface)
[API.md §9](../../docs/API.md): `actharnessCoverage(options?)`, `getCoverage(): CoverageReport`, `applyIncludeExclude()`, and the types `CoverageOptions`, `CoverageMetric`, `CoverageReport`/`FileCoverage`/`CoverageStat`/`IfBranchRow`/`InputCoverageRow`/`OutputCoverageRow`.

## Depends on
`@actharness/types` (`RunResult`) and `@actharness/core` (`registerRunListener`, `parseAction`). Plus Istanbul libs (`istanbul-lib-coverage`, `istanbul-reports`) for the map + reporters.

## Behavior (MUST)

1. **Collect** — subscribe to every `run()`'s `RunResult` **via core's `registerRunListener` hook** (the process-global run sink — core exposes it, coverage registers in its setup entry, so adding coverage never changes execution). Each result is source-stamped, with every `if:` outcome and step result (the core recording invariants). Map onto an Istanbul map per source file: **step → statement** (at its YAML line range), **`if:` → branch** (true/false), v0.2 **JS statements/branches/functions/lines → real V8/Istanbul coverage** (sent from the JsSandbox worker via `parentPort.postMessage`, converted with `v8-to-istanbul` — see [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes)); plus input/default exercised and declared outputs produced.
2. **Parallel-safe / disk-first** — `actharness test` runs each test file in its own worker, so write per-file coverage **fragments to a temp dir** during the run and **merge in a final step managed by the CLI** after all workers complete. No in-memory singleton across files. Coverage activates via `--import @actharness/cli/register` in the CLI's worker `execArgv` — the register module (in `@actharness/cli`) instantiates the collector, subscribes to the run sink, and registers a `process.on('exit', ...)` handler that flushes the fragment synchronously before the worker exits. This works because `actharness test` workers are real child processes (not `worker_threads`), so `process.on('exit', ...)` fires reliably on file completion. No `setupFiles` or `globalTeardown` configuration is needed.
3. **Reporters** — the Istanbul set: `text`,`text-summary`,`html`(default),`html-spa`,`lcov`,`lcovonly`,`cobertura`,`clover`,`teamcity`,`json`(`coverage-final.json`, mergeable),`json-summary`,`none`. Default `['lcov', 'html', 'text']`. Output to `coverageDir` (default `./coverage`).
4. **Thresholds** — fail the suite when any `CoverageMetric` (`steps`, `ifBranches`, `inputs`, `outputs`; v0.1 partial: `shShellLines`; v0.2: `jsStatements`, `jsBranches`, `jsFunctions`, `jsLines`) is below its percentage. JS metrics are only applied when the action under test is a node action; a threshold for a JS metric is silently skipped for composite/docker actions. `shShellLines` is a **partial metric** — line coverage only via `PS4`/`set -x`; branch, statement, and function coverage for sh/bash is not yet solved.
5. **`if:`-branch truth table** — `FileCoverage.ifBranchTable: IfBranchRow[]` where each row carries `{ step, expression, trueCount: number, falseCount: number }` so "you never tested the skip path" is a visible, queryable gap. **Output table** — `FileCoverage.outputTable: OutputCoverageRow[]` where each row carries `{ name, covered, count }` so undeclared outputs are a visible gap.
6. Adding this package **MUST NOT change execution** — it's a consumer only.

## Acceptance
- A suite of composite runs produces: step coverage (ran vs skipped), `if:`-branch (a guard exercised one way shows truthy xor falsy; both ways → covered), input/default exercised, declared outputs produced.
- Reporters: `html` renders the `action.yml` with covered/uncovered steps; `coverage-final.json` is a valid Istanbul map that `nyc merge` accepts alongside ordinary JS coverage; `cobertura` + `json-summary` emit.
- Threshold: a suite under `{ ifBranches: 80 }` fails; a suite under `{ jsLines: 100 }` fails when running a node action; same for `jsStatements`, `jsBranches`, `jsFunctions`.
- JS metrics absent for composite-only suites (threshold silently skipped).
- Parallel: two test files' fragments merge into one report (simulate separate workers).

## Done-when
Istanbul map + disk-first merge + full reporter set (html default) + thresholds (v0.1 metrics + v0.2 `jsStatements`/`jsBranches`/`jsFunctions`/`jsLines`) + truth table; `nyc merge` interop verified; JS metrics absent for composite-only suites; zero execution impact; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
