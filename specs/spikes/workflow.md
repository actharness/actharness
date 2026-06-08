# Spike — workflow orchestration (`@actspec/workflow`)

> **POC spike — proves that `WorkflowRunner` is genuinely additive.** Implements a minimal `WorkflowRunner` that drives the existing `StepRunner` over a real job DAG, with `needs:` threading, matrix expansion, and `wouldTrigger`. The key question is not "can workflows run" — they can, the architecture is clear — but **"does anything about workflow execution require reshaping the types and interfaces v0.1 will already have shipped?"** If yes, the change is a spec edit now; if not, v0.1 ships with confidence that v0.4 won't break it.

## Why this spike

The architecture's central v0.4 bet ([ARCHITECTURE → Workflow orchestration](../../docs/ARCHITECTURE.md#workflow-orchestration-v0.4)):

> *"`WorkflowRunner` reuses `StepRunner`, `ContextStore`, `RunnerProtocol`, and the mock resolver **unchanged**."*
> *"`JobResult extends RunResult` is the deliberate move — `expect(result.job('build')).toHaveStepOutput(...)` reuses the §6 matchers verbatim."*

Both are reasonable on paper. The risk: if either is wrong, it requires a **breaking change to types that v0.1 will have already published**. `RunResult`, `StepResult`, `ContextStore`, and the matcher signatures are v0.1's public surface. Any change there after publication is a semver major.

There are three specific tensions the architecture acknowledges but doesn't fully resolve:

1. **`ContextStore` extensibility.** v0.1 needs `github`, `env`, `runner`, `steps`, `inputs`, `secrets`, `matrix`. v0.4 needs `needs.<job>.outputs/result`, `jobs`, `strategy`. Is `ContextStore`'s interface already abstract enough to thread in new context keys per job without a shape change — or does supporting `needs` require a new parameter or a structural change that v0.1 didn't anticipate?

2. **`JobResult extends RunResult`.** A job's `steps:` run exactly like a composite's, but a job also has `id`, `matrix`, `needs`, `outcome`/`conclusion` at the job level (not just the step level), and a `cancelled` conclusion composite actions don't have. Does `RunResult` carry these cleanly as an extension — or does adding them require changing the base type (e.g., adding `cancelled` to `conclusion`, or adding `outcome` at the result level)?

3. **`wouldTrigger` dependencies.** Evaluating `on:` filters (`branches`/`paths`/`tags`, `schedule`, `workflow_run`) requires expression evaluation and `github` context access. Does this path import from `@actspec/core` in a way that's already there — or does it need new evaluator hooks that would require touching v0.1's expression engine?

If any of these require a v0.1 type or interface change, the time to find it is now.

## The question it answers

When a real implementation of `WorkflowRunner` is built against the v0.1 type definitions (as specified in [API.md §4](../../docs/API.md), [API.md §10](../../docs/API.md), and [ARCHITECTURE.md](../../docs/ARCHITECTURE.md)):

1. Can `WorkflowRunner` drive `StepRunner` per job without modifying `StepRunner`'s interface?
2. Can `ContextStore` thread `needs.<job>` context between jobs without a shape change to its v0.1 interface?
3. Does `JobResult extends RunResult` work structurally — meaning the v0.4 job matchers and the v0.1 step/output matchers operate correctly on a `JobResult` without casting?
4. Does `WorkflowResult` (the new top-level result type) compose cleanly with the existing `RunResult`-based matchers — or are there gaps in `API.md §10` that only surface when you write real assertions?
5. Does `actspecWorkflow()` + `mockJob`/`mockReusable` add surface without any modification to `actspec()`, `@actspec/core`, or `@actspec/matchers`?
6. Does `wouldTrigger` work without needing new expression engine APIs beyond what v0.1 ships?

**Each `yes` is a confirmed design choice. Each `no` is a required change to make before v0.1 is finalized** — because the type surface it affects will already be published.

## Hypotheses to prove

