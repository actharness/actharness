# Spike — `actspec test` runner (`@actspec/cli`)

> **POC spike — proves the `actspec test` runner: globals injection via `--import`, file discovery, `node:test` parallel workers, actspec's own `expect()`, and the coverage fragment lifecycle (per-worker flush + host-side merge).** Builds a minimal but real CLI that runs TypeScript test files with zero imports. The spike's register hook, worker model, and `expect()` implementation become the starting point for `@actspec/cli` and `@actspec/matchers`. The coverage spike re-runs on top of this CLI.

## Why this spike

The architecture decision to drop Jest/Vitest and build `actspec test` on `node:test` rests on four unproven bets:

**1. Globals injection via `--import`.** `node:test` has no `setupFiles` equivalent. The design injects `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actspec`, and `expect` into `globalThis` before each test file runs using a register module loaded via `--import`. Whether this mechanism works — globals visible inside a test file, TypeScript-compatible, no import needed — is untested.

**2. `node:test` as a parallel file runner.** `node:test` is Node's built-in unit, not a file-level parallel runner by default. The CLI must discover files and run each in its own worker with per-file results collected by the host. Whether this works cleanly — including result aggregation, exit codes, and TypeScript — is untested.

**3. actspec's own `expect()`.** A chainable `expect(value)` with `.not`, actionable failure messages, and custom matchers (`toHaveSucceeded`, `toHaveOutput`, `toHaveBeenCalledWith`) built without a Jest or Vitest dependency is non-trivial. Whether the pattern is feasible and ergonomic enough is untested.

**4. Coverage fragment lifecycle without `globalTeardown`.** Without Jest/Vitest, there is no `globalTeardown` hook. The CLI must: (a) have each worker write a fragment on exit, and (b) merge all fragments after all workers complete. Both steps depend on `node:test` lifecycle hooks that haven't been validated.

If any of these fail, the runner design needs to change before `@actspec/cli` and `@actspec/matchers` are built, and before the coverage spike is re-run. The spike catches them cheaply.

## The question it answers

Can a CLI built on `node:test`:

- inject `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actspec`, and `expect` into `globalThis` before each file runs, so a test file needs zero imports,
- discover `.ts` test files from a glob, run each in its own parallel worker, and collect pass/fail results,
- ship actspec's own `expect()` — chainable, `.not`-invertible, with actionable failure messages and custom matchers,
- have each worker flush a coverage fragment on exit, and have the host merge all fragments after all workers complete,

...produce a **working, zero-import test runner** that a test author can use with no configuration, and that the coverage spike can use as its execution substrate?

## Hypotheses to prove

- **H1 — Globals injection.** A register module loaded via Node's `--import` flag injects `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actspec`, and `expect` into `globalThis`. A test file with zero imports can call them all and the test executes correctly.
- **H2 — TypeScript test files run without per-file config.** `.ts` test files execute under the runner without a `tsconfig.json` per file — via `tsx` or equivalent loaded as the module loader. Source maps are preserved for error locations.
- **H3 — File discovery + `node:test` parallel execution.** Given a glob pattern, the CLI finds all matching files and runs each in its own `node:test` worker in parallel. Host process collects pass/fail/skipped counts and exits non-zero if any test fails.
- **H4 — actspec's own `expect()` is feasible.** `expect(value)` returns a chainable assertion object. `.not` correctly inverts any matcher. Failure messages show actual vs expected and are actionable. At least three matchers work: `toBe`, `toHaveSucceeded`, and `toHaveOutput` (operating on a stub `RunResult` — no real action execution needed).
- **H5 — Negation and failure messages.** A failing assertion throws with a message that names the matcher, the actual value, and what was expected. `.not` negates correctly and produces a matching inverse message.
- **H6 — Coverage fragment flush at worker exit.** The register hook writes a per-worker JSON fragment to a temp dir when the worker's test file completes. The host process finds all fragment files after all workers exit — no fragments are missing or empty.
- **H7 — Host-side merge.** After all workers complete, the CLI reads all fragment files, merges them via `istanbul-lib-coverage`, and emits a `text` coverage report. The merged report reflects contributions from multiple workers with no double-counting.

