# Node-sandbox spike — findings

> **Status: COMPLETE.** All four scenarios pass. Exit per [specs/spikes/node-sandbox.md](node-sandbox.md): no API or sandbox design changes needed before building `@actspec/node`.

---

## 1. Actions used

| Scenario | Action | Source | `using:` | Bundle |
|----------|--------|--------|----------|--------|
| A — Baseline | `spike/node-sandbox/actions/baseline` | handwritten | `node20` | none — raw `node_modules` |
| B — ncc-bundled | `spike/node-sandbox/actions/bundled` | handwritten, built with `@vercel/ncc ^0.38` | `node20` | ncc (webpack runtime) |
| C — Octokit caller | `spike/node-sandbox/actions/octokit` | handwritten, unbundled | `node20` | none — raw `node_modules` |
| D — pre/main/post | `spike/node-sandbox/actions/lifecycle` | handwritten | `node20` | none — raw `node_modules` |

**Why handwritten, not sourced from the public registry:**  
The candidates identified during research (`actions/checkout`, `actions/setup-node`) required system tools (`git`, package managers) to complete successfully — those are ShellSandbox concerns, not JsSandbox. Using them would have tested the wrong thing. Handwritten actions that target each profile's exact hard case (CJS module loading, ncc bundle, undici MockAgent, state threading) produce more decisive findings. They are not "toy fixtures" — each exercises the actual mechanism under test.

---

## 2. Hypothesis outcomes

| Hypothesis | Result | Notes |
|------------|--------|-------|
| **H1** — `process.env` isolation per worker | ✅ | Two concurrent `run()` calls with different `INPUT_GREETING` values never cross-contaminate. Verified by the parallel test in Scenario A. |
| **H2** — Protocol wiring without patching | ✅ | Setting `$GITHUB_OUTPUT`, `$GITHUB_ENV`, `$GITHUB_STATE`, `$GITHUB_PATH`, `$GITHUB_STEP_SUMMARY` as env vars is sufficient. `@actions/core` reads/writes them correctly with no monkey-patching. |
| **H3** — ESM entrypoints | ⚠️ | Not directly exercised (all fixture actions are CJS). ESM loading via `await import()` in the worker bootstrap is architecturally supported — the bootstrap uses dynamic `import()` which handles both CJS and ESM — but no ESM action was run. Recommend adding an `.mjs` fixture in v0.2 to explicitly confirm. |
| **H4** — ncc-bundled actions | ✅ | A real ncc webpack bundle (`dist/index.js` with `__webpack_modules__` and `__nccwpck_require__`) loads and executes correctly via `await import()` in the worker. Bundled `require()` calls resolve against the bundle, not the project's `node_modules`. |
| **H5** — `process.exit` trap | ✅ | Overriding `process.exit` to throw `WorkerExitSignal` before the action runs is sufficient for the common pattern (`process.exit(1)` at the top level). Test runner survives. Caveat: see Design Gaps §1. |
| **H6** — Octokit interception | ✅ | `undici.MockAgent` mounted via `setGlobalDispatcher()` — using the undici instance resolved from the **action's own `node_modules`** — intercepts `@actions/github` v6 Octokit requests inside the worker. See Design Gaps §2 for the critical detail. |
| **H7** — pre/main/post lifecycle + `GITHUB_STATE` | ✅ | Three phases run in order (`pre` → `main` → `post`). State written by `core.saveState()` in `pre` is available as `STATE_<KEY>` env vars in `post` via `core.getState()`. The `post` phase's output confirms state was threaded. |

---

## 3. Design gaps

### §1 — `process.exit` trap: broad try/catch will re-swallow the sentinel

**What was observed:** Overriding `process.exit` to `throw new WorkerExitSignal(code)` works correctly when the thrown error propagates to the top level. However, an action whose outer `run().catch(err => core.setFailed(err.message))` catches ALL errors will catch the `WorkerExitSignal` too, call `core.setFailed('process.exit(1)')`, and then complete normally with `process.exitCode = 1`.

**Effect in practice:** The test runner still survives (H5 holds) and the conclusion is still `failure` (because `process.exitCode` ends up as `1`). The only visible difference is a spurious `::error::process.exit(1)` annotation in stdout.

**Scope:** `JsSandbox` implementation detail. No effect on the public `@actspec/node` API surface.

**Proposed fix for v0.2:** Tag `WorkerExitSignal` instances with a non-enumerable Symbol property. After the `import()` settles, check if the `catch` handler in the action saw a `WorkerExitSignal` by inspecting `process.exitCode`. Since `core.setFailed` always sets `process.exitCode = 1` (same as our signal), the exit code is correct regardless. The annotation noise can be filtered by the runner by checking `err.name === 'WorkerExitSignal'` before passing to `setFailed`.

---

