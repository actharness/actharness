# API Ergonomics Spike — Findings

> **Status: COMPLETE.** All 31 tests pass across composite (2 fixtures), node (1 fixture), and workflow (1 fixture) execution types. Exit per [specs/spikes/api-ergonomics.md](api-ergonomics.md): 3 proposed changes — 2 docs clarifications, 1 nice-to-have API addition. No v0.1-blocking friction found.

---

## 1. Test inventory

| Test file | Fixture | Type | Matchers used | Friction |
|-----------|---------|------|---------------|---------|
| composite-setup.test.ts | setup/ | composite | `toHaveSucceeded`, `toHaveOutput`, `toHaveBeenCalledWith`, `toHaveBeenCalledTimes`, `toHaveRunStep` | ⚠️ probe #3 (stdout) |
| composite-deploy.test.ts | deploy/ | composite | `toHaveSucceeded`, `toHaveSkippedStep`, `toHaveRunStep`, `toHaveStepConclusion`, `toHaveOutput` | ⚠️ probe #5 (outcome) |
| node-tagger.test.ts | tagger/ | node | `toHaveSucceeded`, `toHaveOutput`, `toHaveBeenCalled` | ⚠️ probe #6 (pre: phase) |
| workflow-release.test.ts | release.yml | workflow | `toHaveRunJob`, `toHaveJobConclusion`, `toHaveJobOutput`, `toHaveRunStep`, `toHaveStepConclusion`, `toHaveStepOutput` | none |

**Total: 31 tests across 4 fixtures and 3 execution types.** All green.

---

## 2. Friction log

### Probe #3 — Assert that a `run:` step's stdout contains a string

**What was wanted:** `expect(result).toHaveStepStdout('verify', /Node .* ready/)` — a dedicated matcher.

**What the API gave:** `result.step('verify')!.stdout` — accessible via the raw `StepResult`, but no matcher shorthand.

**Classification:** `docs clarification` — `result.step(id)!.stdout` is a natural and readable one-liner. The friction is mild: you reach into the result once rather than using a matcher. No workaround needed. The step is accessible and the value is correct. A `toHaveStepStdout` matcher would reduce boilerplate but is not blocking.

---

### Probe #5 — Test a `continue-on-error` step (outcome vs conclusion)

**What was wanted:** `expect(result).toHaveStepOutcome('lint', 'failure')` — a matcher for the raw `outcome` before `continue-on-error` is applied.

**What the API gave:** `toHaveStepConclusion` exists for `conclusion`; `outcome` must be accessed via `result.step('lint')!.outcome`.

**Classification:** `docs clarification` — `outcome` and `conclusion` are both exposed on `StepResult`. The distinction is the important design choice (D3 models it explicitly). The friction is that `toHaveStepConclusion` only covers `conclusion`. Accessing `outcome` directly is readable: `expect(lint!.outcome).toBe('failure')`. A `toHaveStepOutcome` matcher would complete the pair but is not blocking.

---

### Probe #6 — Assert on a `pre:` phase result

**What was wanted:** `expect(result).toHavePhaseConclusion('pre', 'success')` — a matcher for phase-specific step results.

**What the API gave:** `result.steps.find(s => s.phase === 'pre')` — must filter by phase manually, then assert on the returned `StepResult`.

**Classification:** `docs clarification` — the `phase` discriminator is there and works correctly (D33 holds). The filter pattern is readable and not surprising once you know `phase` is on `StepResult`. In practice, most tests only need to know that the main phase succeeded; `pre`/`post` assertions are rare enough that a dedicated matcher is a nice-to-have, not a gap.

---

### Implementation finding — `needs:` context must thread through all step execution paths

**What was observed:** The workflow runner's `needsCtx` (built from upstream job outputs) was passed to `runComposite` but not threaded into the per-step `buildContexts` calls inside `execShellStep` and `execUsesStep`. Steps whose `run:` scripts referenced `${{ needs.<id>.outputs.<key> }}` received an empty string because those functions rebuilt the context without `needs`.

**Root cause:** The `StepCtx` interface did not carry `needsCtx`, so the per-step context was always built without it.

**Fix applied:** Added `needsCtx` to `StepCtx` and `UsesStepCtx`; threaded it from `runComposite` into both `execShellStep` and `execUsesStep`.

**API impact:** None — this is a pure implementation bug in the spike. The API surface (inputs, context keys, expression syntax) matched what API.md specifies. The `needs` context key was correct; only the wiring was wrong initially.

**Classification:** `no change needed (misread)` — not a design gap, a wiring omission during initial implementation.

---

## 3. Proposed changes

| Change | API.md section | Current text | Proposed text | Priority |
|--------|---------------|--------------|---------------|---------|
| Add `toHaveStepStdout` matcher | §6 Matchers | *(absent)* | `expect(result).toHaveStepStdout('id', /pattern/)` — asserts the step's captured stdout matches a string or regex | nice-to-have |
| Add `toHaveStepOutcome` matcher | §6 Matchers | *(absent)* | `expect(result).toHaveStepOutcome('id', 'failure')` — asserts the raw outcome before `continue-on-error` is applied, completing the pair with `toHaveStepConclusion` | nice-to-have |
| Clarify `pre`/`post` phase assertion pattern | §4 Run result | "Filter with `result.steps.filter(s => s.phase === 'post')`." | Add a worked example showing the filter + assertion idiom so it is not surprising on first encounter. Clarify that this is the intended path, not a gap. | docs clarification |

