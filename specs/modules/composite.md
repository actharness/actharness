# `@actspec/composite`

The v0.1 executor: runs `using: composite` actions — the step loop + the `ShellSandbox` that executes real `run:` shell in a scoped temp workspace. Registers itself into core's executor registry.

## Owns
- An `ActionExecutor` with `handles('composite')`.
- `ShellSandbox` (a `SandboxFactory` shell provider).

No new *public* consumer types — it surfaces results through core's `RunResult`/`StepResult`.

## Depends on
`@actspec/core` (seam types, protocol, context, mock resolver, errors) and `@actspec/expressions` (via core's evaluator). No others.

## Behavior (MUST)
1. **Step loop**, in manifest order. For each step:
   - Evaluate `if:` (default `success()`); coerce to boolean. **Status model (match the runner):** track a running composite status starting `success`, flipping to `failure` on the first step whose **conclusion** is `failure` (i.e. *after* `continue-on-error` is applied — so c-o-e failures don't flip it). `success()` holds only while that status is `success` and the injected `jobStatus` isn't `failure`/`cancelled`; `failure()` once a prior step failed; `always()` always; `cancelled()` from `jobStatus`. False → record `outcome:'skipped'`, `ran:false`, and the `if` result (for branch coverage). True → execute.
   - **`run:` step** → `ShellSandbox`: substitute `${{ }}` into the script as **literal text** (reproduce GitHub's injection behavior — don't sanitize), then spawn the declared `shell` with the faithful wrapper (`bash --noprofile --norc -eo pipefail {0}`, `sh -e`, `pwsh -command`, …; default by `runner.os`). Honor `working-directory`; build env from the scoped allowlist + `GITHUB_*` + `RUNNER_*` + `INPUT_*` + accumulated `$GITHUB_ENV` (precedence: step `env` > action `env` > process allowlist). Exit code decides `outcome`.
   - **`uses:` step** → resolve via core's `MockResolver` (mock replay, local `real` recursion, or remote `noop`+warning). Pass the evaluated `with:` as `INPUT_*` to the child; collect its outputs into `steps.<id>.outputs`.
2. **Env-file threading** — after each step, read `$GITHUB_OUTPUT`→`steps.<id>.outputs`, `$GITHUB_ENV`→context env for later steps, `$GITHUB_PATH`→PATH, `$GITHUB_STATE`. Children's pre/main/**post** phases run in the runner's order (post in reverse, after mains) and carry `phase` on their `StepResult`s.
3. **outcome vs conclusion** — `continue-on-error: true` ⇒ a failed step keeps `outcome:'failure'` but `conclusion:'success'` and the run continues; otherwise a failure stops the run and fails it.
4. **Action outputs** — after all steps, evaluate each `outputs.<name>.value` **late** against the final `steps` context.
5. Collect per-step `stdout`/`stderr`, annotations, and final env into the `ExecutionResult`.

## Acceptance
Fixtures under `packages/composite/test/fixtures/`:
- **`greet/`** — the [walking skeleton](../versions/v0.1.md#integration-checkpoint--the-walking-skeleton). Must pass.
- **mocked `uses:`** — `checkout/action.yml` consumer; `mock('actions/checkout@v4', {outputs:{ref:'abc'}})`; assert the `with:` recorded and a later step reads `steps.checkout.outputs.ref`.
- **skipped step** — `if:` false → `skipped`, `ran:false`, `if.result:false`.
- **failing step** — non-zero exit → run `failure`, step `conclusion:'failure'`; same fixture with `continue-on-error:true` → run `success`, step `outcome:'failure'`.
- **`pipefail`** — `false | true` in a bash step fails (proves the wrapper).
- **`$GITHUB_ENV` threading** — step A writes `FOO=bar`, step B echoes `$FOO`.
- **local recursion** — `uses: ./child` runs the child composite for real; remote unmocked `uses:` → noop + one warning.
- **late outputs** — action `outputs.x.value: ${{ steps.s.outputs.y }}` resolves after the step ran.

## Done-when
Walking skeleton + all v0.1 acceptance scenarios green; registers cleanly into core; deps limited to `core`(+`expressions`); shell wrappers match the [fidelity table](../../docs/ARCHITECTURE.md#fidelity--semantics); per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
