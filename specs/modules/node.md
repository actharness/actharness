# `@actharness/node`

The v0.2 executor: runs `using: node20` / `using: node24` / any future `node<N>` actions — through the **same** `mock` / `run` / `expect` surface as composite. Owns the `NodeExecutor`, the `JsSandbox` (`child_process` launcher), and the network mock layer (`mockGitHubApi` / `mockNetwork`). Registers itself into core's executor registry.

## Owns

- A `NodeExecutor` with `handles(/^node\d+$/)`.
- `JsSandbox` — `child_process.fork` launcher, per-child `process.env` isolation, `cwd` set to the run's workspace (matching `GITHUB_WORKSPACE` fidelity on the real runner — see [node-sandbox-cwd-fidelity.md](../sessions/node-sandbox-cwd-fidelity.md)), protocol file wiring, `stdout`/`stderr` capture, `process.exit` trap, undici `MockAgent` mounting, and inspector-API JS line coverage.
- The `mockGitHubApi` / `mockNetwork` implementations, wired into core's global mock surface via a registration entry.
- No new *consumer* types — results flow through core's `RunResult` / `StepResult`. `GitHubApiRoutes`, `NetworkMatcher`, and `NetworkMock` are added to `@actharness/types` as part of v0.2 (not defined here).

## Depends on

`@actharness/core` (seam types, protocol, context, errors, registration hook) and `@actharness/types`. No other `@actharness/*` imports.

## Behavior (MUST)

### 1. Executor registration

Registers a `NodeExecutor` into core's executor registry at module load time (side-effect entry, listed in `sideEffects` in `package.json` per [D25](../../docs/DECISIONS.md#d25--sideeffects-false-with-the-registration-entry-excepted)). Also registers the `mockGitHubApi` / `mockNetwork` implementations onto the `actharnessFn` global mock surface via the same registration hook. Core dispatches to this executor for any `using:` value matching `/^node\d+$/`.

### 2. Phase lifecycle (pre / main / post)

Run the three phases in order: `pre:` → `main:` → `post:`. Guard each with its `if`-analog (`pre-if` / `post-if`); default is `always()`. Each phase that **runs** produces one `StepResult` with `phase: 'pre' | 'main' | 'post'`. A phase that is skipped by its guard produces a `StepResult` with `ran: false, conclusion: 'skipped'` and is included in `RunResult.steps` — so assertions on phase presence are always possible.

`pre:` and `post:` are optional manifest fields; if absent, only `main:` runs (one `StepResult`).

Overall `RunResult.conclusion` is `'failure'` if any phase that ran produced `conclusion: 'failure'`; `'success'` otherwise.

### 3. `JsSandbox` — sandbox bootstrap

Each phase launch creates a **new `child_process.fork`'d process**, set to `cwd: context.github.workspace` so a node action's bare relative `fs` paths (e.g. `fs.readFileSync('./file.txt')`) resolve against the run's workspace, matching the real GitHub Actions runner — see [node-sandbox-cwd-fidelity.md](../sessions/node-sandbox-cwd-fidelity.md) for why this requires a real child process rather than a `worker_threads.Worker` (`process.chdir()` is disallowed inside worker threads, and overriding `process.cwd` does not affect `fs`'s native relative-path resolution).

The bootstrap file MUST be `.mjs` (not `.ts`). Node.js evaluates the entry file extension before `--import` hooks in `execArgv` are processed — a `.ts` entry is rejected before `tsx` can register its loader. ([Coverage spike finding.](../spikes/coverage-findings.md))

The forked process MUST set explicit `execArgv: []` (or, if a TypeScript bootstrap is ever reintroduced, `['--import', 'tsx/esm']`). When the outer process runs under `actharness test`, it carries additional `--import` flags (e.g. `--import register.ts`) in its `execArgv`; a forked child inherits these by default. `--import register.ts` fails inside an action sandbox because `register.ts` is not meaningful there. Explicit `execArgv` on the `fork()` call suppresses the inherited chain. ([Coverage spike finding.](../spikes/coverage-findings.md))

Entrypoint, env, and mock data are sent to the child via IPC (`child.send(...)` / `process.on('message', ...)`) immediately after fork, since `child_process.fork` has no `workerData`-equivalent constructor option. Coverage and lifecycle events (`v8coverage`, `done`, `apiHit`, `networkHit`) flow back the same way, via `process.send(...)` in the bootstrap and `child.on('message', ...)` in the host.

### 4. `process.env` isolation

Each forked child receives its own `process.env`, populated from the init IPC message before the action entrypoint is imported. Two concurrent `run()` calls with different `INPUT_*` values MUST NOT bleed into each other. Verified by the parallel test in fixture A.

### 5. Protocol file wiring