- **H1 — `StepRunner` is truly action-agnostic.** `WorkflowRunner` can instantiate and drive `StepRunner` for each job's `steps:` without modifications to `StepRunner`. The per-job context (`needs`, `matrix`, `strategy`) is injected via `ContextStore` without changing `StepRunner`'s call signature.
- **H2 — `ContextStore` handles `needs` via extension, not redefinition.** Threading `needs.<job>.outputs/result` into the context of a dependent job requires no change to `ContextStore`'s v0.1 interface — it is additive (a new context key, not a new constructor parameter or a new method).
- **H3 — `JobResult extends RunResult` is structurally correct.** `expect(result.job('build')).toHaveRunStep('compile')` works with zero casting. The v0.1 matcher implementations have no implicit assumption that `conclusion` is always `'success' | 'failure'` (not `'cancelled'`).
- **H4 — `WorkflowResult` composes with existing matchers.** Writing assertions across `WorkflowResult` using `toHaveRunJob`/`toHaveJobConclusion`/`toHaveJobOutput` + `result.job(id)` with existing step/output matchers produces no shape gaps — every assertion the spec warrants is expressible.
- **H5 — `actspecWorkflow()` is a pure add.** No modification to `actspec()`, `@actspec/core` exported types, or `@actspec/matchers` is needed. `@actspec/workflow` registers itself the same way `@actspec/composite` does.
- **H6 — `needs:` DAG + matrix expand without new public fields.** The `needs:` topological sort and matrix expansion (`include`/`exclude`, `fail-fast` cancellation of siblings) can be modeled with the `WorkflowResult` / `JobResult` shape already in [API.md §10](../../docs/API.md) — no new fields on either are needed.
- **H7 — `wouldTrigger` is standalone.** Evaluating `on:` filters reuses the expression engine and github context from v0.1 without requiring new evaluator APIs, new context types, or new core exports.

## In scope

- **Minimal `WorkflowRunner`** — parse a `.github/workflows/x.yml`, resolve `needs:` into a topological order, run jobs sequentially, thread `needs.<job>.outputs/result` between them. No real shell/JS execution needed — composite or stub executors are sufficient.
- **`needs:` output threading** — a job that reads `${{ needs.build.outputs.artifact }}` in a step gets the correct value from the prior job's result.
- **Matrix expansion** — one `strategy.matrix` job expands to N runs; `fail-fast` marks siblings `cancelled` when one fails.
- **`mockJob`** — declare a job's `outputs`/`result` without executing it; prove it threads into dependent jobs correctly.
- **`wouldTrigger`** — evaluate `push` + `branches`/`paths` filters, `pull_request` types, and `schedule` cron. At least one case where it fires and one where it doesn't.
- **`JobResult extends RunResult`** — prove the extension by writing assertions that mix `toHaveRunJob` (new) and `toHaveRunStep` (v0.1) on the same result handle.
- **Fixture workflow files** under `spike/workflow/fixtures/` covering the profiles below.
- **~15 test files** against those fixtures, written in Vitest, all green.
- **Friction log** — every moment the API couldn't express what the test wanted.

## Explicitly out of scope

- Real shell or JS action execution (stub or composite executors with `run:` steps are enough to prove the design).
- Reusable workflows (`on: workflow_call`) — `mockReusable` is a natural extension of `mockJob`; prove `mockJob` first.
- `mockService` (service containers) — no container spike yet.
- `environment:` approvals, concurrency queueing, `workflow_run` trigger.
- Full `@actspec/workflow` package build (dual ESM/CJS, API Extractor, publication).
- Performance.

## Fixture selection criteria

Write 3–5 local fixture `.github/workflows/*.yml` files under `spike/workflow/fixtures/`. All four profiles must be covered:

| Required profile | Justification |
| --- | --- |
| **Two-job `needs:` fan-in** | Validates `needs:` DAG + output threading — the core `WorkflowRunner` bet |
| **Matrix job with `fail-fast`** | Validates matrix expansion, instance identity, cancellation effect on siblings |
| **Job with `if:` condition on `needs` result** | Validates `needs.<id>.result` in expression context; proves `ContextStore` extension |
| **A job mocked via `mockJob`** | Validates `mockJob` threads outputs to dependents correctly |

Keep fixtures minimal — the smallest workflow that exercises the required profile.

## Friction scenarios to probe (write at least one test for each)

| # | Friction probe | What would constitute friction |
| --- | --- | --- |
| 1 | Access a skipped job in `result.jobs` | `result.job('id')` returns `undefined` for a skipped job — no way to assert it was skipped |
| 2 | Identify a matrix job instance in `result.jobs` | Two `build` jobs (matrix: `[node18, node20]`) are ambiguous — no accessor that disambiguates by matrix value |
| 3 | Assert a job was cancelled via `fail-fast` | `conclusion: 'cancelled'` requires the v0.1 matchers to not crash on an unrecognised conclusion value |
| 4 | Assert on `needs.<job>.outputs.*` in an expression | `ContextStore` doesn't expose `needs` at v0.1 — expression eval throws or returns null |
| 5 | Thread a job's output into the next job's `run:` step | The value arrives in the `env` of the step correctly (not as `undefined` or the literal expression string) |
| 6 | `wouldTrigger` with `paths:` — no `changedFiles` supplied | Does it default to "triggered" or "not triggered"? Friction if the API shape forces you to supply files for a push event |
| 7 | Write a `mockJob` assertion on call `with:` | `JobMock` has no `.calls` — `mockJob` can't be asserted on in the same way as `mock()` for actions |
| 8 | Run a single job with `wf.run({ job: 'release' })` | Ancestor jobs with real steps execute (possibly expensively) — no way to short-circuit `needs:` ancestors without mocking them |
| 9 | Reuse a v0.1 step matcher on `result.job(id)` | `toHaveRunStep` throws because `JobResult`'s step array has a different shape or `JobResult` isn't assignable to `RunResult` |
| 10 | Assert `wouldTrigger` returns the correct job ids for a filtered push | `jobs` in `TriggerResult` lists all jobs or none — per-job `if:` conditions on the trigger aren't evaluated |

