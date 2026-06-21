# `@actharness/core`

The hub. Owns the public entry, the execution contract, and everything shared: parsing, context, the runner protocol, mocking, the executor registry, the single-action runner, result building, errors, and determinism. Every other package depends on it; it depends only on `@actharness/expressions`.

## Owns (public types)
The consumer-facing surface in [API.md](../../docs/API.md): `actharness()` (§1), `Action` (§2), `RunInput` (§3), `RunResult`/`StepResult`/`Annotation` (§4), `ActionMock`/`ActionMockDef`/`ActionMockImpl` (§5), `ActharnessOptions`/`Determinism` (§1), and the error hierarchy (§13). Plus the internal seam (from [ARCHITECTURE](../../docs/ARCHITECTURE.md)): `ActionExecutor`, `ExecutionCall`, `ExecutionResult`, `ContextStore`, `RunnerProtocol`, `MockResolver`, `SandboxFactory`.

These types are the contract — match them exactly; do not re-shape.

## Depends on
`@actharness/expressions` and `@actharness/types`. **No other `@actharness/*` import** (executors/sandboxes register *into* core; coverage/matchers/fixtures depend *on* core). Types defined in `@actharness/types` are re-exported from `@actharness/core` so consumers import from either.

## Behavior (MUST)
1. **Parse** `action.yml`/`action.yaml` (or dir/inline/manifest) for **all** `using:` kinds (so errors are good), but in v0.1 only **dispatch** `composite`; unknown/other `using:` → a clear `ParseError`/`ActharnessError` ("node actions land in v0.2"). Carry `file:line:col` on every parse error, and **preserve `line:col` ranges on every node** (steps, `if:`, `with:`, `outputs`) — diagnostics and coverage both consume them. Default parser: **`yaml` (eemeli)**, whose CST exposes node ranges (js-yaml doesn't).
2. **Build context** — merge user `github`/`env`/`runner`/`secrets`/`matrix`/`eventPayload` over fixture defaults; expose the read-only `ContextStore` keyed by context name. Serialize `eventPayload` to `event.json` in the workspace and set `GITHUB_EVENT_PATH` to that path — matching `github.event_path` — so `run:` steps that `cat $GITHUB_EVENT_PATH` work.
3. **Resolve inputs** — apply `default:`, coerce to string, and populate `INPUT_<NAME>` with the exact transform (uppercase, spaces→`_`) from [EXPRESSIONS/Fidelity](../../docs/ARCHITECTURE.md#fidelity--semantics). Missing `required` input → warning annotation, not a throw.
4. **Dispatch** to the `ActionExecutor` whose `handles(using)` matches, via the registry; build the `ExecutionCall`; shape its `ExecutionResult` into the public `RunResult`, **source-stamped** and recording every `if:` outcome (the coverage invariant). Then notify the **run-observation sink** — a process-global listener registry (`registerRunListener`, keyed `globalThis[Symbol.for('actharness.runSink')]`) — with the finished `RunResult`, so `@actharness/coverage` subscribes **without core depending on it**.
5. **`RunnerProtocol`** — allocate per-invocation temp files for `GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}` and parse the file formats + stdout workflow commands **exactly** per the grounded spec — **[docs/PROTOCOL.md](../../docs/PROTOCOL.md)** (the binding contract: escaping with `%25` decoded last, the `ghadelimiter_` heredoc + CVE guard, `stop-commands`, the full command set). Gate: green on [corpus/protocol](../../corpus/protocol/).
6. **`MockResolver`** — per-`Action` registry (never global). Resolution order: explicit `mock(ref)` > per-ref policy > default policy. Default = **local-vs-remote** (`./`,`../` → `real` recurse; remote → `noop` + warning). `real` resolves local paths only; a remote ref set to `real` is a config error. Enforce cycle detection + a max-depth limit (default 50, configurable; [D36](../../docs/DECISIONS.md#d36--mockresolver-recursion-guard)).
7. **Determinism** — a `Clock`/`Rng`/id source injected through the call; frozen by default (fixed epoch, seeded RNG, stable `GITHUB_RUN_ID`/`RUNNER_TEMP`/workspace). Nothing in core or downstream may call `Date.now`/`Math.random`/`randomUUID` directly.
8. **Workspace** — one shared `GITHUB_WORKSPACE` temp dir per **top-level** `run()`, reused by nested local `uses: ./child`; auto-removed unless `keepWorkspace`. Env-files (`GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}`) are allocated **fresh per step**; `$GITHUB_ENV`/`$GITHUB_PATH` accumulate forward for later steps, `$GITHUB_OUTPUT` is per-step → `steps.<id>.outputs`. The workspace may optionally be seeded from a directory via `options.workspace` — copied in the moment a checkout-like `uses:` step (`actions/checkout@*`) executes, not eagerly at workspace creation, so a step before checkout sees an empty workspace just like on the real runner; same auto-removal semantics apply to the copy. Its parent location is configurable via `options.tempDir`.
9. **Mocks as spies** — `ActionMock.calls` is an array of invocation records usable with actharness's matchers or directly.

## Acceptance
Fixtures under `packages/core/test/fixtures/`:
- **parse** — valid composite manifest → structured model; malformed YAML → `ParseError` with line/col; `using: node20` → clear "v0.2" error.
- **inputs** — `default` applied; `My Input` → `INPUT_MY_INPUT`; boolean/number coerced to string; missing `required` → warning annotation.
- **context** — omitted fields get documented defaults (`github.repository`, `runner.os`); user overrides win; `eventPayload` populates `github.event` and `GITHUB_EVENT_PATH` points at a temp `event.json` containing the serialized payload.
- **protocol** — write `name=value` and a heredoc to a temp `$GITHUB_OUTPUT`/`$GITHUB_ENV`, read back correctly; parse each workflow command from a stdout stream; `add-mask` masks in captured logs.
- **mock resolver** — explicit mock > policy; local `./x` → real; remote `a/b@v1` unmocked → noop + one warning; remote set to `real` → config error; self-referential graph → cycle error.
- **determinism** — two runs produce identical `GITHUB_RUN_ID`/timestamps/temp paths; `seed`/`now` overrides take effect.
- A registered fake `ActionExecutor` is dispatched on its `handles()` and its `ExecutionResult` becomes a well-formed `RunResult` (source-stamped, `if:` outcomes present).

## Done-when
Per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module): public types equal API.md; acceptance green; no `@actharness/*` deps beyond `expressions`; determinism routed through injected sources (lint-enforced ban on `Date.now`/`Math.random`/`randomUUID`).
