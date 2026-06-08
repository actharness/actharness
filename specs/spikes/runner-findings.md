# Runner spike — findings

> Spike: [`spike/runner/`](../../spike/runner/) · Spec: [`specs/spikes/runner.md`](runner.md) · Date: 2026-06-07

## H1–H7 verdicts

| Hypothesis | Verdict | Notes |
|---|---|---|
| **H1** — Globals injection via `--import` | ✅ | `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actspec`, `expect` all injected via `--import register.ts` and visible in test files with zero imports |
| **H2** — TypeScript test files run without per-file config | ✅ | `.ts` test files execute under `--import tsx/esm` with no per-file tsconfig; TypeScript is fully stripped. Source maps preserved (error locations are `.ts` line-accurate). |
| **H3** — File discovery + `node:test` parallel execution | ✅ | `glob` discovers files from patterns; `run({ files, concurrency: true, execArgv })` runs each in a separate subprocess in parallel. Results collected via async iteration on the `TestsStream`. Host exits non-zero when any file has failures. |
| **H4** — actspec's own `expect()` is feasible | ✅ | Chainable `expect(value)` with `.not` property, `toBe`, `toEqual`, `toHaveSucceeded`, `toHaveFailed`, `toHaveOutput`, `toHaveBeenCalledWith`. Pattern: `createMatcher(value, negated)` returning a plain object with a `get not()` accessor. No class hierarchy needed. |
| **H5** — Negation and failure messages | ✅ | `.not` correctly inverts every matcher. Failure messages are actionable: show the matcher name, actual value, and what was expected. `node:test` surfaces the `AssertionError.message` in output under the failing test name. |
| **H6** — Coverage fragment flush at worker exit | ✅ | `process.on('exit', ...)` fires reliably in `node:test`-spawned subprocesses (they are real child processes, not `worker_threads`). `writeFileSync` in the handler writes the fragment before the process exits. Both workers' fragments are present in the temp dir when the host reads them. |
| **H7** — Host-side merge | ✅ | After the `for await` loop ends (all workers done), the host reads all fragment files from `ACTSPEC_COVERAGE_TMP`, merges via `istanbul-lib-coverage`'s `createCoverageMap().merge()`, and emits a `text` report. The merged report reflects both workers' contributions (statement counts summed, branch directions unioned). No double-counting. |

---

## Friction log

| # | Probe | What we wanted | What the implementation revealed | Classification |
|---|---|---|---|---|
| 1 | `--import` + `globalThis` mutation | Globals injected in register module visible inside test file | Works. `Object.assign(globalThis, { describe, it, ... })` and direct property assignment make all globals visible in test files with zero imports. | no change needed |
| 2 | `--import` + TypeScript loader coexistence | `tsx/esm` as loader + `--import register.ts` coexist | Works. Order matters: `--import tsx/esm` must come before `--import register.ts` in `execArgv`. tsx registers its loader hook first; when register.ts is then imported it is correctly transformed. Both globals injection and TypeScript loading work simultaneously. | no change needed |
| 3 | `node:test` worker per file | `run({ files, execArgv })` runs each file in its own subprocess | Works. `run()` in Node 22.10.0 accepts `execArgv` and spawns a subprocess per file. Results surface as a `TestsStream` async iterable of `{ type, data }` events. Async `for await` iteration works correctly; the loop ends when all workers finish. | no change needed |
| 4 | `expect()` `.not` implementation | `.not` supports all matchers correctly | Works. A `get not()` accessor on the returned plain object that calls `createMatcher(value, !negated)` is sufficient. No `Proxy`, no class hierarchy. Every matcher re-checks the `negated` flag via a local `assert()` helper. | no change needed |
| 5 | Failure message ergonomics | Thrown `AssertionError` message surfaced cleanly by `node:test` | Works. `node:test` displays `err.message` from a caught `Error` under the failing test's name in `test:fail` event data. The message format (`Expected X to be Y`) reads cleanly in the CLI output. | no change needed |
| 6 | `process.on('exit')` in `node:test` workers | `exit` event fires reliably when a worker's test file completes | Works. `node:test`'s `run()` spawns real child processes (not `worker_threads`). `process.on('exit', ...)` fires after all tests in the file complete. `writeFileSync` is synchronous and safe in the exit handler. No fragments were missing after the host's `for await` loop completed. | no change needed |
| 7 | Worker exit timing | Fragment written before host reads the temp dir | Works. By the time the `for await` loop on `TestsStream` ends, all worker subprocesses have exited and all fragment files are on disk. No race condition observed. | no change needed |
| 8 | Host lifecycle hook | Clean hook to run code after all `node:test` workers complete | Works. The end of the `for await (const event of stream)` loop is the natural "all workers done" signal. No polling or separate lifecycle hook needed. | no change needed |
| 9 | TypeScript source maps | Errors in `.ts` test files point to `.ts` source lines | Works. tsx preserves source maps. `AssertionError` stack traces in test output reference the `.ts` file and line number, not compiled JS. | no change needed |
| 10 | Stub `actspec()` type safety | `actspec` in `globalThis` has correct type in test files | Works. `src/globals.d.ts` declares all injected globals (`describe`, `it`, `test`, lifecycle hooks, `actspec`, `expect`) at the global scope. Since `tsconfig.json` includes `src/**/*`, this file is picked up automatically — test files get full TypeScript checking with zero imports and zero triple-slash references. | no change needed |

