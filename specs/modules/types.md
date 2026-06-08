# `@actspec/types`

Zero-dependency package at the bottom of the DAG. The single source of truth for all public interfaces and default constants — no other `@actspec/*` package defines types; they import from here ([D41](../../docs/DECISIONS.md#d41--actspectypes-is-the-zero-dep-dag-root-types--defaults)). Part of v0.1.

## Owns (public surface)

**Type definitions** (matching [API.md](../../docs/API.md) exactly):
- `RunResult`, `StepResult`, `Annotation`, `ExpressionTrace`
- `RunInput`, `ActspecOptions`, `Determinism`
- `GitHubContext`, `RunnerContext`
- `ActionMock`, `ActionMockDef`, `ActionMockImpl`, `ActionMockCall`
- `ShellMock`, `ShellCommandImpl`, `ShellMockResult`, `ShellMockCall`
- `ParsedAction` (the manifest model)

**Default constants** (matching [CONTEXTS.md](../../docs/CONTEXTS.md) exactly):
- `GITHUB_DEFAULTS: Readonly<GitHubContext>` — all default values for the `github` context
- `RUNNER_DEFAULTS: Readonly<RunnerContext>` — all default values for the `runner` context

## Depends on

Nothing. Zero `@actspec/*` dependencies. Zero runtime dependencies. Pure `interface`/`type`/`const` — no functions, no classes, no side effects.

## Behavior (MUST)

- Every exported type matches its definition in [API.md](../../docs/API.md) exactly — these are the contract, not a copy.
- `GITHUB_DEFAULTS` and `RUNNER_DEFAULTS` match the values in [CONTEXTS.md](../../docs/CONTEXTS.md) exactly.
- `sideEffects: false` — no module-level code.
- Dual ESM+CJS output per [D9](../../docs/DECISIONS.md#d9--dual-esm--cjs-output).

## Acceptance

- `GITHUB_DEFAULTS.repository === 'owner/repo'` — and every other documented default matches [CONTEXTS.md](../../docs/CONTEXTS.md).
- `RUNNER_DEFAULTS.os === 'Linux'`.
- Type test (`.test-d.ts`): all exported types compile; no `any` in public surface ([D24](../../docs/DECISIONS.md#d24--typescript-strictness--no-any)).
- `@actspec/core` and `@actspec/fixtures` workspace graph confirms `@actspec/types` as their dep — not each other.

## Done-when

All types from [API.md](../../docs/API.md) defined here; `GITHUB_DEFAULTS` + `RUNNER_DEFAULTS` matching [CONTEXTS.md](../../docs/CONTEXTS.md); zero deps; dual output; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
