# Session: implement sh shell support

## What this session should deliver

1. `fixtures/sh/` — full integration fixture test for `shell: sh` composite actions (12 tests)
2. `sh` coverage — line-level coverage via `set -x` + `PS4` tracing, wired end-to-end through the stack

Start with the fixture. Get all 12 tests green. Then tackle coverage.

---

## Project overview

**actharness** — a GitHub Actions unit testing framework. Users write `.test.ts` files that call `actharness('./action.yml').run({ inputs, env, ... })` and make assertions on the result. The monorepo lives at `/Users/stefanobassan/Projects/theobassan/actspec/`.

Key packages:

| Package | Role |
|---------|------|
| `packages/shell` | `ShellSandbox` — spawns real child processes for composite `run:` steps |
| `packages/core` | `step-runner.ts` — the composite step loop; `executor-registry.ts` — `ExecutionResult` type |
| `packages/types` | Shared types: `StepResult`, `ActharnessOptions`, etc. |
| `packages/composite` | Composite action executor — calls `step-runner` |
| `packages/coverage` | Coverage collector, reporters, `js-coverage.ts` (model for sh coverage) |
| `packages/cli` | Test runner — wires everything together |
| `fixtures/` | Integration fixture tests — each is a real `action.yml` + a `.test.ts` |

---

## Current state of sh support

`ShellSandbox` in `packages/shell/src/shell-sandbox.ts` already handles `sh`:

```typescript
if (normalized === 'sh') {
  return { bin: 'sh', args: ['-e', scriptPath] };
}
```

There is a real unit test for `sh` in `packages/shell/test/unit.test.ts`. So `sh` executes correctly today — it just has no fixture integration test and no coverage.

---

## Spec

Full spec is at `specs/shell/shell-sh.md`. Key points:

### Part 1 — fixture

Location: `fixtures/sh/`

The `action.yml` must cover (using only POSIX sh syntax — no `[[`, no `pipefail`):
- Inputs: one with a default, one required
- Outputs via `$GITHUB_OUTPUT`
- Env threading via `$GITHUB_ENV`
- `$GITHUB_PATH` prepend
- `if:` conditions: success, failure, always
- `continue-on-error`
- `working-directory`
- Step-level `env:`
- Annotations (`::warning::`, `::error::`)
- Failure path via input flag

12 tests in `fixtures/sh/sh.test.ts`. Look at `fixtures/conditions/conditions.test.ts`, `fixtures/env/env.test.ts`, and `fixtures/diagnostics/diagnostics.test.ts` for the exact API shape and assertion style to follow.

### Part 2 — coverage

**Mechanism**: zero external deps. Prepend this header to every sh/bash script when coverage is enabled:

```sh
PS4='::COVERED::${LINENO}::'
export PS4
set -x
```

After the process exits, parse stderr for lines matching `::COVERED::N::`. Build `Record<number, number>` (line → hit count). Subtract the header line count from each parsed line number to get the original script line numbers.

**Open question to resolve before implementing coverage**: the temp script file path is ephemeral — it changes every run. Coverage data needs to be keyed by something stable to accumulate across multiple test runs. Two options:
- Pass the canonical key (action file path + step id) into the sandbox alongside the script, carry it through `ShellSandboxResult` as `coverageKey`
- Key by action path + step id in `step-runner.ts` and attach it when building the `StepResult`

Pick one and stay consistent — the same solution will be reused for python and pwsh coverage in later sessions.

**Packages to change** (in order):

1. `packages/shell/src/shell-sandbox.ts`
   - `ShellSandboxOptions`: add `coverage?: boolean`
   - `ShellSandboxResult`: add `shellCoverage?: { lineHits: Record<number, number> }`
   - When `coverage: true` and shell is `sh` or `bash`: prepend header, parse stderr after exit

2. `packages/shell/src/sh-coverage.ts` (new file)
   - `parseShCoverage(stderr: string, headerLineCount: number): Record<number, number>`

3. `packages/types/src/index.ts`
   - `StepResult`: add `shellCoverage?: { lineHits: Record<number, number> }`

4. `packages/core/src/step-runner.ts`
   - Propagate `shellCoverage` from the sandbox result into `StepResult`

5. `packages/core/src/executor-registry.ts`
   - `ExecutionResult`: add `shellCoverage?: Array<{ key: string; lineHits: Record<number, number> }>`

6. `packages/coverage/src/sh-coverage.ts` (new file)
   - `buildShStats(lineHits: Record<number, number>, source: string): { lines: CoverageStat }`
   - Counts total executable lines (non-blank, non-comment lines in the source)

7. `packages/coverage/src/types.ts`
   - Add `shShellLines?: CoverageStat` to `FileCoverage`
   - Add `shShellLines` to `CoverageMetric`

8. `packages/coverage/src/collector.ts`
   - Accumulate shell coverage entries; compute and store `shShellLines` per action file

9. `packages/coverage/src/text-reporter.ts` and `html-reporter.ts`
   - Render `shShellLines` in the report (new "Shell files" section or alongside JS files)

---

## How node coverage works (use as the model)

The closest analogue to sh coverage is how JS/node coverage flows:

- `packages/node/src/js-sandbox.ts` collects raw V8 data and returns it in the sandbox result
- `packages/node/src/node-executor.ts` accumulates it in `allJsCoverage` and returns it in `ExecutionResult.jsCoverage`
- `packages/coverage/src/collector.ts` receives it via `meta.jsCoverage` in the run listener
- `packages/coverage/src/js-coverage.ts` converts it to `CoverageStat` objects

Follow the same pattern for sh: sandbox → step result → execution result → collector → stats.

---

## Running tests

```bash
npm test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
```

Or per-package:

```bash
pnpm --filter='./packages/shell' test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
pnpm --filter='./fixtures' test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
```

All packages are at 100% coverage today. Keep them there.

---

## Rules

- Never make architectural decisions not confirmed by the user — ask first
- Never start implementing based on a strategy discussion — wait for explicit go-ahead
- Never use git commands
- Redirect all npm/test output to a file (as shown above) — never pipe directly to tail
