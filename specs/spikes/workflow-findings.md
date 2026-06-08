# Spike findings — workflow orchestration

> **Gate: 30/30 tests pass. All 7 hypotheses confirmed. Two v0.1-blocking type changes identified.**
> Implementation: `spike/workflow/`. Run: `cd spike/workflow && npm test`.

---

## H1–H7 verdict

| # | Hypothesis | Result | Notes |
| --- | --- | --- | --- |
| H1 | `StepRunner` reuse is real | ✅ | `WorkflowRunner` calls `runComposite` per job unchanged; no `StepRunner` interface modification needed |
| H2 | `ContextStore` handles `needs` via extension | ✅ | `needsCtx` is an optional parameter to `buildContexts`; no interface shape change; steps read `needs.*` correctly |
| H3 | `JobResult extends RunResult` is structurally correct | ⚠️ | **Works with a required fix** — see blocking finding #1 below |
| H4 | `WorkflowResult` composes with existing matchers | ✅ | `toHaveRunJob` + `toHaveRunStep` + `toHaveOutput` all used on the same result in one test without friction |
| H5 | `actspecWorkflow()` is a pure add | ✅ | `src/index.ts` only imports workflow-specific modules; zero changes to `composite.ts`, `context.ts`, `mock.ts`, `protocol.ts` |
| H6 | `needs:` DAG + matrix in the current shape | ✅ | Matrix expansion, fail-fast cancellation, and job outputs all fit the `WorkflowResult`/`JobResult` shape from API.md §10 — with the type fix from H3 applied |
| H7 | `wouldTrigger` is standalone | ✅ | Reuses expression evaluator from `@actspec/expressions` unchanged; no new evaluator APIs needed; 9/9 wouldTrigger tests green |

---

## Friction log

