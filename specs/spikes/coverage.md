# Spike — coverage map + reporter pipeline (`@actspec/coverage`)

> **POC spike — proves the Istanbul-from-YAML coverage map, disk-first fragment merge, and reporter pipeline through real execution, under the `actspec test` runner (built on `node:test`).** Builds a minimal `CoverageCollector`, runs composite, node, and workflow tests, and verifies that all coverage layers (step, `if:`-branch, JS line, job) produce a valid, merged Istanbul report. This spike runs on top of the runner spike (`spike/runner/`) — the runner must be completed first. The spike's collector and merge script become the starting point for `@actspec/coverage`.

## Why this spike

The coverage design rests on four unproven bets:

**1. Istanbul-from-YAML (D19).** Istanbul is designed for JavaScript source maps. Using `istanbul-lib-coverage` to build a `FileCoverageData` where "statements" are YAML step line ranges and "branches" are `if:` true/false outcomes is novel. Whether the resulting map is valid — accepted by reporters, renderable as HTML, mergeable via `nyc merge` — is untested.

**2. Disk-first fragment merge under `actspec test` (D1).** The runner executes each test file in its own worker process, so an in-memory singleton only ever sees one file's runs. The design writes per-worker fragments to a temp dir and merges them after all workers complete (CLI-managed — no `globalTeardown` config needed). Whether this wires up correctly under `node:test`'s worker model is validated here, using the runner spike's lifecycle as the substrate.

