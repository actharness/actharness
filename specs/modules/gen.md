# `@actspec/gen` — DEFERRED (post-v0.1)

> **Status: not built in v0.1.** Reserved here so the contract exists and the design stays coherent. Build after v0.1 is validated (ARCHITECTURE → Risks: a focused v0.1 beats a broad one).

Codegen: turn an `action.yml` into a typed handle so inputs/outputs/mocks are checked against the action's real surface. Opt-in; the untyped `actspec()` always works.

## Owns (when built)

[API.md §11](../../docs/API.md): the `actspec gen` codegen CLI and the generated `TypedAction<I, O>` / `TypedRunInput<I>` / `TypedRunResult<O>` shapes.

## Depends on (when built)

`@actspec/types` (for `Action`/`RunInput`/`RunResult` base types it specializes). The generator is a build-time tool; generated code imports from `@actspec/types` (and at runtime from `@actspec/core`, which re-exports everything).

## Why deferred

- Pure ergonomics over a surface that must first be **proven** (v0.1 walking skeleton + acceptance).
- Generating types against a still-settling `RunResult`/`Action` shape would create churn.
- Nothing in v0.1 needs it; deferring keeps v0.1 small, correct, and fast.

## Done-when (future)

Generated `Action<In,Out>` type-checks `run({inputs})`/`result.outputs`/mocks against a manifest; a `.test-d.ts` proves bad input/output keys are compile errors; wired into `@actspec/cli` as `actspec gen`. To be detailed in `specs/versions/` when scheduled.