## Required deliverable — findings document

Findings are written to [`specs/spikes/workflow-findings.md`](workflow-findings.md) alongside the implementation (location: `spike/workflow/`):

1. **H1–H7 verdict** — `✅` / `❌` / `⚠️` per hypothesis, with the observed failure for any `❌`.
2. **Friction log** — for each probe: what was wanted, what the implementation revealed, classification (`no change needed` / `docs clarification` / `type change needed` / `API change needed`).
3. **`ContextStore` extensibility assessment** — what change (if any) is needed to support `needs` context in v0.4 without modifying the v0.1 interface? Exact interface diff if a change is required.
4. **`JobResult extends RunResult` assessment** — does the type extension work as written? Do any v0.1 matchers need a guard for `cancelled` conclusion or additional optional fields?
5. **`needs:` threading assessment** — how is the output of job A populated into the `needs` context of job B? Is this entirely in `WorkflowRunner`, or does it require `ContextStore` to grow a new method?
6. **Matrix identity assessment** — how are matrix job instances identified in `WorkflowResult.jobs`? Is the `id` field sufficient, or does `JobResult` need a `matrixKey` or similar?
7. **`wouldTrigger` dependencies** — which v0.1 core APIs does it rely on? Any gaps?
8. **Proposed changes** — table: `change`, `affected spec / API.md section`, `why`, `priority` (`v0.1-blocking` / `v0.4-only` / `nice-to-have`).

## Exit — what we decide after

- **If no v0.1-blocking changes:** v0.1 ships as designed. The spike's `WorkflowRunner` and fixture tests become the starting point for `@actspec/workflow` when v0.4 is scheduled.
- **If `ContextStore` needs a shape change (H2 fails):** update `ContextStore`'s interface in [specs/modules/core.md](../modules/core.md) and [API.md](../../docs/API.md) before v0.1 ships — it's a core type.
- **If `JobResult extends RunResult` doesn't hold (H3 fails):** update [API.md §4 and §10](../../docs/API.md) and [specs/modules/matchers.md](../modules/matchers.md) before v0.1 ships. A conclusion type change (`| 'cancelled'`) is a small edit; a structural incompatibility is bigger.
- **If matchers have gaps (H4 fails):** update [specs/modules/matchers.md](../modules/matchers.md) and [API.md §6](../../docs/API.md) before v0.1 ships — the missing matchers need to be designed before the matchers package is built.
- **If `actspecWorkflow()` needs a core change (H5 fails):** update [specs/modules/core.md](../modules/core.md) before v0.1 ships.
- **If `wouldTrigger` needs new expression engine APIs (H7 fails):** update [specs/modules/expressions.md](../modules/expressions.md) and [docs/EXPRESSIONS.md](../../docs/EXPRESSIONS.md) before v0.0 ships.

## References

- [docs/ARCHITECTURE.md → Workflow orchestration](../../docs/ARCHITECTURE.md#workflow-orchestration-v0.4) — the normative description of what this spike validates.
- [docs/ARCHITECTURE.md → Future-proofing invariants](../../docs/ARCHITECTURE.md#future-proofing-invariants) — the three invariants v0.1 must hold.
- [docs/API.md §4](../../docs/API.md) — `RunResult`/`StepResult` shape this spike stress-tests.
- [docs/API.md §6](../../docs/API.md) — v0.1 matchers that must work unchanged on `JobResult`.
- [docs/API.md §10](../../docs/API.md) — the `actspecWorkflow()` surface this spike validates.
- [specs/versions/v0.4.md](../versions/v0.4.md) — the v0.4 milestone this spike de-risks.
- [specs/spikes/api-ergonomics-findings.md](api-ergonomics-findings.md) — prior ergonomics spike; H7 (workflow matchers additive) was confirmed at high level but not with a running `WorkflowRunner`.