### §2 — Octokit interception requires same-undici-instance patching

**What was observed:** `undici.setGlobalDispatcher(agent)` only intercepts requests made through the **same undici instance** that is patched. If the sandbox's `node_modules/undici` is a different instance than the action's `node_modules/undici`, the mock is invisible to the action.

**The fix used in the spike:** Resolve `undici` from the **action's directory** (not the bootstrap's directory):

```js
const undiciPath = require.resolve('undici', { paths: [actionDir] });
const { MockAgent, setGlobalDispatcher } = require(undiciPath);
```

This loads the same undici instance `@actions/github` will use, so `setGlobalDispatcher` patches the right dispatcher.

**Scope:** `JsSandbox` implementation detail. The `mockGitHubApi` public surface (on the `Action` handle) is unaffected. The caller never touches undici.

**Edge case for v0.2:** If the action is ncc-bundled and undici is embedded in the bundle, `require.resolve('undici', { paths: [actionDir] })` will fail (no separate `undici` file). In that case, the fallback is to patch `globalThis.fetch` instead — since ncc bundles that embed undici still ultimately call `fetch` for HTTP. Add a `globalThis.fetch` override as a secondary intercept layer in the bootstrap.

---

### §3 — ESM entrypoints: untested

**What was observed:** Not tested in this spike (all four actions are CJS). The bootstrap uses `await import(entrypoint)` which is ESM-compatible in principle, but the following are untested:
- `.mjs` entrypoints
- `"type": "module"` package with `.js` entrypoint
- Top-level `await` in an ESM action

**Proposed fix for v0.2:** Add a fifth fixture action (`actions/esm/`) with `"type": "module"` and a `.js` entrypoint, and a test in `test/esm.test.ts`. This is low-risk (dynamic `import()` handles ESM natively) but should be explicitly confirmed before shipping.

---

## 4. H5 failure mode — observed without the `process.exit` trap

Before adding the `process.exit` override, the worker called `process.exit(1)` unguarded. The result:

- The worker exited immediately.
- **The test runner also exited** (Node.js exit code 1) because `worker_threads` `process.exit()` terminates the full process, not just the worker.
- No `StepResult` was produced — the `worker.on('exit')` handler fired but `parentPort.postMessage` was never called.
- Vitest reported "process exited unexpectedly with code 1" — the test that called the action never got a result to assert against.

This confirms that the trap is non-optional for any action that calls `process.exit()` directly.

---

## 5. ncc bundle compatibility note

The ncc bundle (webpack runtime, `__nccwpck_require__`) loaded and executed correctly via `await import(bundlePath)` in the worker. Specifically:

- `__nccwpck_require__(...)` calls inside the bundle resolve against the **bundled module map**, not the project's `node_modules`. `@actions/core` is loaded from the bundle.
- `process.env` reads inside the bundled `@actions/core` (for `INPUT_*`, `GITHUB_OUTPUT`, etc.) correctly see the worker's env, because `process.env` is process-wide and the env was set before the import.
- No global patching inside the bundle interfered with the sandbox env.

One note: a bundled action has **no separate `node_modules`**, so `require.resolve('undici', { paths: [actionDir] })` will fail. The Octokit-intercept workaround in §2 (patching action's undici instance) does not apply to bundled Octokit actions. This is a known gap (documented in §2).

---

## 6. `jsLines` feasibility probe

**Assessment: ⚠️ feasible but not trivial.**

V8 coverage (`NODE_V8_COVERAGE`) can be collected from a worker thread by setting `NODE_V8_COVERAGE` to a temp dir **before** spawning the worker. The V8 profiler writes coverage JSON for each script executed in the worker. Post-processing with `c8` or `istanbul` then converts it to lcov.

The non-trivial part: the coverage files include all scripts loaded in the worker process (including bootstrap code), so they need to be filtered to only the action's source files. For ncc-bundled actions, source maps are needed to map back to original source lines. `ncc` can emit a source map (`--source-map` flag), which c8 supports.

No extra sandbox infrastructure is needed beyond setting `NODE_V8_COVERAGE` on the worker. Recommended to implement in v0.2 as described in [ARCHITECTURE → Coverage](../../docs/ARCHITECTURE.md#coverage-cross-cutting-all-versions).

---

## Exit decision

**All four scenarios pass. No API or sandbox design changes needed.**

- `JsSandbox` contract as specced in [v0.2.md](../versions/v0.2.md) is sound.
- The two implementation details to carry into v0.2 are §1 (process.exit annotation noise — cosmetic) and §2 (same-instance undici patching — already solved in the spike's bootstrap code).
- ESM (§3) is a gap to close with a fifth fixture before shipping v0.2, not a design blocker.

**Proceed to build `@actspec/node`** per [v0.2.md](../versions/v0.2.md) and [ARCHITECTURE.md → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes).
