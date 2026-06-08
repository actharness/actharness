# `@actspec/matchers`

The assertion layer for actspec test results. Ships as actspec's own `expect()` — no Jest or Vitest dependency.

## Owns (public surface)
The matchers in [API.md §6](../../docs/API.md). Exposed as:
- **Globals** (via `actspec test`): `expect(result).toHaveSucceeded()` — injected into every test file's scope alongside `describe`/`it`/`test`.
- **Direct import** (optional): `import { expect } from '@actspec/matchers'` for use outside `actspec test`.

Matchers:
- Result: `toHaveSucceeded`, `toHaveFailed`, `toHaveRunStep`, `toHaveSkippedStep`, `toHaveStepConclusion`, `toHaveOutput`, `toHaveStepOutput`, `toHaveAnnotation`, `toHaveStepStdout`, `toHaveStepOutcome`.
- Mock: `toHaveBeenCalled`, `toHaveBeenCalledWith`, `toHaveBeenCalledTimes` (operate on `ActionMock`; `.calls` is also available directly).

(Workflow/job matchers — v0.4; leave names reserved, unimplemented in v0.1: `toHaveRunJob`, `toHaveJobConclusion`, `toHaveJobOutput`, `toHaveSkippedJob`, `toHaveJobCancelled`.)

**Implementation note for `toHaveRunJob` (v0.4):** must check `job.conclusion !== 'skipped' && job.conclusion !== 'cancelled'`, not just `!== 'skipped'`. `JobResult.conclusion` includes `'cancelled'` (fail-fast) which is structurally different from `RunResult.conclusion`. This is a confirmed spike finding — see [workflow-findings.md](../spikes/workflow-findings.md).

## Depends on
`@actspec/types` (the `RunResult`/`StepResult`/`ActionMock`/`ShellMock` types) — **types only**, no runtime coupling.

## Behavior (MUST)
- `expect(value)` returns a chainable assertion object. Matchers are pure functions over `RunResult`/`ActionMock` — no framework internals.
- Failure messages are **actionable**: show the step ids that ran, the actual vs expected output/conclusion, and a diff for `toHaveBeenCalledWith`.
- Negation (`.not`) is correct for every matcher.
- Types are declared in `@actspec/matchers/globals.d.ts` — added to the user's tsconfig via `types: ['@actspec/matchers/globals']`. This makes `expect`, `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, and `actspec` visible in test files without explicit imports.

## Acceptance
- Every matcher: passing case, failing case (assert the message is actionable), and `.not`.
- `toHaveStepStdout`: passing (string exact match; regex match), failing (message names the step id and shows actual stdout), `.not`.
- `toHaveStepOutcome`: passing (`'failure'` on a `continue-on-error` step whose conclusion is `'success'`), failing (message shows actual outcome), `.not`.
- Type test (`.test-d.ts`): the augmented `expect(result)` surface is fully typed.
- No Jest or Vitest peer dependency anywhere in the package.

## Done-when
Own `expect()` impl with all matchers; actionable failure messages; `.not` correct; globals type declaration ships; zero framework dependency; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
