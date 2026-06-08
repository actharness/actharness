# Spike findings — coverage map + reporter pipeline

> Spike: [`spike/coverage/`](../../spike/coverage/) · Spec: [`specs/spikes/coverage.md`](coverage.md) · Date: 2026-06-07
> Runner re-run: same spike, same fixtures — tests ported from Vitest/Jest to actspec runner. All 35 tests pass.

## H1–H10 verdicts

| Hypothesis | Verdict | Notes |
|---|---|---|
| H1 — Istanbul-from-YAML map is valid | ✅ | `FileCoverageData` with YAML line ranges accepted; merge, text, html, json all work |
| H2 — HTML reporter renders `action.yml` | ✅ | `index.html` produced with `action.yml` in table; per-line highlights rendered (not semantic) |
| H3 — Disk-first fragment works in Vitest | ✅ | Original: `afterAll` flush + `globalTeardown`. Now also proven under actspec runner via `process.on('exit', ...)` (simpler — see §4) |
| H4 — Disk-first fragment works in Jest | ✅ | Original: `process.on('beforeExit')` + CJS `globalTeardown`. Under actspec runner, no distinction needed — same `process.on('exit', ...)` flush works for all |
| H5 — `registerRunListener` fires within workers (both) | ✅ | Fires in Vitest, Jest, and actspec runner workers. Under actspec runner: module instance sharing via Node.js ESM cache is the mechanism |
| H6 — Parallel safety | ✅ | Two workers write two fragments; merged report contains both; no double-counting. Proven under all three runners |
| H7 — Threshold enforcement | ✅ | `ifBranches: 100` with one direction unexercised fails with message `Branches: 50% < 100% (1/2)` |
| H8 — `nyc merge` interop | ✅ | YAML-sourced map merges with toy JS map via `createCoverageMap.merge()`; counts preserved |
| H9 — JS line coverage from `worker_threads` | ✅ | Inspector API inside worker thread: `Profiler.startPreciseCoverage` before import, `takePreciseCoverage` after; data sent via `postMessage`, converted by `v8-to-istanbul` |
| H10 — Job coverage fits the Istanbul map | ✅ | Jobs as statements, scoped per file; no collision; text/html output correct |

---

## Friction log