No v0.1-blocking changes. All three items are additive.

---

## 4. H1–H7 verdict

| Hypothesis | Verdict | Evidence |
|------------|---------|---------|
| **H1 — No type knowledge required for `mock()`** | ✅ | `action.mock('actions/cache@v3', ...)` and `workflow.mock('actions/checkout@v4', ...)` use identical call shapes regardless of whether the child is composite or node. The `type:` parameter does not exist and was never needed. Smoke-tested in both `composite-setup` and `node-tagger`. |
| **H2 — `RunResult` is type-agnostic** | ✅ | A node action's `$GITHUB_OUTPUT` writes arrive in `result.outputs` identically to a composite action's `outputs.<name>.value` expressions. `result.steps`, `result.conclusion`, `result.env` are consistent in shape across both types. |
| **H3 — Matchers cover the real test vocabulary** | ✅ (with 2 gaps) | `toHaveSucceeded`, `toHaveFailed`, `toHaveRunStep`, `toHaveSkippedStep`, `toHaveStepConclusion`, `toHaveOutput`, `toHaveStepOutput`, `toHaveBeenCalled`, `toHaveBeenCalledWith`, `toHaveBeenCalledTimes` covered every assertion in the composite and workflow tests. Two gaps found: `toHaveStepStdout` (probe #3) and `toHaveStepOutcome` (probe #5) — both nice-to-have, not blocking. |
| **H4 — Mixed-type composites feel natural** | ✅ | The `setup/` fixture uses two remote child actions (cache + setup-node). Mocking both required no type awareness — identical `action.mock(ref, { outputs })` call for each. The composite runs them, evaluates their outputs in `steps.<id>.outputs`, and propagates them to the action's own `outputs`. Zero type-specific ceremony observed. |
| **H5 — `mockShellCommand` + `mockGitHubApi` share the mental model** | ✅ | `mockGitHubApi` and `mock()` in the same test file feel coherent. The mental model is "mock your dependency" for both — `mock()` for `uses:` deps, `mockGitHubApi()` for internal Octokit calls. The distinction is honest (different dependency kinds) rather than arbitrary. No confusion observed. |
| **H6 — pre/main/post assertions are natural** | ⚠️ | The three phases produce three `StepResult`s with correct `phase` discriminators. State threading (`GITHUB_STATE`) works. The assertion pattern `result.steps.find(s => s.phase === 'pre')` is readable but not as terse as a dedicated matcher would be. No dedicated `toHavePhaseConclusion` matcher. The pattern works; the friction is mild (see probe #6). |
| **H7 — Workflow matchers are additive** | ✅ | `toHaveRunJob`, `toHaveJobConclusion`, `toHaveJobOutput` feel like the action matchers one level up. `result.job(id)` is a `JobResult extends RunResult`, so all step/output matchers apply directly to job results — `expect(result.job('build')).toHaveStepConclusion('compile', 'success')` works identically to the action-level equivalent. No ergonomic difference observed. |

---

## 5. API.md diff — no v0.1-blocking changes

All proposed changes are additive (new matchers) or clarifications (existing prose). No existing API surface changes. API.md requires no modification before building `@actspec/matchers`.

The two nice-to-have matchers (`toHaveStepStdout`, `toHaveStepOutcome`) should be added to [specs/modules/matchers.md](../modules/matchers.md) and [API.md §6](../../docs/API.md) before `@actspec/matchers` is published, to make the set feel complete.

---

## Exit decision

**No blocking friction found.** The spike's executors and test files are promoted as the starting point for the main codebase (`spike/api-ergonomics/src/` → `packages/`). API.md is confirmed as-is.

Two matchers to add before shipping `@actspec/matchers`: `toHaveStepStdout` and `toHaveStepOutcome`. Both are additive — existing tests require no changes.

**Important — evolved versions:** the workflow spike (`spike/workflow/`) directly extended this spike. For four files, `spike/workflow/src/` is the more up-to-date starting point and should be used instead:

| File | What changed |
| --- | --- |
| `composite.ts` | Added `matrixCtx` parameter to `runComposite` |
| `context.ts` | Added `matrixCtx` to `buildContexts` / `buildEnvVars` |
| `types.ts` | `JobResult` uses `Omit<RunResult, 'conclusion'>` with wider `conclusion` ([D40](../../docs/DECISIONS.md#d40--jobresult-uses-omitrunresult-conclusion-not-extends-runresult)) |
| `matchers.ts` | `toHaveRunJob` checks `conclusion !== 'skipped' && !== 'cancelled'`; adds `toHaveSkippedJob`, `toHaveJobCancelled` |

`mock.ts`, `protocol.ts`, `parser.ts` are unchanged — either source is equivalent.