## In scope

- **Register module (`register.ts`)** — loaded via `--import`; injects globals into `globalThis`; sets up the coverage fragment flush hook (`process.on('exit')`).
- **Minimal CLI (`cli.ts`)** — accepts a glob pattern; discovers `.ts` files; spawns each as a `node:test` worker with `--import ./register.ts`; accepts additional `--import <path>` entries that are also loaded into each worker (this is the hook the coverage spike uses to load its own setup module alongside the runner's register module); collects results; exits non-zero on failure; after all workers, merges fragments and emits a text report if `--coverage` is passed.
- **Minimal `expect()` (`expect.ts`)** — chainable assertion object; `.not` modifier; matchers: `toBe`, `toEqual`, `toHaveSucceeded`, `toHaveOutput`, `toHaveBeenCalledWith`; actionable failure messages (actual vs expected, matcher name).
- **Stub `actspec()` global** — a minimal stand-in injected via the register module; returns a fake `RunResult` so test files can call `actspec('./action.yml').run(...)` without real action execution. The stub is **replaced by the real implementation** when `@actspec/core` is built — the spike only needs to prove the injection and expect() surfaces work.
- **TypeScript execution** — via `tsx` (or equivalent) as the module loader; `.ts` test files run without per-file config.
- **Fixture test files** — at least three `.ts` files that exercise globals and `expect()`:
  - one that passes (proves globals + matchers work),
  - one that fails (proves failure messages are actionable),
  - one with nested `describe` + `beforeEach` (proves lifecycle hooks work).
- **Coverage fragment scenario** — two test files each write a fragment; merged report reflects both.

## Explicitly out of scope

- Real `actspec()` / action execution (stub is sufficient).
- All v0.1 matchers (5 matchers is enough to prove the pattern).
- `actspec run`, `actspec init` commands.
- Full Istanbul reporter set (text only — HTML, lcov, etc. are proven in the coverage spike).
- Configuration file (`actspec.config.ts`).
- Full `@actspec/cli` / `@actspec/matchers` package build (dual ESM/CJS, API Extractor, publication).

## Success criteria (the spike's gate)

1. **Zero-import test file works** — a `.ts` file with no `import` statements runs via `node cli.ts 'test/**/*.ts'` and its `describe`/`it`/`expect` calls resolve correctly.
2. **TypeScript works** — `.ts` test files execute without a per-file tsconfig; error locations are line-accurate.
3. **Pass/fail reported correctly** — a passing suite exits 0; a suite with one failing test exits non-zero; the output names the failing test and matcher.
4. **`expect()` API is correct** — `expect(x).toBe(y)` passes when equal, throws when not; `.not.toBe(y)` is the correct inverse; failure messages are actionable.
5. **Custom matchers work** — `expect(result).toHaveSucceeded()` passes for `{ conclusion: 'success' }`, fails for `{ conclusion: 'failure' }`, with actionable message.
6. **Parallel workers** — two test files run in parallel; both results appear in output; total time is less than sequential.
7. **Coverage fragment flush** — two workers each write a fragment file to the temp dir; neither is missing after all workers exit.
8. **Host-side merge** — `node cli.ts --coverage 'test/**/*.ts'` emits a text coverage report that reflects both workers' fragments with no double-counting.

## Friction scenarios to probe (write at least one test for each)

| # | Probe | What would constitute friction |
|---|---|---|
| 1 | `--import` + `globalThis` mutation | Globals injected in register module not visible inside the test file — injection mechanism doesn't work |
| 2 | `--import` + TypeScript loader coexistence | `tsx` as loader conflicts with `--import` register module — can't use both simultaneously |
| 3 | `node:test` worker per file | `node:test`'s parallel mode doesn't support running arbitrary files as workers, or result collection is opaque |
| 4 | `expect()` `.not` implementation | `.not` requires a class hierarchy or Proxy; simple object approach doesn't support all matchers correctly |
| 5 | Failure message ergonomics | Thrown error is a bare string — `node:test` doesn't surface it cleanly in output; test names lost |
| 6 | `process.on('exit')` in `node:test` workers | `exit` event doesn't fire reliably when a `node:test` worker finishes — fragment not written |
| 7 | Worker exit timing | Worker exits before async fragment write completes — file missing or empty in host |
| 8 | Host lifecycle hook | No clean hook to run code after all `node:test` workers complete — merge must poll or use a different pattern |
| 9 | TypeScript source maps | Errors in `.ts` test files point to compiled JS line numbers, not `.ts` source lines — unusable output |
| 10 | Stub `actspec()` type safety | `actspec` in `globalThis` has type `any`; TypeScript test files lose type checking — globals.d.ts needed |

## Required deliverable — findings document

Findings are written to [`specs/spikes/runner-findings.md`](runner-findings.md) alongside the implementation (location: `spike/runner/`):

1. **H1–H7 verdict** — `✅` / `❌` / `⚠️` per hypothesis, with the observed failure for any `❌`.
2. **Friction log** — for each probe: what was wanted, what the implementation revealed, classification (`no change needed` / `design gap` / `API change needed`).
3. **Globals injection assessment** — which `--import` mechanism works? How does it interact with `tsx`/`ts-node`? Any globals that couldn't be injected?
4. **`expect()` implementation assessment** — what pattern was used for `.not`? How are failure messages generated? What does the output look like in `node:test`'s reporter?
5. **Coverage lifecycle assessment** — how does the worker signal "I'm done, flush"? What hook does the host use to know all workers are finished? Any race conditions observed?
6. **`node:test` as a file runner assessment** — how is per-file parallelism achieved? How are results collected? What's the result shape?
7. **Proposed changes** — table of any design changes needed before building `@actspec/cli` and `@actspec/matchers`: `change`, `cli.md / matchers.md / DECISIONS.md section`, `why`, `priority`.

## Exit — what we decide after

- **If all criteria met:** the spike's register hook, CLI, and `expect()` implementation are promoted as the starting point for `@actspec/cli` and `@actspec/matchers`. The coverage spike is updated to use this CLI and re-run.
- **If globals injection doesn't work (H1 fails):** investigate alternatives (`--require`, a wrapper script that pre-loads and `eval`s each file, or a custom loader). Record findings and update [cli.md](../modules/cli.md) before building.
- **If `node:test` can't run files as parallel workers (H3 fails):** investigate alternatives (`worker_threads` directly, `child_process.fork`). The runner design may need to not use `node:test` as the file-level scheduler — update [cli.md](../modules/cli.md).
- **If `expect()` `.not` or failure messages are unworkable (H4/H5 fail):** explore adopting a minimal existing implementation (e.g. `@vitest/expect` as an internal dep, not a peer) and record the trade-off against actspec's zero-peer-dep goal.
- **If coverage fragment flush is unreliable (H6/H7 fail):** investigate IPC-based flush (worker sends fragment data to host via `parentPort`/`worker.on('message')`) as an alternative to disk-first write on `process.exit`. Update [DECISIONS.md D1](../../docs/DECISIONS.md#d1--coverage-observes-runs-via-a-global-run-sink).

## References

- [specs/modules/cli.md](../modules/cli.md) — the `actspec test` contract this spike validates.
- [specs/modules/matchers.md](../modules/matchers.md) — the `expect()` contract this spike validates.
- [docs/DECISIONS.md D1](../../docs/DECISIONS.md#d1--coverage-observes-runs-via-a-global-run-sink) — the global run sink design; coverage lifecycle.
- [docs/DECISIONS.md D26](../../docs/DECISIONS.md#d26--actspec-ships-its-own-expect----no-jest-or-vitest-peer-dependency) — why actspec owns `expect()`.
- [docs/ARCHITECTURE.md → CLI](../../docs/ARCHITECTURE.md#cli-actspec-test--actspec-run) — runner architecture description.
- [specs/spikes/coverage.md](coverage.md) — the coverage spike that re-runs on top of this runner.