| # | Probe | What we wanted | What the implementation revealed | Classification |
|---|---|---|---|---|
| 1 | YAML CST line extraction | Accurate per-step start/end lines from `action.yml` | `eemeli/yaml` CST mode delivers exact 1-based line ranges per step block. Monotonically increasing, correct for all fixture shapes. | no change needed |
| 2 | Istanbul map construction from YAML | `FileCoverageData` accepted without error | Works. Two TypeScript fixes required: `BranchMapping` needs a `line` field (missed from the type); `yaml` package's `get(key, true)` returns `Scalar<unknown>` not `YAMLMap` — requires double-cast through `unknown`. Both are local implementation details, not design gaps. | no change needed |
| 3 | HTML rendering of YAML source | Reporter renders the file without crashing | Produces `index.html` with `action.yml` in the coverage table, covered/uncovered line bars, and correct percentages. Istanbul treats `.yml` as an opaque source file — no YAML syntax highlighting. The report is mechanically correct and usable; visual quality is lower than JS reports but sufficient for coverage tracking. | no change needed |
| 4 | Listener fires inside Vitest worker | `setupFiles` listener notified for every `run()` | `afterAll` is available in `globalThis` during Vitest's `setupFiles`. Listener registered via `afterAll`; fires cleanly after each test file. No silent drops. | no change needed |
| 5 | Listener fires inside Jest worker | Same as probe #4, under Jest | `afterAll` is NOT in `globalThis` when `setupFiles` runs in Jest (globals injected after). Falls back to `process.on('beforeExit')`. Listener fires and fragment is flushed before worker exits. At test execution time, `afterAll` IS available as a Jest global. | no change needed |
| 6 | Worker teardown timing | Fragment flushed before worker exits | In Vitest: `afterAll` fires reliably. In Jest: `process.on('beforeExit')` fires reliably. **Under actspec runner**: `process.on('exit', ...)` fires reliably — simpler than either (see §4). | no change needed |
| 7 | `globalTeardown` lifecycle in Vitest | Fires after all workers complete; can read temp files | ESM `globalTeardown` (`teardown/merge.vitest.ts`) fires after all workers finish. Reads all fragment JSON files, merges via `istanbul-lib-coverage`, writes configured reporters. No lifecycle friction. | no change needed |
| 8 | `globalTeardown` lifecycle in Jest | Same, under Jest | Jest `globalTeardown` must be a CJS file — Jest does not run `globalTeardown` through `ts-jest` or `moduleNameMapper`. Created `teardown/merge.jest.cjs` as native CJS. Fragments present and merged. **Under actspec runner: no `globalTeardown` file at all — the runner CLI's `for await` loop end is the teardown signal.** | design gap resolved under actspec runner |
| 9 | `nyc merge` with YAML map | `coverage-final.json` with `.yml` paths accepted by `nyc merge` | `createCoverageMap.merge()` accepts a map whose keys are `.yml` file paths alongside `.js` paths. No error, no rejection. Counts accumulate correctly. Istanbul does not validate that "source files" are JavaScript. | no change needed |
| 10 | Threshold on partial branch | Suite fails when branch direction unexercised; passes otherwise | `checkThresholds(map, { ifBranches: 100 })` returns `passed: false` with message `Branches: 50% < 100% (1/2)` when only one branch direction is exercised. Threshold at 50% passes the same data. Mechanism is observable and actionable. | no change needed |
| 11 | V8 coverage from `worker_threads` | `setter/index.js` line coverage in fragment after node action run | Inspector API approach (probe #11) proven ✅ under all runners. `NODE_V8_COVERAGE` env on the Worker constructor does not work (threads share the host V8 process). Inspector session inside the thread works — `Profiler.takePreciseCoverage` returns data for all scripts executed in the thread. | no change needed |
| 12 | Job coverage alongside step coverage | Jobs and steps in the same coverage map without collision | Istanbul statement IDs are scoped per `FileCoverageData` (per file). Workflow `.yml` and action `.yml` are separate files in the map — no global namespace. Text reporter shows both in the output table. | no change needed |
| 13 | CJS istanbul packages under ESM `"type": "module"` | `import { createCoverageMap } from 'istanbul-lib-coverage'` works | **Does not work.** Named imports from CJS packages fail in native ESM at runtime even when TypeScript accepts them. Must use `import default from 'istanbul-lib-coverage'; const { createCoverageMap } = default`. Created `src/istanbul-compat.ts` bridge to centralize the pattern and preserve TypeScript types. | spec note: `docs/CONVENTIONS.md` should document CJS bridge pattern |
| 14 | `--import` module as coverage plugin entry point | `coverage-register.ts` plugged in via `--import ./src/coverage-register.ts` CLI arg | Works. The runner CLI's `--import <path>` args are resolved to file URLs and passed to each worker's `execArgv`. The coverage register module (`coverage-register.ts`) is loaded in every worker via this mechanism — same ESM module cache entry as test files that import from `../src/coverage-register.js`. | no change needed |
| 15 | Worker bootstrap as `.ts` file | Use `import.meta.url` to reference `worker-bootstrap.ts` directly | **Does not work.** Node.js rejects `.ts` as a `worker_threads` Worker entry filename even when `--import tsx/esm` is in `execArgv` — the file extension check happens before the `--import` hooks are processed. Solution: `worker-bootstrap.mjs` (plain ESM JavaScript, no TypeScript needed since only Node.js built-ins are used). | spec note: Worker bootstrap must be `.mjs` or `.cjs`, not `.ts` |
| 16 | Inner Worker `execArgv` isolation | Action's worker doesn't load actspec's `register.ts` | The `worker_threads` Worker inherits the parent process's `execArgv` by default, which includes `--import register.ts`. This causes a failure when the inner Worker tries to load `register.ts` — either tsx is not active in that context, or `node:test` imports fail inside threads. **Fix**: explicitly set `execArgv: ['--import', 'tsx/esm']` on the Worker in `node.ts`, suppressing all actspec-specific imports. | spec note: action workers must have explicit `execArgv` |

---

## §3 Istanbul-from-YAML assessment

**Does the HTML renderer produce useful output?**

Yes, with caveats. Istanbul's HTML reporter treats the source file as an opaque blob. For a JavaScript file it highlights individual expressions; for a YAML file it shows line-level covered/uncovered bars with no semantic understanding of YAML structure. The output is:

- The coverage table in `index.html`: filename, statement %, branch %, function %, line % — correct and meaningful.
- The per-file detail page: each covered line gets a green bar, each uncovered line gets a red bar. The step blocks map to line ranges, so the visual shows which step block was or wasn't reached. Visually noisier than a JS report but interpretable.
- No crash. No blank page.

**What do YAML line ranges look like in the map?**

Each step produces one statement entry: `statementMap[i] = { start: { line: N, column: 0 }, end: { line: M, column: 0 } }` where `N` is the step's name-line (the `- name: ...` or `- uses: ...` line) and `M` is the last line of the step block. `column` is always 0 — Istanbul accepts this without complaint.

Each step with `if:` produces one branch entry of type `"if"` with two locations (true, false), both pointing to the same line range. The branch detail page shows the `if:` step's line range highlighted with true/false hit counts — rough but functional.

**Any field the map is missing that `nyc` requires?**

One: `BranchMapping.line`. The TypeScript type definition requires it; the property is the first line of the branch's range. Adding it was a one-line fix. `nyc merge` accepted the resulting `coverage-final.json` without complaint.

---

## §4 Disk-first + teardown lifecycle — per runner

### Actspec runner (canonical going forward)

**Fragment flush mechanism:** `coverage-register.ts` is loaded via `--import ./src/coverage-register.ts` on the runner CLI. The runner's CLI resolves the path to an absolute file URL and adds it to each worker's `execArgv` alongside tsx and its own `register.ts`:

```bash
# Invocation
node --import tsx/esm ../runner/src/cli.ts \
  --import ./src/coverage-register.ts \
  'test/*.test.ts'

# Each worker spawned with:
execArgv: ['--import', 'tsx/esm', '--import', registerUrl, '--import', coverageRegisterUrl]
```

Inside each worker subprocess, `coverage-register.ts` runs once. It creates a `CoverageCollector`, registers it on the run sink, and registers `process.on('exit', () => writeFragment(...))`. Because `node:test` workers are real child processes (not `worker_threads`), `process.on('exit', ...)` fires reliably after all tests in the file complete (proven in runner spike H6).

**Module instance sharing:** `coverage-register.ts` is loaded via `--import file:///absolute/path`. Node.js ESM caches by URL. When a test file imports `import { collector } from '../src/coverage-register.js'`, tsx resolves `.js` → `.ts`, which gives the same absolute file URL as the `--import` entry. Both refer to the **same module instance** — no separate collector. This is the D1 mechanism: the `Symbol.for('actspec.runSink')` global ensures `actspec()` calls and the collector share state even across separate imports.

**Merge:** The runner CLI's `for await (const event of stream)` loop ends exactly when all workers have exited and all fragments are on disk. The coverage merge happens after the loop — no `globalTeardown` file, no separate lifecycle hook. The runner's `--coverage` flag triggers the merge; the `--import coverage-register.ts` flag enables per-worker collection. Both are independent and composable.

**Result:** The Vitest/Jest-era complexities (runner detection, `afterAll`-or-`beforeExit` heuristic, CJS `globalTeardown` files) are entirely eliminated under the actspec runner.

### Vitest (original)

Fragment flush mechanism: `afterAll` registered in `setupFiles`. Vitest injects test globals (including `afterAll`) into `globalThis` before running `setupFiles`, so the hook is available at registration time. After each test file's worker completes its tests, `afterAll` fires, `writeFragment()` serializes the collector's Istanbul map to a JSON file in `ACTSPEC_COVERAGE_TMP`.

`globalTeardown` (`teardown/merge.vitest.ts`): ESM TypeScript, runs after all workers. Reads all `.json` files from `ACTSPEC_COVERAGE_TMP`, merges via `createCoverageMap`, runs `text` / `html` / `json` reporters. No lifecycle friction.

### Jest (original)

Fragment flush mechanism: `process.on('beforeExit')` registered in `setupFiles`. Jest does NOT inject test globals (`afterAll`, `it`, `describe`, etc.) into `globalThis` before `setupFiles` run. The `coverage-setup.ts` file detects that `afterAll` is absent from `globalThis` at setup time and falls back to `process.on('beforeExit')`, which fires reliably when the Jest worker process is about to exit.

`globalTeardown` (`teardown/merge.jest.cjs`): Must be a native CJS file. Jest does not run `globalTeardown` through `ts-jest` or `moduleNameMapper`. Reads fragment files, merges, writes reporters.

---

## §5 JS line coverage assessment (H9 — proven under all runners)

**Core mechanism:** In `src/worker-bootstrap.mjs`, an `inspector.Session` is connected before the action entrypoint is imported. `Profiler.startPreciseCoverage` enables per-call tracking; after the action script completes, `Profiler.takePreciseCoverage` returns the V8 profiler data for every script executed in the thread. The result is sent back to `src/node.ts` via `parentPort.postMessage({ type: 'v8coverage', data })`. In `node.ts`, the data is passed to `convertV8Coverage()`, which filters to scripts whose `file://` URL falls within the action directory and converts each via `v8-to-istanbul`. The resulting `FileCoverageData[]` is folded into the same fragment as the YAML step coverage via the run sink payload's `jsLineCoverage` field.

**Bootstrap format:** The worker bootstrap is `worker-bootstrap.mjs` (plain ESM JavaScript). A `.ts` bootstrap was attempted first — it fails because Node.js checks the Worker entry file's extension before processing `--import` hooks in `execArgv`. `.mjs` is recognized natively; no tsx required since the bootstrap only uses Node.js built-in APIs.

**Worker `execArgv` isolation:** The inner Worker is given `execArgv: ['--import', 'tsx/esm']` explicitly. This prevents the actspec `register.ts` and `coverage-register.ts` chain from being loaded inside the action's worker thread, where they have no purpose and their imports (`node:test`, etc.) can cause failures.

**HTML output:** The action's `.js` file appears as a separate row in Istanbul's coverage table alongside `action.yml`. The per-file detail page shows the JS source with standard Istanbul line highlights — identical to normal JS coverage output. No renderer changes needed.

---

## §6 Job coverage assessment

Jobs in a workflow are represented as statements in a `FileCoverageData` whose `path` is the workflow `.yml` file. Each job gets one statement entry (`statementMap[i]`) with a line range spanning its block in the YAML. The `s[i]` counter is incremented to `1` when the job ran, left at `0` when it was skipped.

No `branchMap` entries are created for jobs in this spike — jobs do not have `if:` conditions in the fixture. The design can be extended to support job-level `if:` guards the same way step `if:` guards work.

**Statement ID collision:** Not possible. Istanbul statement IDs are local to each `FileCoverageData` object (keyed `'0'`, `'1'`, `'2'`…). Two files in the same `CoverageMap` are independent namespaces. `pipeline.yml` has IDs 0–2 for its three jobs; `guarded/action.yml` has IDs 0–3 for its four steps. No collision.

**Text reporter output:** The `text` table shows two rows — one for `pipeline.yml` (3 statements = 3 jobs) and one for `action.yml` (4 statements = 4 steps). The reporter does not distinguish "these are jobs" from "these are steps" — both are statements. This is acceptable for the spike; a future version could add a `functions` layer for job groups or use a custom reporter.

---

## §7 Proposed changes

| Change | Section | Why | Priority | Status |
|---|---|---|---|---|
| Worker inspector coverage for H9 | `docs/ARCHITECTURE.md → Sandboxes`, `docs/DECISIONS.md D1` | `NODE_V8_COVERAGE` does not work in worker threads; inspector API is the correct approach | High — H9 gate criterion | **Done** — implemented in `worker-bootstrap.mjs` + `node.ts` |
| CJS bridge for istanbul packages | `docs/CONVENTIONS.md` | `istanbul-lib-*` are CJS; named imports fail in `"type": "module"` packages. Pattern: `import default from 'pkg'; const { fn } = default`. Centralize in `src/istanbul-compat.ts` so each caller uses named imports | Medium — affects all packages that import istanbul | **Done** — `src/istanbul-compat.ts` created; `collector.ts` and `istanbul-map.ts` updated |
| Worker bootstrap must be `.mjs` | `docs/ARCHITECTURE.md → Sandboxes` | Node.js extension check happens before `--import` hooks fire; `.ts` Worker bootstrap fails even with `--import tsx/esm` in `execArgv`. Use `.mjs` for Worker entry files | Medium — Worker entry file format constraint | **Done** — `worker-bootstrap.mjs` replaces `worker-bootstrap.cjs` |
| Coverage plugs into runner via `--import` | `specs/modules/coverage.md`, `docs/ARCHITECTURE.md` | `@actspec/coverage` will ship a register module that users add via `actspec test --import @actspec/coverage/register`. No `globalTeardown` or runner-specific setup needed. Runner CLI's `--import <path>` arg support is sufficient | High — core integration model | **Done** — proven in spike with `--import ./src/coverage-register.ts` |
| Explicit `execArgv` on action Worker | `docs/ARCHITECTURE.md → Sandboxes` | The inner `worker_threads` Worker must not inherit actspec's `--import` chain. `execArgv: ['--import', 'tsx/esm']` is the correct isolation. | High — correctness | **Done** — set in `node.ts` `spawnWorker()` |
| Document flush-mechanism under actspec runner | `specs/modules/coverage.md` | `process.on('exit', ...)` replaces `afterAll`/`beforeExit` under node:test child processes. No runner detection needed. | Low — supersedes H3/H4 Vitest/Jest complexity | **Done** — documented in §4 |
| Job `if:` guard branches | `specs/modules/coverage.md` | This spike only models jobs as statements; job-level `if:` is common in real workflows | Low — not a gate; add in first `@actspec/coverage` build | Pending |
| Filter `test:pass` to leaf tests | `specs/modules/cli.md` | `node:test` emits suite-level pass events alongside leaf test events | Low — formatting only | Pending |

---

## Exit decision

**All 10 hypotheses pass under the actspec runner. 35/35 tests pass.**

The coverage lifecycle under the actspec runner is simpler than the Vitest/Jest lifecycle:

- One `--import` arg to the CLI → collector registered in every worker.
- `process.on('exit', ...)` → fragment written on worker exit (no `afterAll`/`beforeExit` heuristic).
- Runner's `for await` loop end → host merges fragments (no `globalTeardown` file).
- Module instance sharing via ESM URL cache → test files see the same collector as the register module.

**Proceed to build `@actspec/coverage`** per [coverage.md](../modules/coverage.md). The `--import` plugin model, `process.on('exit')` flush, and `src/istanbul-compat.ts` CJS bridge are the canonical patterns.