---

## §3 Globals injection assessment

**Mechanism used:** A register module (`src/register.ts`) is loaded via Node's `--import` flag in each worker subprocess's `execArgv`. The module runs before the test file's main module.

**What works:**
- `Object.assign(globalThis, { describe, it, ... })` makes node:test's lifecycle functions available globally. When `node:test`'s `run()` spawns workers, it may also inject these globals via its own `--test` mode; in that case our injection is redundant but harmless (same values from the same `node:test` module).
- Direct property assignment (`globalThis['actspec'] = ...`, `globalThis['expect'] = ...`) works for non-node:test globals.
- The register module itself is TypeScript (`.ts`) and is correctly transformed by tsx because `--import tsx/esm` appears first in `execArgv`.

**Interaction with tsx:**
- `--import tsx/esm` registers tsx's loader hooks.
- `--import file:///path/to/register.ts` is then loaded; tsx's hooks transform it before Node executes it.
- Relative imports inside `register.ts` (`import { expect } from './expect.ts'`) resolve relative to `register.ts`'s own URL, not the test file's location. Works correctly.

**What cannot be injected:** Nothing observed. All nine globals injected successfully.

---

## §4 `expect()` implementation assessment

**Pattern used:** A factory function `createMatcher(value, negated)` returns a plain object literal with matcher methods and a `get not()` accessor. No Proxy, no class hierarchy.

```ts
function createMatcher(value: unknown, negated: boolean): Matcher {
  function assert(condition: boolean, failMsg: string, passMsg: string): void {
    if (negated ? condition : !condition) throw new AssertionError(negated ? passMsg : failMsg);
  }
  return {
    get not() { return createMatcher(value, !negated); },
    toBe(expected) { assert(value === expected, `Expected ... to be ...`, `... not to be ...`); },
    // ...
  };
}
```

**Failure message format in `node:test` output:**

```
  ✗ toHaveFailed on a success result shows conclusion
    Expected action to fail but conclusion was 'success'
  ✗ toHaveOutput with wrong value shows key + actual + expected
    Expected output 'greeting' to equal 'Hello Nobody' but got 'Hello World'
```

`node:test` surfaces `err.message` from `test:fail` event's `details.error`. The one-line messages are readable and actionable.

**`.not` correctness:** All matchers inverted correctly. No matcher has a hidden interaction with `.not` — the `negated` flag is the only mechanism.

---

## §5 Coverage lifecycle assessment

**Worker side (H6 — `process.on('exit', ...)`):**

`node:test`'s `run()` spawns real child processes (not `worker_threads`). Each child process runs `node --import tsx/esm --import register.ts [test-file.ts]`. The `process.on('exit', ...)` event fires after all tests in the file complete, before the process exits. `writeFileSync` in the handler is synchronous and safe — no async concerns. Each worker writes one fragment file named `fragment-{pid}-{uuid}.json` to `ACTSPEC_COVERAGE_TMP`.

