# Spike — unified API ergonomics (`mock` / `run` / `expect`)

> **POC spike — proves the complete API surface through real execution.** Implements minimal composite, node, and workflow executors; writes and runs ~20 tests against local fixture actions; documents friction and validates the unified `mock`/`run`/`expect` surface across all three execution types. The spike's executors and tests become the starting point for the main codebase.

## Why this spike

The third highest-risk assumption ([ARCHITECTURE → highest-risk assumptions](../../docs/ARCHITECTURE.md#the-three-highest-risk-assumptions)):

> *"that `mock/run/expect` truly feels the same across composite/node/docker/workflow. Mitigation: write ~20 real tests by hand against existing public actions and feel the friction."*

[API.md](../../docs/API.md) specifies the surface. The surface can be **internally consistent on paper but feel wrong in practice** — until you build a working POC and run 20 real tests, you don't know which assertions are awkward, what the API can't express cleanly, or where you had to think about the action type to write the test.

The goal: catch API friction **before the full codebase is built** so no shape that's supposed to be stable ever needs a breaking change.

## The question it answers

When a real developer implements minimal executors and writes ~20 tests for local fixture actions of different types (composite, node, and workflow-shaped), using **only** [API.md](../../docs/API.md) as reference:

1. Does `mock(ref)` work identically whether the dependency is a composite or a node action? (No `type`-check required.)
2. Does the `RunResult` / `StepResult` shape support every assertion naturally, without casting or workarounds?
3. Does the matchers set (`toHaveSucceeded`, `toHaveRunStep`, `toHaveOutput`, `toHaveBeenCalledWith`, …) cover every assertion the tests want to make, or are there gaps?
4. Does `mockShellCommand` + `mockGitHubApi` feel like the same "mock your dependencies" pattern, or a separate paradigm that needs explaining?
5. Are there scenarios the API simply cannot express elegantly — an assertion, a setup step, or a mock that requires awkward workarounds?

**Each `yes` is a confirmed design choice. Each `no` is a proposed API change to make before v0.1 is finalized.**

## Why now (before the full build)

The unified-surface promise is: *"no breaking changes to `mock`/`run`/`expect`"*. Breaking it later means:

- Published consumers hit a breaking change.
- The matchers package (`@actspec/matchers`) has already been shipped.
- The API Extractor snapshot is already committed.

Friction found now is a spec edit. Friction found after the full codebase exists is a breaking change and a rewrite of already-published consumers.

## Hypotheses to prove

- **H1 — No type knowledge required for `mock()`.** Writing `action.mock('actions/checkout@v4', { outputs: {ref:'abc'} })` feels identical whether `actions/checkout` is composite or node. The test never names the type.
- **H2 — `RunResult` is type-agnostic.** `result.outputs`, `result.steps`, `result.conclusion` are consistent regardless of action type. A node action's `$GITHUB_OUTPUT` writes arrive in `result.outputs` exactly like a composite action's `outputs.<name>.value`.
- **H3 — Matchers cover the real test vocabulary.** The ~20 tests do not need to write `expect(result.steps[0].conclusion).toBe('success')` because `toHaveStepConclusion('id', 'success')` already exists. There are no "I wanted a matcher but had to reach into the raw result" moments.
- **H4 — Mixed-type composites feel natural.** A composite that `uses:` a node child (`actions/github-script@v7`): `mock()` the child, run the composite, assert on the composite's output — with zero type-specific ceremony.
- **H5 — `mockShellCommand` + `mockGitHubApi` share the mental model.** Writing both in the same test file feels coherent; the docs needed for each are parallel, not different.
- **H6 — pre/main/post assertions are natural.** Asserting on a node action's `pre`/`post` phases via `result.steps.filter(s => s.phase === 'post')` or `toHaveStepConclusion(id, …)` doesn't feel like a special case.
- **H7 — Workflow matchers are additive.** Writing a workflow test using `toHaveRunJob`/`toHaveJobConclusion`/`toHaveJobOutput` feels like the action matchers one level up — not a different API.

## In scope

- **Minimal composite executor** — parse `action.yml`, run `run:` steps in a real shell, evaluate `${{ }}` expressions, mock `uses:` children via `MockResolver`, collect outputs and `StepResult`s.
- **Minimal node executor** — `worker_thread` JsSandbox (design proven in [node-sandbox spike](node-sandbox-findings.md)): env-file protocol wiring, `@actions/core` passthrough, `process.exit` trap, undici `MockAgent` for Octokit interception, pre/main/post lifecycle.
- **Minimal WorkflowRunner** — sequential job execution, `needs:` output threading. No matrix expansion.
- **~20 hand-written test files** against local fixture actions (see selection criteria below), as **real Vitest test files** that all run green.
- The **friction log** — every moment you reached for the API and found it missing, awkward, or surprising.
- A list of **proposed API changes** derived from the log — specific, scoped (`API.md §N`, what changes, why).

## Explicitly out of scope

- Docker executor (v0.3 — container execution is not needed to validate API ergonomics).
- Matrix expansion in the WorkflowRunner (no `strategy.matrix`).
- Coverage reports.
- Performance or error-message quality.
- Full `@actspec/*` package build (dual ESM/CJS, API Extractor snapshots, publication).

## Success criteria (the spike's gate)

1. **~20 tests written and green** (±5 acceptable) across at least 4 distinct local fixture actions covering composite, node, and workflow-shaped execution types. The spike is not complete until all tests pass — a written-but-failing test is a finding that must resolve to either an API change or a confirmed implementation gap.
2. **All three executor types run** — at least one composite test, one node test, and one workflow test execute end-to-end against real fixture actions.
3. **Friction log complete** — every moment of API friction captured with: what you wanted, what the API gave, and whether it's a gap, an awkward path, or just unfamiliar.
4. **Proposed changes list** — each friction item resolved to one of: `no change needed (misread)` / `docs clarification` / `API change (scope: matchers | RunResult | mock surface | entry)` / `new API surface needed`.
5. **H1 smoke test** — confirm at least one composite test and one node test use `mock(ref)` identically (same call shape, no type branching).

## Action selection criteria

Write 4–6 local fixture `action.yml` files under `spike/api-ergonomics/fixtures/`. Coverage requirement (all four must be hit):

| Required profile | Justification |
| --- | --- |
| **Composite with at least one `uses:` child** | Validates `mock()` in its natural habitat |
| **Composite with `if:` conditions** | Validates branch-coverage matchers + `toHaveSkippedStep` |
| **Node action using `@actions/core` + `@actions/github`** | Validates `mockGitHubApi` side of the mock mental model |
| **A workflow with `needs:` fan-out** | Validates additive workflow matchers (H7) |

Additional guidance:

- Keep fixtures minimal — the smallest `action.yml` that exercises the required profile. Complexity belongs in the test, not the fixture.
- Include at least one scenario you expect to be annoying — those reveal the most friction.

## The friction scenarios to look for (write at least one test probing each)

These are the API design bets that are hardest to validate on paper:

| # | Friction probe | What would constitute friction |
| --- | --- | --- |
| 1 | Mock a node child from a composite parent | If you needed to know the child is a node action (different `mock()` call) |
| 2 | Assert on a node action's `$GITHUB_OUTPUT` write | If `result.outputs` was shaped differently, or you had to dig into `steps[0]` |
| 3 | Assert that a `run:` step's stdout contains a string | If there was no matcher and you had to `expect(result.step('id')!.stdout).toContain(…)` |
| 4 | Verify `mock()` received the correct `with:` values | If the calls shape was incompatible with native jest matchers |
| 5 | Test a `continue-on-error` step | If `outcome` vs `conclusion` required a special matcher |
| 6 | Assert on a `pre:` phase result | If `result.steps.filter(s => s.phase === 'pre')` was the only path (no matcher shorthand) |
| 7 | Test a composite with two child mocks and assert invocation order | If call order required reaching into `mock.calls[0]` manually |
| 8 | Write a second test on the same `Action` handle with different inputs | If state leaked between `run()` calls or required explicit `reset` |
| 9 | Assert on `$GITHUB_ENV` / env threading across steps | If `result.env` wasn't exposed or required extra unwrapping |
| 10 | Write the same assertion for a workflow job as for an action step | If `toHaveJobConclusion` and `toHaveStepConclusion` required different ergonomics |

## Required deliverable — a findings document

Findings are written to [`specs/spikes/api-ergonomics-findings.md`](api-ergonomics-findings.md) alongside the test files (location: `spike/api-ergonomics/`):

1. **Test inventory** — table of tests written: action, type (composite/node/workflow), matchers used, friction (y/n).
2. **Friction log** — for each friction moment: probe #, what was wanted, what the API gave, friction classification.
3. **Proposed changes** — table: `change`, `API.md section`, `current text`, `proposed text`, `priority` (`v0.1-blocking` / `v0.2` / `nice-to-have`).
4. **H1–H7 verdict** — `✅` / `❌` / `⚠️` per hypothesis.
5. **API.md diff** — if any `v0.1-blocking` changes are proposed, include the exact diff here (prose description + snippet, not a git diff). The findings doc is the source of truth; API.md is updated *after* the maintainer approves.

## Exit — what we decide after

- **If no blocking friction:** the spike's executors and tests are promoted as the starting point for the main codebase. API.md is confirmed as-is.
- **If blocking friction is found:** update API.md (and the affected module spec) before promoting the spike's code — the spec is the source of truth, not the code.
- **If matchers gaps are found** (missing matcher, awkward shape): update [specs/modules/matchers.md](../modules/matchers.md) and [API.md §6](../../docs/API.md) before building `@actspec/matchers`.
- **If `RunResult`/`StepResult` shape changes are needed:** update [API.md §4](../../docs/API.md) and all module specs that produce results. This is the most expensive change — a shape change here propagates across all executors.

## References

- [docs/API.md](../../docs/API.md) — the surface being validated.
- [docs/ARCHITECTURE.md → Highest-risk assumptions](../../docs/ARCHITECTURE.md#the-three-highest-risk-assumptions) — where this spike is called for.
- [docs/ARCHITECTURE.md → Mocking model](../../docs/ARCHITECTURE.md#mocking-model--two-distinct-surfaces-one-mental-model-mock-your-dependencies) — the mental model the tests must validate.
- [specs/modules/matchers.md](../modules/matchers.md) — the matchers contract this spike validates.
- [D21](../../docs/DECISIONS.md#d21--mock-surface-keep-the-split-not-unified) — the two-headed mock surface this spike stress-tests.
- [D33](../../docs/DECISIONS.md#d33--model-the-premainstep-phase-from-v0.1) — why `phase` is in v0.1 types; this spike validates the assertion ergonomics.
- [specs/spikes/node-sandbox-findings.md](node-sandbox-findings.md) — companion spike complete; JsSandbox design confirmed. Implementation details (same-instance undici patching, `process.exit` trap) apply directly to the node executor built here.
