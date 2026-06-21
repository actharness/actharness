# `@actharness/matchers`

The assertion layer for actharness test results. Ships as actharness's own `expect()` — no test-framework dependency.

## Owns (public surface)
The matchers in [API.md §6](../../docs/API.md). Exposed as:
- **Globals** (via `actharness test`): `expect(result).toHaveSucceeded()` — injected into every test file's scope alongside `describe`/`it`/`test`.
- **Direct import** (optional): `import { expect } from '@actharness/matchers'` for use outside `actharness test`.

Matchers:
- Result: `toHaveSucceeded`, `toHaveFailed`, `toHaveStep`, `toHaveStepSucceeded`, `toHaveStepFailed`, `toHaveStepSkipped`, `toHaveOutput`, `toHaveStepOutput`, `toHaveAnnotation`.
- Step: `toHaveSucceeded`, `toHaveFailed`, `toHaveBeenSkipped`, `toHaveOutput`, `toHaveAnnotation`, `toHaveStdoutContaining`, `toHaveStderrContaining` (operate on `result.step('id')`; if step absent, throws `"Expected step to exist, but step was not found"`).
- Mock: `toHaveBeenCalled`, `toHaveBeenCalledWith`, `toHaveBeenCalledTimes` (operate on `ActionMock`; `.calls` is also available directly).

(Workflow/job matchers — v0.4; leave names reserved, unimplemented in v0.1: `toHaveRunJob`, `toHaveJobConclusion`, `toHaveJobOutput`, `toHaveSkippedJob`, `toHaveJobCancelled`.)

**Implementation note for `toHaveRunJob` (v0.4):** must check `job.conclusion !== 'skipped' && job.conclusion !== 'cancelled'`, not just `!== 'skipped'`. `JobResult.conclusion` includes `'cancelled'` (fail-fast) which is structurally different from `RunResult.conclusion`. This is a confirmed spike finding — see [workflow-findings.md](../spikes/workflow-findings.md).

## Depends on
`@actharness/types` (the `RunResult`/`StepResult`/`ActionMock`/`ShellMock` types) — **types only**, no runtime coupling.

## Behavior (MUST)
- `expect(value)` returns a chainable assertion object. Matchers are pure functions over `RunResult`/`ActionMock` — no framework internals.
- Failure messages are **actionable**: show the step ids that ran, the actual vs expected output/conclusion, and a diff for `toHaveBeenCalledWith`.
- Negation (`.not`) is correct for every matcher.
- Types are declared in `@actharness/matchers/globals.d.ts` — added to the user's tsconfig via `types: ['@actharness/matchers/globals']`. This makes `expect`, `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, and `actharness` visible in test files without explicit imports.

## Acceptance
- Every matcher: passing case, failing case (assert the message is actionable), and `.not`.
- Step matchers (`toHaveSucceeded`, `toHaveFailed`, `toHaveBeenSkipped`, `toHaveOutput`, `toHaveAnnotation`, `toHaveStdoutContaining`, `toHaveStderrContaining` on `result.step('id')`): passing case, failing case (message names the step id and shows actual value), `.not`; when step absent, all throw `"Expected step to exist, but step was not found"`.
- Type test (`.test-d.ts`): the augmented `expect(result)` surface is fully typed.
- No test-framework peer dependency anywhere in the package.

## Done-when
Own `expect()` impl with all matchers; actionable failure messages; `.not` correct; globals type declaration ships; zero framework dependency; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
