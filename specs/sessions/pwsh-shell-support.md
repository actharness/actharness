# Session: implement pwsh shell support

## What this session should deliver

1. `fixtures/pwsh/` — full integration fixture test for `shell: pwsh` composite actions (12 tests)
2. `pwsh` coverage — line-level coverage via `Set-PSDebug -Trace 2`, wired end-to-end through the stack

Start with the fixture. Get all 12 tests green. Then tackle coverage.

---

> ## ⚠️ CRITICAL — read before implementing coverage
>
> **Line coverage is NOT what we want.**
>
> The goal is **full coverage: branches, statements, functions, and lines** — the same depth Istanbul gives for JS. Line-only coverage via `Set-PSDebug -Trace 2` is being implemented now only because a full solution does not exist yet. It is a **temporary partial step**, not the end state.
>
> - Do NOT describe line coverage as "pwsh coverage" without qualification.
> - Do NOT mark pwsh coverage as done or complete.
> - Do NOT make any architectural decisions about the full solution — that discussion has not happened yet.
> - When you update documents as part of this session, they must say `pwshShellLines` is **partial / line-only**, and that full branch, statement, and function coverage for pwsh is **unsolved**.
>
> The same constraint applies to `sh`/`bash` — their `shShellLines` metric has the same limitation, already documented.

---

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
| `packages/coverage` | Coverage collector, reporters, `sh-coverage.ts` (model for pwsh coverage) |
| `packages/cli` | Test runner — wires everything together |
| `fixtures/` | Integration fixture tests — each is a real `action.yml` + a `.test.ts` |

---

## Current state of pwsh support

`ShellSandbox` in `packages/shell/src/shell-sandbox.ts` already handles `pwsh`:

```typescript
if (normalized === 'pwsh' || normalized === 'powershell') {
  return { bin: 'pwsh', args: ['-NonInteractive', '-command', `. '${scriptPath}'`] };
}
```

There are mock-based unit tests for pwsh in `packages/shell/test/mock-shells.test.ts`. So `pwsh` executes correctly today — it just has no fixture integration test and no coverage.

---

## What sh coverage already wired (do not redo)

The sh session already added these — they cover pwsh too:

- `ShellSandboxOptions.coverage?: boolean` (in `packages/core/src/executor-registry.ts`)
- `ShellSandboxResult.shellCoverage?: { lineHits: Record<number, number> }` (same file)
- `StepResult.shellCoverage?` (in `packages/types`)
- `step-runner.ts` already propagates `shellCoverage` from sandbox result to `StepResult`
- `ExecutionResult.shellCoverage` array already exists
- `packages/coverage/src/sh-coverage.ts` exists — use it as the direct model for `pwsh-coverage.ts`
- `packages/coverage/src/types.ts` already has `shShellLines` in `FileCoverage` and `CoverageMetric`
- `packages/coverage/src/collector.ts` already accumulates sh coverage — extend it for pwsh

The **coverage key strategy** is already solved: the sandbox returns `shellCoverage` with only `lineHits` (no key). The composite executor forms the key as `<action._file ?? action._dir>#<stepId>` when building `ExecutionResult.shellCoverage`. Follow the same pattern.

---

## Spec

Full spec is at `specs/shell/shell-pwsh.md`. Key points:

### Part 1 — fixture

Location: `fixtures/pwsh/`

The `action.yml` must cover (using PowerShell syntax):
- Inputs read via `$Env:INPUT_<NAME>` (uppercased, hyphens → underscores)
- Outputs via `Add-Content -Path $Env:GITHUB_OUTPUT -Value 'key=value'`
- Env threading via `$Env:GITHUB_ENV`
- `$GITHUB_PATH` prepend
- `if:` conditions: success, failure, always
- `continue-on-error`
- `working-directory` (assert via `(Get-Location).Path`)
- Step-level `env:`
- Annotations (`Write-Output '::warning::message'` to stdout)
- Failure path via input flag

12 tests in `fixtures/pwsh/pwsh.test.ts`. Look at `fixtures/sh/sh.test.ts`, `fixtures/conditions/conditions.test.ts`, and `fixtures/diagnostics/diagnostics.test.ts` for the exact API shape and assertion style to follow.

### Part 2 — coverage

**Mechanism**: zero external dependencies. Prepend `Set-PSDebug -Trace 2` as the first line of the script.

After the process exits, parse stderr for lines matching `DEBUG:\s+(\d+)\+`. The captured number is the line number in the **modified** script (with the prepended header line). Subtract 1 to get the original script line number. Count hits per line to build `Record<number, number>`.

Example stderr:
```
DEBUG:    1+  >>>> $x = 1
DEBUG:    2+ if ($x -eq 1) {  >>>> Write-Output 'yes' }
DEBUG:    2+ if ($x -eq 1) { Write-Output 'yes'  >>>> }
```

Line 2 appears twice — count each occurrence as an additional hit (do not deduplicate).

**Packages to change** (in order):

1. `packages/shell/src/pwsh-coverage.ts` (new file)
   - `parsePwshCoverage(stderr: string, headerLineCount: number): Record<number, number>`

2. `packages/shell/src/shell-sandbox.ts`
   - Extend the coverage path: when `coverage: true` and shell is `pwsh` or `powershell`, prepend `Set-PSDebug -Trace 2\n`, parse stderr after exit using `parsePwshCoverage`, populate `shellCoverage`

3. `packages/coverage/src/pwsh-coverage.ts` (new file)
   - `buildPwshStats(lineHits: Record<number, number>, source: string): { lines: CoverageStat }`
   - Counts total executable lines: non-blank, non-comment (PowerShell comments start with `#`)
   - Model exactly on `packages/coverage/src/sh-coverage.ts`

4. `packages/coverage/src/types.ts`
   - Add `pwshShellLines?: CoverageStat` to `FileCoverage`
   - Add `'pwshShellLines'` to `CoverageMetric`

5. `packages/coverage/src/collector.ts`
   - Accumulate pwsh coverage entries (same pattern as sh: `_pwshShellCoverageData`)
   - Compute and store `pwshShellLines` per action file in `toCoverageReport()`

6. `packages/coverage/src/text-reporter.ts` and `html-reporter.ts`
   - Render `pwshShellLines` alongside `shShellLines` (share the "Shell files" section)

---

## How sh coverage works (use as the model)

The closest analogue is sh coverage, already implemented:

- `packages/shell/src/sh-coverage.ts` — parses `::COVERED::N::` markers from stderr
- `packages/shell/src/shell-sandbox.ts` — prepends 3-line header, calls `parseShCoverage` on exit
- `packages/coverage/src/sh-coverage.ts` — `buildShStats` counts executable lines
- `packages/coverage/src/collector.ts` — `_shShellCoverageData` map, `toCoverageReport()` sh loop
- `packages/coverage/src/types.ts` — `shShellLines` in `FileCoverage` and `CoverageMetric`

Follow the same pattern exactly — `pwsh` is `sh` with a different header and different stderr parser.

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

All packages are at 100% coverage. Keep them there.

---

## Rules

- Never make architectural or behavioral decisions not confirmed by the user — ask first
- Never start implementing based on a strategy discussion — wait for explicit go-ahead
- Never use git commands
- Redirect all npm/test output to a file (as shown above) — never pipe directly to tail