Allocate **fresh temp files** for `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, and `GITHUB_STEP_SUMMARY` for **each phase**, via core's `RunnerProtocol`. Pass their absolute paths as env vars on the worker. `@actions/core` reads/writes these paths without any monkey-patching — no other wiring is needed. Read back `$GITHUB_OUTPUT` after each phase; read `$GITHUB_ENV` / `$GITHUB_PATH` and thread them forward to subsequent phases as accumulated env.

### 6. `GITHUB_STATE` threading

After each phase, parse the state file (`$GITHUB_STATE`) and inject the written keys as `STATE_<KEY>` env vars into the next phase's worker env. The state file itself is NOT passed to the next worker directly — it is read and re-injected as individual vars, matching the real runner's behavior.

### 7. Output merging

Outputs written to `$GITHUB_OUTPUT` by **any** phase (pre, main, or post) are merged into `RunResult.outputs`. Later-phase outputs overwrite earlier-phase outputs with the same key — last write wins, matching the runner.

### 8. `process.exit` trap

In the sandbox bootstrap, override `process.exit` **before** the action entrypoint is imported. The override MUST throw a `SandboxExitSignal` (a tagged `Error` subclass) with the exit code. Since the bootstrap now runs in its own `child_process` (not a thread sharing the host process), an unguarded `process.exit()` from the action would no longer kill the test runner — but the trap is still required so coverage can be collected and reported via the `beforeExit` handler before the process actually exits; a real `process.exit()` call would skip `beforeExit` and lose the coverage data.

Caveat (design gap §1 from [node-sandbox-findings.md](../spikes/node-sandbox-findings.md)): an action whose outer `run().catch(err => core.setFailed(err.message))` catches all errors will catch the `SandboxExitSignal` too, call `core.setFailed('SandboxExitSignal')`, and then complete with `process.exitCode = 1`. The run conclusion will still be `'failure'` (correct), but a spurious `::error::SandboxExitSignal` annotation will appear. Filter this: in the bootstrap's `catch` handler, check `err instanceof SandboxExitSignal` before passing to `setFailed`.

### 9. Octokit interception (`mockGitHubApi`)

Mount an undici `MockAgent` into the worker for Octokit interception. Resolve `undici` from the **action's own `node_modules`**, not from the sandbox's:

```ts
const undiciPath = require.resolve('undici', { paths: [actionDir] });
const { MockAgent, setGlobalDispatcher } = require(undiciPath);
```

This ensures `setGlobalDispatcher` patches the same undici instance that `@actions/github` will use. If `require.resolve('undici', { paths: [actionDir] })` fails (the action is ncc-bundled and embeds undici), fall back to patching `globalThis.fetch` instead — ncc-bundled actions that embed undici still ultimately call `fetch` for HTTP.

`GitHubApiRoutes` accepts Octokit REST-style route strings (`'GET /repos/{owner}/{repo}'`) mapping to static response objects or functions `(params) => responseBody`. The `NetworkMock` returned by `mockGitHubApi` records calls and exposes `calls`/`called`/`callCount`.

### 10. Arbitrary network interception (`mockNetwork`)

`NetworkMatcher` is a URL pattern (string, `RegExp`, or predicate `(url: string) => boolean`) with an optional response factory. Wired into the worker via the same undici `MockAgent` / `globalThis.fetch` intercept layer as `mockGitHubApi`. Multiple `mockNetwork` registrations accumulate; first-match wins.

### 11. CJS and ncc-bundled entrypoints

Load the entrypoint via `await import(entryPath)` inside the worker. For ncc-bundled actions (webpack runtime, `__nccwpck_require__`), `await import()` handles the bundle correctly — bundled `require()` calls resolve against the bundle, not the project's `node_modules`. No special handling is needed beyond the undici fallback in §9.

### 12. ESM entrypoints

`await import()` in the worker bootstrap handles `.mjs` and `"type": "module"` packages natively. No transpilation is needed. The ESM fixture (fixture E) must pass before v0.2 ships — this is the explicit "step 1" called out in [specs/versions/v0.2.md](../versions/v0.2.md#spike-status).

### 13. `stdout` / `stderr` capture

Capture `stdout` / `stderr` per phase via the forked child's `stdout` / `stderr` streams (set `stdio: ['ignore', 'pipe', 'pipe', 'ipc']` on the `fork()` call). Parse workflow commands (`::error::`, `::warning::`, `::notice::`, `::add-mask::`, `::set-output::`, etc.) from the captured stdout stream. `add-mask` values MUST be redacted in all subsequent captured output — including later phases and sibling sandbox processes in the same run.

### 14. jsLines coverage

If coverage is active (detected via the run sink / `registerRunListener` presence), collect V8 line coverage from the sandbox child using Node's **inspector API**:

1. `import { Session } from 'node:inspector'` in the bootstrap.
2. Enable `Profiler.startPreciseCoverage({ callCount: true, detailed: true })` before the action entrypoint is imported.
3. After the action completes (or throws), call `Profiler.takePreciseCoverage()`.
4. Send the coverage result back to the host via `process.send({ type: 'v8coverage', data: ... })`.

`inspector.Session`-based precise coverage works the same inside a plain `child_process` as it did inside a `worker_threads.Worker` — verified directly when this module switched from worker threads to `child_process.fork` for cwd fidelity (see [node-sandbox-cwd-fidelity.md](../sessions/node-sandbox-cwd-fidelity.md)).

`NODE_V8_COVERAGE` MUST NOT be used for this — it fires on process exit only and does not give per-run, per-phase isolation suitable for this harness's lifecycle.

On the host, convert the V8 coverage result to Istanbul format using `v8-to-istanbul`, filter to only the action's source files (excluding bootstrap and `node_modules`), and pass to `@actharness/coverage`'s run sink. For ncc-bundled actions, apply source maps (`--source-map` from ncc) if available; without source maps, report coverage against the bundle file.

## Acceptance

Fixtures under `packages/node/test/fixtures/`:

### Fixture A — baseline CJS (`fixtures/baseline/`)

`using: node20`, CJS entrypoint, `@actions/core` only (`getInput`, `setOutput`, `setFailed`). No bundling, no Octokit, no lifecycle.

- `setOutput` → `result.outputs` populated; `result` has `conclusion: 'success'`.
- `setFailed('message')` → `result` has `conclusion: 'failure'`; `result.annotations` contains a `level: 'error'` entry; test runner survives (H5).
- Two concurrent `run()` calls with different inputs → outputs never cross-contaminate (H1, H2).

### Fixture B — ncc-bundled (`fixtures/bundled/`)

`using: node20`, single-file ncc bundle (`dist/index.js`, webpack runtime, `__nccwpck_require__`). Reads an input; sets an output.

- Runs and succeeds; output matches (H4).
- No `node_modules` resolution errors.

### Fixture C — Octokit caller (`fixtures/octokit/`)

`using: node20`, CJS, calls `@actions/github` Octokit (at least one `GET` request).

- `actharness.mockGitHubApi({ 'GET /repos/{owner}/{repo}/pulls': () => ({ data: [{ number: 42 }] }) })` → action reads the mock response; `result.outputs.pr_count === '1'` (H6).
- Without `mockGitHubApi`, the real network is blocked (undici `MockAgent` in `throwIfNotMatched` mode) → `result` has `conclusion: 'failure'`.

### Fixture D — pre/main/post lifecycle (`fixtures/lifecycle/`)

`using: node20`, CJS, explicit `pre:` and `post:` entries. `pre:` uses `core.saveState('key', 'value')`; `post:` reads it via `process.env.STATE_KEY` and emits it as an output.

- `result.steps` contains three `StepResult`s with `phase: 'pre'`, `'main'`, `'post'` in that order (H7).
- All three have `conclusion: 'success'`.
- `result.step` with phase `'post'` has `outputs.key === 'value'` — state threaded correctly.
- `RunResult.outputs` merges outputs from all phases that wrote them.

### Fixture E — ESM entrypoint (`fixtures/esm/`)

`using: node20`, `"type": "module"` package with a `.js` entrypoint (or a `.mjs` entrypoint). Reads an input; sets an output; uses top-level `await`.

- Runs and succeeds; output matches (H3 — the confirmed-but-untested gap from the spike, closed here).

### Secret masking

An action that calls `core.setSecret('super-secret')` followed by `core.info('my super-secret token')` → `result.step('main').stdout` does NOT contain `super-secret`; the masked value appears as `***`.

Also: `result.annotations` MUST NOT contain the literal secret value in any annotation `message` — including annotations produced by `core.setFailed`.

### JS coverage (integration)

With coverage active, a run against fixture A produces a V8 coverage fragment that:

- contains statement, branch, function, and line hit data for the action's entrypoint file,
- does NOT contain data for the worker bootstrap or any `node_modules` file,
- converts to an Istanbul-compatible map populating `jsStatements`, `jsBranches`, `jsFunctions`, and `jsLines` on `FileCoverage` (accept `v8-to-istanbul` output without error).

## Done-when

All five fixture scenarios + masking + JS coverage fragment (statements/branches/functions/lines) green; executor registers cleanly into core; `mockGitHubApi` and `mockNetwork` wired on `actharnessFn`; `GitHubApiRoutes`, `NetworkMatcher`, `NetworkMock` added to `@actharness/types`; sandbox bootstrap is `.mjs` with explicit `execArgv`; deps limited to `core` + `types`; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