**Why child processes (not `worker_threads`) matters:** The `process.on('exit', ...)` handler fires on child process exit. In a `worker_threads` model, this event fires only on the host process exit (not on thread termination), which would require the inspector API workaround found in the node-sandbox spike. Since `node:test` uses child processes here, the simple `exit` handler approach works. No inspector API needed for CLI coverage.

**Host side (H7 — merge after stream ends):**

The `for await (const event of stream)` loop ends exactly when all workers finish. Fragment files are on disk at that point. `istanbul-lib-coverage`'s `createCoverageMap().merge()` correctly sums execution counts and unions branch directions across two workers' fragments. The merged text report is emitted after the loop.

**Env var propagation:** `process.env.ACTSPEC_COVERAGE_TMP = coverageTmpDir` set in the CLI process is inherited by all child processes automatically. No `--env` flag needed.

---

## §6 `node:test` as a file runner assessment

**How per-file parallelism is achieved:**

`run({ files, concurrency: true, execArgv })` in Node 22.10.0 spawns one child process per file. `concurrency: true` means auto (CPU count - 1). For a small number of files (<= CPU count), all files run simultaneously.

**How results are collected:**

The returned `TestsStream` is an async iterable of structured events. Key event types used:
- `test:pass` — emitted for both **leaf tests** and **suite blocks** (describe) when they pass.
- `test:fail` — emitted for each failing test and for its parent suite(s).
- `test:stdout` / `test:stderr` — subprocess stdio; not consumed in the spike CLI (silently dropped in the async iteration).

**Design note — suites inflate pass/fail counts:** `test:pass` fires for `describe` blocks as well as `it` blocks. A test file with one `describe` containing three `it` blocks emits four `test:pass` events (the three `it`s + the `describe`). The real `@actspec/cli` should filter to leaf tests (e.g., by checking that `event.data.nesting > 0 && event.data.details?.type === 'test'`, or by only counting events where the name doesn't match any known suite name). This is a formatting concern, not a correctness concern — exit codes based on `test:fail` count are not affected.

**Result shape:** Each event is `{ type: string, data: { name, nesting, file, details: { error?, duration_ms } } }`. The `file` field identifies which test file the event came from — useful for per-file reporting in the real CLI.

**Exit code:** Process exits 1 if `failed > 0`. `node:test` subprocesses exit with their own codes, but the host only uses the `test:fail` event count from the stream.

---

## §7 Proposed changes

| Change | Section | Why | Priority |
|---|---|---|---|
| Filter `test:pass`/`test:fail` to leaf tests only | `specs/modules/cli.md` | `node:test` emits suite-level events alongside leaf test events; the real CLI output should show only `it`/`test` results, not `describe` container results | Low — formatting only; exit codes unaffected |
| Document CJS default-import pattern | `docs/CONVENTIONS.md` | `istanbul-lib-coverage`, `istanbul-lib-report`, `istanbul-reports` are CJS; in ESM context (`"type": "module"`) they require `import pkg from 'pkg'` + destructure, not named imports | Low — packaging detail; document once |
| `--import` ordering invariant | `specs/modules/cli.md` | `tsx/esm` must precede `register.ts` in `execArgv`; if reversed, register.ts loads before tsx's hooks are registered and TypeScript transformation fails | Medium — document in CLI implementation notes |

---

## Exit decision

**All 7 hypotheses pass. No API or CLI design changes needed before building `@actspec/cli` and `@actspec/matchers`.**

- The register module + `--import` injection pattern is the starting point for `@actspec/cli`'s worker bootstrap.
- The `expect()` factory pattern (`createMatcher(value, negated)`) is the starting point for `@actspec/matchers`.
- The coverage lifecycle (child process `exit` handler → fragment file → host merge after stream ends) is the correct model for `@actspec/coverage` when used under `actspec test`. Note: this lifecycle is simpler than the Vitest/Jest lifecycle proven in the coverage spike, because `node:test` uses child processes rather than `worker_threads` — `process.on('exit', ...)` works directly.

**Proceed to build `@actspec/cli` and `@actspec/matchers`** per [cli.md](../modules/cli.md) and [matchers.md](../modules/matchers.md).
