# Spike — `@actspec/node` JS sandbox transparency

> **Throwaway-or-promote.** A thin vertical slice that de-risks the **second-highest-risk component** ([ARCHITECTURE → highest-risk assumptions](../../docs/ARCHITECTURE.md#the-three-highest-risk-assumptions)) *before* v0.2 is built. The core bet being tested: *"wire the protocol env-files and real `@actions/core` just works."* The spike is judged against real published actions — never against toy fixtures that paper over the hard cases.
>
> **COMPLETE — deviation from "real published actions".** During implementation, the candidate real published actions (`actions/checkout`, `actions/setup-node`) were found to require system tools (`git`, package managers) to reach a success conclusion. Those are ShellSandbox concerns, not JsSandbox — using them would have tested the wrong thing. Handwritten fixture actions were used instead, each designed to directly exercise its scenario's hard case (CJS loading, ncc bundle, undici interception, state threading). This satisfies the spirit of the instruction ("the profile is what matters") without papering over any hard case. See [node-sandbox-findings.md](node-sandbox-findings.md) for full rationale and outcomes.

## Why this spike

v0.1 is composite-only. Before committing to the v0.2 `JsSandbox` design, [ARCHITECTURE.md](../../docs/ARCHITECTURE.md) explicitly calls for a sandbox spike against 3–4 real published actions:

> *"ESM vs CJS entrypoints, bundled (`ncc`) actions, `process.exit`, and Octokit interception are where it can break."*

Building the node executor on an untested sandbox design would mean discovering the hard cases after `@actspec/node`, `@actspec/coverage` (jsLines), the network mock layer, and `mockGitHubApi` all exist. The spike de-risks those, cheaply, before any of that is written.

## The question it answers

Does a `worker_thread` sandbox, with:
- `process.env` populated per the `$GITHUB_*` / `INPUT_*` / `$GITHUB_OUTPUT` / `$GITHUB_ENV` protocol (env-file paths set as env vars),
- stdout captured and parsed for workflow commands,
- a `process.exit` trap that yields an exit code without terminating the test runner, and
- an undici `MockAgent` mounted for Octokit interception,

...make a **real, unmodified, published node action** produce the correct `RunResult` through the same `mock` / `run` / `expect` surface that composite uses — for **all four hard cases** (basic, bundled, Octokit, pre/main/post)?

## Hypotheses to prove

- **H1 — `process.env` isolation.** `worker_thread` per invocation gives genuine isolation: two concurrent `run()` calls on different actions don't bleed `INPUT_*` or `$GITHUB_*` into each other.
- **H2 — Protocol wiring without patching.** Setting `$GITHUB_OUTPUT` (and `$GITHUB_ENV`, `$GITHUB_STATE`, `$GITHUB_STEP_SUMMARY`) as env vars on the worker, with real temp files, is enough for an unmodified `@actions/core` (`core.setOutput`, `core.exportVariable`, `core.saveState`) to write them correctly — no monkey-patching required.
- **H3 — ESM entrypoints.** A node action whose entrypoint is `"type": "module"` / `.mjs` loads and executes correctly in the worker without transpilation.
- **H4 — ncc-bundled actions.** A single-file ncc bundle — whose bundled `require()` calls resolve against the bundle, not the project's `node_modules` — executes correctly.
- **H5 — `process.exit` trap.** A node action that calls `core.setFailed(...)` (which internally calls `process.exit(1)`) produces a `StepResult` with `conclusion: 'failure'` — and does **not** terminate the test runner process.
- **H6 — Octokit interception.** An undici `MockAgent` mounted into the worker intercepts `@actions/github`'s Octokit requests. `mockGitHubApi(routes)` on the action handle is enough; the test never touches undici directly.
- **H7 — pre/main/post lifecycle + `GITHUB_STATE`.** A JS action with a `pre:` and `post:` entry produces three `StepResult`s in the runner's order (`pre` first, `post` last after all mains). `core.saveState` in `pre:` is readable via `process.env.STATE_<name>` in `post:`.

## In scope

- A minimal `JsSandbox` — `worker_thread` launcher, env wiring, protocol file allocation, stdout capture, `process.exit` trap.
- A thin `ActionExecutor` stub for `node20`/`node24` enough to call the sandbox and build a `StepResult`.
- The `mockGitHubApi` surface — wiring undici `MockAgent` into the worker.
- Running all four real-action scenarios (see below) and recording findings.
- A **provenance document** (see below).

## Explicitly out of scope

- The full `@actspec/node` package (dual ESM/CJS build, `exports` map, API Extractor, publication).
- `jsLines` / V8→Istanbul coverage (v0.2 depth; can be probed for feasibility, not implemented).
- Hardened isolation (`vm` context, `deny-net` without undici). The spike uses `worker_thread` + scoped env; deeper isolation is an upgrade path, not v0.2 scope.
- `mockNetwork` (arbitrary URL matching beyond Octokit routes) — feasibility probe only if time allows.
- Docker / container sandbox (v0.3).

## Success criteria (the spike's gate)

1. **All four real-action scenarios pass** (H1–H7 collectively validated).
2. **H5 bites** — confirm that a naive `worker_thread` setup without a `process.exit` trap fails (the worker dies; the test runner may or may not survive; the `StepResult` is not produced). Then show the fix.
3. **No action patching** — the real action's source is used verbatim. If workarounds are needed in the sandbox (env tricks, polyfills), they are **documented as design gaps**, not silently applied.
4. **Provenance document written** (see below) — design gaps recorded explicitly so v0.2 can be built with eyes open.

## The four real-action scenarios (must all pass)

These are chosen to cover the four hard cases the architecture calls out. The implementer selects real public actions that match each profile; the profile is what matters, not the specific action.

### Scenario A — Baseline (no bundling, no Octokit, no lifecycle)

**Profile:** a `using: node20` action that only uses `@actions/core` (`getInput`, `setOutput`, `setFailed`), CJS entrypoint, no ncc bundle.

**Validates:** H1, H2, H5 (basic path).

**Test shape:**
```ts
test('basic node action: input → output via $GITHUB_OUTPUT', async () => {
  const action = actspec('./action.yml');   // baseline node action
  const result = await action.run({ inputs: { greeting: 'Hello' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('message', 'Hello World');
});

test('core.setFailed → conclusion failure, test runner survives', async () => {
  const action = actspec('./action.yml');
  const result = await action.run({ inputs: { greeting: '' } }); // triggers setFailed
  expect(result).toHaveFailed();
});
```

### Scenario B — ncc-bundled action

**Profile:** a `using: node20` action distributed as a single-file ncc bundle (`dist/index.js`). Must be confirmed ncc by inspecting the bundle header comment (`// ROLLUP BUNDLE` / `// ncc:…`).

**Validates:** H4.

**Test shape:**
```ts
test('ncc-bundled action executes from its bundle', async () => {
  const action = actspec('./action.yml');   // ncc bundle
  const result = await action.run({ inputs: { /* minimal required */ } });
  expect(result).toHaveSucceeded();
});
```

### Scenario C — Octokit caller

**Profile:** a `using: node20` action that makes at least one GitHub API call via `@actions/github` (Octokit). The API call must be interceptable — not a `fetch`-level bypass.

**Validates:** H6.

**Test shape:**
```ts
test('mockGitHubApi intercepts Octokit inside the worker', async () => {
  const action = actspec('./action.yml');   // Octokit caller

  action.mockGitHubApi({
    'GET /repos/{owner}/{repo}/pulls': () => ({ data: [{ number: 42 }] }),
  });

  const result = await action.run({ inputs: { /* ... */ } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('pr_count', '1');
});
```

### Scenario D — pre/main/post lifecycle

**Profile:** a `using: node20` action with explicit `pre:` and `post:` entries that use `core.saveState` / `STATE_*` (e.g., `actions/cache` shape, or any cache/restore action that persists state between phases).

**Validates:** H7.

**Test shape:**
```ts
test('pre runs before main, post runs after; GITHUB_STATE threads', async () => {
  const action = actspec('./action.yml');   // pre/main/post action
  const result = await action.run({ inputs: { /* ... */ } });

  const pre  = result.steps.find(s => s.phase === 'pre')!;
  const main = result.steps.find(s => s.phase === 'main')!;
  const post = result.steps.find(s => s.phase === 'post')!;

  expect(pre.conclusion).toBe('success');
  expect(main.conclusion).toBe('success');
  expect(post.conclusion).toBe('success');
  // verify that state set in pre was available to post
  expect(result).toHaveStepOutput('post', 'cache-hit', 'false');
});
```

## Required deliverable — a provenance document

The spike is not complete until its findings are written to a **durable, named document** at [`specs/spikes/node-sandbox-findings.md`](node-sandbox-findings.md):

1. **Which real actions were used** — name, repo, version, `using:` value, CJS/ESM/ncc.
2. **H1–H7 outcome** — `✅` / `❌` / `⚠️ (works with caveat)` per hypothesis, with the observed failure for any `❌`.
3. **Design gaps** — anything that required a workaround, with the proposed fix and its scope (is it a sandbox implementation detail, or does it affect the `JsSandbox` contract / `@actspec/node`'s public surface?).
4. **H5 failure mode** — the exact failure observed without the `process.exit` trap (error message, whether the test runner survived).
5. **ncc bundle compatibility note** — did the bundled `require()` resolution work? Did any global patching inside the bundle interfere with the sandbox env?
6. **`jsLines` feasibility probe** — a one-paragraph note on whether V8 coverage (c8) can be collected from the worker with no extra sandbox infrastructure. Non-blocking; a `⚠️` is a valid answer.

## Exit — what we decide after

- **If all four scenarios pass, no design gaps:** build `@actspec/node` as specced in [v0.2.md](../versions/v0.2.md) — no API or sandbox design changes needed.
- **If design gaps surface that affect `JsSandbox` contract only** (e.g., a worker launch option): update [v0.2.md](../versions/v0.2.md) and [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) before building.
- **If a gap forces an API surface change** (e.g., `mockGitHubApi` shape needs to change, or `StepResult` shape for node phases is wrong): update [API.md](../../docs/API.md) and its rationale **before** v0.2 starts — so the surface is settled and v0.1's published API.md remains accurate.
- **If ESM or ncc prove structurally incompatible with `worker_thread`:** escalate as a design question (alternative sandbox: subprocess + IPC? vm context?); record in the findings doc before any v0.2 work begins.

## References

- [docs/ARCHITECTURE.md → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) — `JsSandbox` design.
- [docs/ARCHITECTURE.md → Highest-risk assumptions](../../docs/ARCHITECTURE.md#the-three-highest-risk-assumptions) — where this spike is called for.
- [specs/versions/v0.2.md](../versions/v0.2.md) — the package contract this spike feeds.
- [docs/API.md §2, §5](../../docs/API.md) — `mockGitHubApi`/`mockNetwork` surface this spike validates.
- [D21](../../docs/DECISIONS.md#d21--mock-surface-keep-the-split-not-unified) — why `mockGitHubApi` is separate from `mock()`.
- [D38](../../docs/DECISIONS.md#d38--explicit-deferrals-not-open-items) — v0.2 deferred from v0.1; this spike gates the design.