**3. `registerRunListener` cross-worker hook (D1).** The channel is `globalThis[Symbol.for('actspec.runSink')]`. Each worker has its own `globalThis`, so coverage must register its listener inside the worker (via the runner's register hook) and write fragments to disk before the worker exits. Whether the listener fires for every `run()` call in a worker — with no silent drops — is unproven under `node:test`.

**4. JS line coverage via V8 from `worker_threads`.** The node sandbox uses `worker_threads` to run JS actions. Collecting V8 coverage data from inside a worker thread and piping it into the same Istanbul fragment-merge pipeline requires inspector-level instrumentation inside the worker. Whether this works without changing the sandbox design — and whether the resulting line data merges cleanly with the YAML step map — is untested.

If any of these fail after `@actspec/coverage` is built, the result is a fundamental redesign. The spike catches them cheaply, before any of that exists.

## Prerequisite

**The runner spike (`spike/runner/`) must be completed first.** This spike adds `spike/runner` as a local `package.json` dependency and runs its test files via the runner spike's CLI. H3–H5 below depend on the runner's globals injection, worker lifecycle, and fragment flush mechanism being proven.

### Integration mechanism

The coverage spike adds a second register module (`setup.ts`) that registers the `registerRunListener` coverage listener and the fragment flush hook inside each worker. The runner's CLI loads it via an additional `--import` entry alongside its own register module:

```bash
runner/cli.ts --import ../coverage/setup.ts 'test/**/*.ts' --coverage
```

This is structurally identical to how `@actspec/coverage` will work in production — it hooks into the runner from the outside, not by modifying the runner. The runner spike's CLI must support additional `--import` entries for this to work (see [runner.md § In scope](runner.md)).

## The question it answers

Does a `CoverageCollector` that:

- subscribes to `RunResult`s via `globalThis[Symbol.for('actspec.runSink')]` from within the runner's register hook (injected before each test file),
- builds an Istanbul `FileCoverageData` from each result's `step.ran`, `step.if.result`, step YAML line ranges (from the CST — D2), and V8 line data from the node sandbox,
- writes a per-worker JSON fragment to a temp dir when the worker exits, and
- is merged by the CLI after all workers complete via `istanbul-lib-coverage`,

...produce a **valid, usable Istanbul coverage report** — `text` output, `html` rendering the `action.yml` source with step and line highlights, `coverage-final.json` that `nyc merge` accepts — for a suite spanning composite, node, and workflow action tests, **running under `actspec test`**?

## Hypotheses to prove

- **H1 — Istanbul-from-YAML map is valid.** A `FileCoverageData` with YAML line ranges as statements and `if:` outcomes as branches is accepted by `istanbul-lib-coverage` without errors, and `coverage-final.json` passes `nyc merge`.
- **H2 — HTML reporter renders `action.yml`.** The Istanbul HTML reporter produces output for the YAML "source file" — at minimum: the filename, covered/uncovered step counts, and highlighted YAML lines. Imperfect rendering counts as ✅ if the map is valid; a crash or blank page is ❌.
- **H3 — Disk-first fragment pattern works under `actspec test`.** Each worker writes a fragment; the CLI merges them after all workers finish; fragment files are present and readable; merged report reflects all workers.
- **H4 — `registerRunListener` fires within `node:test` workers.** The listener registered via the runner's register hook is notified for every `run()` call in that worker's test file. No runs are silently dropped.
- **H5 — Parallel safety.** Two test files (separate workers) produce two fragments; merging them yields combined coverage with no double-counting and no missing signal.
- **H6 — Threshold enforcement.** A suite with `thresholds: { ifBranches: 100 }` where only one branch direction is exercised exits non-zero. The same suite with both directions exercised exits zero.
- **H7 — `nyc merge` interop.** `coverage-final.json` merges with a toy JS `coverage-final.json` via `nyc merge` without error, producing a combined map.
- **H8 — JS line coverage from `worker_threads`.** V8 coverage data collected inside a node-action worker thread is piped into the fragment-merge pipeline and appears as real line coverage in the Istanbul map — without requiring changes to the sandbox design proven in the node-sandbox spike.
- **H9 — Job coverage fits the Istanbul map.** Workflow jobs tracked as "statements" in the Istanbul map work correctly alongside step statements — no collision, no malformed output, meaningful `text`/`html` output for both layers.

## In scope

- **YAML CST line-range extraction** — use `yaml` (eemeli/yaml, per D2) in CST mode to extract each step's start/end line from a parsed `action.yml`. Validate that ranges are present and correct.
- **Minimal `CoverageCollector`** — subscribes via `registerRunListener`, constructs `FileCoverageData` per source file, accumulates signal from `RunResult`s (step ran/skipped, `if:` true/false, job ran/skipped).
- **Disk-first fragment writer** — writes a per-worker JSON fragment (Istanbul map snapshot) to a configurable temp dir when the worker exits (via the runner's exit hook).
- **CLI-managed merge** — after all workers complete, reads all fragments, merges via `istanbul-lib-coverage`, emits configured reporters to `coverageDir`. No `globalTeardown` config needed — the runner spike's CLI manages this.
- **Reporters: `text`, `html`, `json`** (`coverage-final.json`). Proving these three is enough — the remaining Istanbul reporters are drop-in once the map is valid.
- **Threshold enforcement** — fail the suite when a metric falls below its configured percentage.
- **`nyc merge` interop check** — confirm `coverage-final.json` merges with a toy JS coverage map.
- **Parallel safety scenario** — two test files, two workers, one merged report.
- **JS line coverage from `worker_threads`** — instrument the node-action worker with V8 coverage collection (via Node's `inspector` module); extract the coverage after the worker completes; fold it into the same fragment as the step/`if:`-branch data.
- **Job coverage** — track which workflow jobs ran vs were skipped in the Istanbul map alongside step data.
- **`if:`-branch granularity** — confirm that step-level `if:` (true/false per guard) is the right granularity. Confirm expression sub-branches (inside `${{ a && b || c }}`) are absent from this spike and assess whether their absence creates a visible gap in the report.
- **Fixture actions (all four required):**
  - Composite with `if:` guards exercised **both** directions across tests.
  - Composite with an `if:` guard exercised **one direction only** (gap detection + threshold enforcement).
  - Node action that sets outputs via `$GITHUB_OUTPUT` (for JS line coverage probe).
  - Workflow with at least two jobs connected via `needs:` (for job coverage probe).

## Explicitly out of scope

- Expression sub-branch coverage (sub-conditions inside `${{ a && b || c }}`).
- Bash line coverage (kcov/bashcov — opt-in, shell-dependent).
- Full Istanbul reporter set beyond `text`/`html`/`json`.
- Input/default coverage metric (follows the same Istanbul-map pattern as steps — not a viability risk).
- Full `@actspec/coverage` package build (dual ESM/CJS, API Extractor, publication).

## Success criteria (the spike's gate)

1. **Istanbul map is valid** — `istanbul-lib-coverage` accepts the `FileCoverageData` without throwing; `nyc merge` on `coverage-final.json` exits zero.
2. **HTML renders** — `coverage/index.html` is produced and contains the `action.yml` filename and covered/uncovered indicators. Crash or blank output is a gate failure.
3. **Runner integration works** — the disk-first/fragment/merge pattern works under `actspec test` (`node:test`). The CLI manages the full lifecycle without any user-facing config.
4. **Listener fires** — `getCoverage().total.steps.covered > 0` after `run()` is called in a worker.
5. **Parallel merge is complete** — two test files produce two fragment files; the merged report reflects both.
6. **Threshold failure is observable** — a suite with `thresholds: { ifBranches: 100 }` and one branch direction unexercised exits non-zero.
7. **`nyc merge` passes** — `coverage-final.json` + a toy `js-coverage.json` merge without error.
8. **JS line coverage appears** — the merged report contains line-level coverage for the node action's JS file. The V8 data round-trips through the fragment pipeline without corruption.
9. **Job coverage appears** — the merged report contains job-level coverage for the workflow fixture. Both ran and skipped jobs are represented.

## Friction scenarios to probe (write at least one test for each)

| # | Probe | What would constitute friction |
|---|---|---|
| 1 | YAML CST line extraction | Ranges absent, off-by-one, or not exposed at step level — map positions wrong |
| 2 | Istanbul map construction from YAML | `FileCoverageData` rejects non-JS "source", missing required field, or wrong range type — whole design fails |
| 3 | HTML rendering of YAML source | Reporter crashes on a `.yml` "source", or renders a blank page — usability gap |
| 4 | Listener fires inside `node:test` worker | Register-hook listener registered but `run()` doesn't notify it — silent zero coverage |
| 5 | Worker teardown timing | Fragment file not flushed before worker exits — CLI merge sees missing or empty files |
| 6 | CLI merge lifecycle | No clean hook after all workers complete; merge runs before some workers finish — incomplete report |
| 7 | `nyc merge` with YAML map | Rejects a map whose "source" is a `.yml` file — interop broken |
| 8 | Threshold on partial branch | `if:` exercised one way, threshold at 100%, suite does not fail — gap invisible |
| 9 | V8 coverage from `worker_threads` | Inspector API unavailable inside worker, or data not extractable post-run — JS line coverage impossible without sandbox changes |
| 10 | Job coverage alongside step coverage | Both layers in the same `FileCoverageData` produce malformed map, collision in statement IDs, or confusing `text`/`html` output |

## Required deliverable — findings document

Findings are written to [`specs/spikes/coverage-findings.md`](coverage-findings.md) alongside the implementation (location: `spike/coverage/`):

1. **H1–H9 verdict** — `✅` / `❌` / `⚠️` per hypothesis, with the observed failure for any `❌`.
2. **Friction log** — for each probe: what was wanted, what the implementation revealed, classification (`no change needed` / `design gap` / `API change needed`).
3. **Istanbul-from-YAML assessment** — does the HTML renderer produce useful output? What do YAML line ranges look like in the map? Any field the map is missing that `nyc` requires?
4. **Disk-first + CLI merge assessment** — did fragment files survive? Was the merge lifecycle clean under `node:test`? Any race condition or missing hook?
5. **JS line coverage assessment** — how is V8 data extracted from the worker thread? Does it fold cleanly into the fragment? What does the HTML report look like for a JS file covered from inside a worker?
6. **Job coverage assessment** — how are jobs represented in the Istanbul map alongside steps? Is the `text`/`html` output meaningful? Is there a collision risk in statement IDs?
7. **`if:`-branch granularity verdict** — is step-level `if:` (true/false) sufficient for meaningful coverage signal? Is the absence of expression sub-branches a visible gap in the report?
8. **Proposed changes** — table of any design changes needed before building `@actspec/coverage`: `change`, `coverage.md / API.md / DECISIONS.md section`, `why`, `priority`.

## Exit — what we decide after

- **If all criteria met, no design gaps:** the spike's `CoverageCollector`, fragment writer, and merge script are promoted as the starting point for `@actspec/coverage`. The design is confirmed as-is.
- **If Istanbul-from-YAML produces an invalid or unusable map (H1/H2 fail):** escalate — the Istanbul-based approach (D19) may need to change — before any `@actspec/coverage` work begins.
- **If the disk-first/fragment pattern fails under `actspec test` (H3 fails):** investigate alternatives (IPC-based fragment transfer via `parentPort`, shared memory) and record findings before building.
- **If `registerRunListener` doesn't fire in `node:test` workers (H4 fails):** the hook design in D1 is wrong for `node:test` — record what wiring is actually needed and update [core.md](../modules/core.md) and [DECISIONS.md D1](../../docs/DECISIONS.md#d1--coverage-observes-runs-via-a-global-run-sink) before building `@actspec/core`.
- **If JS line coverage cannot be extracted from `worker_threads` without sandbox changes (H8 fails):** record the required sandbox change and update [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) and the node executor design before building `@actspec/node`.
- **If job coverage produces a malformed map or collides with step coverage (H9 fails):** record the required Istanbul-map schema change and update [coverage.md](../modules/coverage.md) and [D19](../../docs/DECISIONS.md#d19--istanbul-coverage-map-representation) before building.

## References

- [specs/spikes/runner.md](runner.md) — the runner spike this coverage spike runs on top of. Must be completed first.
- [docs/DECISIONS.md D1](../../docs/DECISIONS.md#d1--coverage-observes-runs-via-a-global-run-sink) — the global run sink design this spike validates.
- [docs/DECISIONS.md D2](../../docs/DECISIONS.md#d2--yaml-parser-preserves-positions) — YAML CST for per-step line ranges.
- [docs/DECISIONS.md D19](../../docs/DECISIONS.md#d19--istanbul-coverage-map-representation) — the Istanbul-map decision this spike validates.
- [docs/ARCHITECTURE.md → Coverage](../../docs/ARCHITECTURE.md#coverage-cross-cutting-all-versions) — full coverage design and layer table.
- [specs/modules/coverage.md](../modules/coverage.md) — the package contract this spike feeds.
- [docs/API.md §9](../../docs/API.md) — the public coverage surface.
- [specs/spikes/node-sandbox-findings.md](node-sandbox-findings.md) — confirmed the `worker_threads` sandbox; this spike extends it with V8 coverage collection.
- [specs/spikes/api-ergonomics-findings.md](api-ergonomics-findings.md) — confirmed the `RunResult` signal (`step.ran`, `step.outcome`, `if.result`) that coverage consumes.