| # | Probe | What was wanted | What the implementation revealed | Classification |
| --- | --- | --- | --- | --- |
| 1 | Skipped job access | `result.job('on-failure')` returns a job with `conclusion: 'skipped'` | Works — but requires the H3 type fix. Without `Omit<RunResult, 'conclusion'>`, TypeScript would reject `conclusion: 'skipped'` as invalid. | **type change needed (v0.1-blocking)** |
| 2 | Matrix job identity | Access `test (node=20)` via `result.job('test')` | `job(id)` returns the first instance only. Two instances have the same `id`. Must filter `result.jobs` manually: `result.jobs.find(j => j.id === 'test' && j.matrix?.node === 20)` | **design gap** — see finding #2 |
| 3 | Cancelled via fail-fast | `result.job('test').conclusion === 'cancelled'` | Works — after the H3 type fix. The cancelled instance has `conclusion: 'cancelled'` and `outcome: 'cancelled'`. The new `toHaveJobCancelled` matcher checks all instances via `result.jobs.filter(j => j.id === id)` | type change needed (v0.1-blocking, resolved by same fix as #1) |
| 4 | `needs.<id>.outputs.*` in expression | Step sees correct value | ✅ No friction. `needsCtx` threads correctly into `buildContexts`; `${{ needs.build.outputs.artifact }}` evaluates to the upstream value | no change needed |
| 5 | Output threading step → env | Shell step receives the correct value | ✅ No friction. Confirmed via `step.stdout.toContain('app.tgz')` | no change needed |
| 6 | `wouldTrigger` with no `changedFiles` | Conservative: not triggered | Implemented as: when `paths:` filter present and `changedFiles` is absent, return `triggered: false` with reason. Needs spec to document this default. | **docs clarification** |
| 7 | `mockJob` assertion on calls | `expect(mockBuild).toHaveBeenCalledWith(...)` | `mockJob` returns `void`, not a spy. By design — a job has no `with:` block. Assertion is indirect: inspect downstream step outputs that use `needs.<id>.outputs.*`. | no change needed (by design) |
| 8 | Single-job run | `wf.run({ job: 'release' })` | Not implemented in this spike. Full graph always runs. `WorkflowRunInput.job` field is in the spec; implementation is straightforward (filter topo sort to ancestors + target). | **design gap (not v0.1-blocking)** |
| 9 | v0.1 step matchers on `JobResult` | `toHaveRunStep`, `toHaveOutput`, `toHaveSucceeded` work without casting | ✅ No friction. The `isRunResult` guard checks `'conclusion' in v && 'steps' in v && 'outputs' in v` — `JobResult` satisfies all three. | no change needed |
| 10 | `wouldTrigger` per-job `if:` | Returns per-job ids considering job `if:` conditions | Not implemented. Returns all job ids when triggered. Per-job `if:` evaluation on trigger requires `needs` context which isn't meaningful at trigger time. | **docs clarification** — `jobs` in `TriggerResult` means "defined jobs", not "jobs whose if: would pass" |

---

## Finding #1 — v0.1-blocking type change: `JobResult.conclusion`

**Problem.** `RunResult.conclusion` is typed `'success' | 'failure'`. `JobResult` needs `'success' | 'failure' | 'skipped' | 'cancelled'` (skipped when `if:` is false or needs failed; cancelled when fail-fast fires). TypeScript does not allow widening an inherited property through `extends`, so `interface JobResult extends RunResult { conclusion: '...' | 'skipped' | 'cancelled' }` is a type error.

**Fix.** Use `Omit<RunResult, 'conclusion'>` in `JobResult`:

```ts
// API.md §10 — update this definition
export interface JobResult extends Omit<RunResult, 'conclusion'> {
  conclusion: 'success' | 'failure' | 'skipped' | 'cancelled';
  id: string;
  outputs: Record<string, string>;
  matrix?: Record<string, unknown>;
  needs: string[];
  outcome: 'success' | 'failure' | 'skipped' | 'cancelled';
}
```

`RunResult.conclusion` stays `'success' | 'failure'` — action results never have skipped/cancelled. Only job results do.

**Impact.** Change to [API.md §4 and §10](../../docs/API.md) and [specs/modules/core.md](../modules/core.md) before v0.1 ships. The `isRunResult` type guard in matchers is unaffected (it checks structural presence of fields, not the exact `conclusion` union). `toHaveSucceeded` and `toHaveFailed` also remain correct for action results; only `toHaveRunJob`/`toHaveSkippedJob`/`toHaveJobCancelled` need to be aware of the wider `conclusion`.

**Priority.** v0.1-blocking.

---

## Finding #2 — design gap: matrix job identity in `WorkflowResult`

**Problem.** `result.job(id)` is defined as returning a single `JobResult | undefined`. For matrix jobs, multiple instances share the same `id`. `job('test')` returns only the first — there is no API to access a specific matrix instance directly.

**Workaround (in tests).** Filter `result.jobs` manually:

```ts
const node20 = result.jobs.find(j => j.id === 'test' && j.matrix?.node === 20);
```

**Proposed resolution.** Add an overload or a second accessor to `WorkflowResult`:

```ts
// Option A: overload job() to accept a matrix filter
job(id: string, matrix?: Record<string, unknown>): JobResult | undefined;

// Option B: separate accessor
matrixJob(id: string, matrix: Record<string, unknown>): JobResult | undefined;
```

Option A is less surface; Option B is more explicit. Either way, `job(id)` with no matrix arg keeps returning the first instance (backwards-compatible).

**Priority.** v0.4-only — not needed for v0.1. Add to [API.md §10](../../docs/API.md) and [specs/modules/workflow.md](../modules/workflow.md) when v0.4 is scheduled.

---

## Finding #3 — docs clarification: `wouldTrigger` with `paths:` and no `changedFiles`

**Behavior.** When `paths:` filter is present and `TriggerInput.changedFiles` is omitted, `wouldTrigger` returns `triggered: false` with `reason: 'paths filter requires changedFiles to be provided'`.

**Rationale.** The conservative choice: if we cannot evaluate the filter, we say it doesn't match. The alternative (always trigger when files are unknown) would produce false positives. Document this in [API.md §10](../../docs/API.md) under `TriggerInput.changedFiles`.

**Priority.** docs clarification (not a type or API change).

---

## Finding #4 — docs clarification: `TriggerResult.jobs` meaning

`TriggerResult.jobs` lists all job ids defined in the workflow when triggered. It does not evaluate per-job `if:` conditions, because those conditions typically reference `needs` context which is meaningless without a prior run. Document this in [API.md §10](../../docs/API.md).

---

## `ContextStore` extensibility assessment (H2)

The v0.1 `buildContexts(input, inputValues, stepsCtx, envCtx, jobStatus, needsCtx?)` signature already has `needsCtx` as an optional parameter. The workflow runner passes it per-job without changing the function signature. Adding `matrixCtx` (for the `matrix` expression context in job steps) also required no interface change — it's a second optional parameter.

**Verdict.** `ContextStore` is extensible for v0.4 without a v0.1 interface change.

---

## `needs:` threading assessment (H2, H5)

Per-job needs threading is entirely in `WorkflowRunner`. The pattern:

1. Complete job A → store `{ conclusion, outputs }` in `jobAggregates`.
2. Before running job B, build `needsCtx` from `jobAggregates` for B's declared needs.
3. Pass `needsCtx` into `runComposite` → expressions like `${{ needs.A.outputs.artifact }}` resolve correctly.

**For matrix jobs:** the aggregate conclusion is `failure` if any instance failed; `outputs` come from the last successful instance (or last instance). This is a simplification — the real runner's behavior for `needs.<matrix-job>.outputs` is undefined when multiple instances exist. Document as a known simplification.

---

## `wouldTrigger` dependencies (H7)

`wouldTrigger` uses:

- `@actspec/expressions` `evaluate()` — only for job-level `if:` (not implemented in this spike; trigger evaluation at the workflow level doesn't need it).
- Pattern matching on `on:` YAML structure — self-contained in `workflow.ts`.
- No new `@actspec/core` exports needed.

**Verdict.** Standalone. No new expression engine APIs. No new core interfaces.

---

## Proposed changes (priority table)

| Change | Affected spec | Why | Priority |
| --- | --- | --- | --- |
| `JobResult extends Omit<RunResult, 'conclusion'>` with explicit `conclusion: '...' \| 'skipped' \| 'cancelled'` | [API.md §4 + §10](../../docs/API.md), [specs/modules/core.md](../modules/core.md) | TypeScript requires it for skipped/cancelled conclusions | **v0.1-blocking** |
| `toHaveRunJob` must check `conclusion !== 'skipped' && conclusion !== 'cancelled'` (not just `!== 'skipped'`) | [specs/modules/matchers.md](../modules/matchers.md) | `JobResult.conclusion` includes `'cancelled'` (fail-fast); a single `!== 'skipped'` check would wrongly pass for cancelled jobs | **v0.1-blocking** |
| Document `TriggerInput.changedFiles` default behavior for `paths:` filter | [API.md §10](../../docs/API.md) | Clarify conservative default | docs clarification |
| Document `TriggerResult.jobs` meaning (all jobs, not if:-filtered) | [API.md §10](../../docs/API.md) | Avoid confusion | docs clarification |
| Add `job(id, matrix?)` overload or `matrixJob(id, matrix)` to `WorkflowResult` | [API.md §10](../../docs/API.md), [specs/modules/workflow.md](../modules/workflow.md) | Matrix instance disambiguation | v0.4-only |
| Implement `WorkflowRunInput.job` (single-job run limiting) | [specs/modules/workflow.md](../modules/workflow.md) | Useful for targeted job testing | v0.4-only |
| Document `needs.<matrix-job>.outputs` aggregation behavior | [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) | Multiple instances → which outputs? | v0.4-only |

---

## References

- [specs/spikes/workflow.md](workflow.md) — the spike spec
- [docs/API.md §4 + §10](../../docs/API.md) — types affected by finding #1
- [specs/versions/v0.4.md](../versions/v0.4.md) — the version this spike de-risks
- [specs/spikes/api-ergonomics-findings.md](api-ergonomics-findings.md) — prior spike that confirmed H7 at high level
