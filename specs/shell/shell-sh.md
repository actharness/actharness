# Spec: sh shell support

## Goal

Add end-to-end fixture integration tests for composite actions using `shell: sh`, and add line-level code coverage for sh/bash scripts.

---

## Part 1 — Fixture integration test

### Location

`fixtures/sh/`

### action.yml

A composite action that exercises the full feature set using only POSIX sh syntax (no bash-isms — no `[[`, no `pipefail`):

- **Inputs**: one with a default, one required (no default)
- **Outputs**: multiple, set via `$GITHUB_OUTPUT`
- **Env threading**: a value written to `$GITHUB_ENV` in one step is visible in the next
- **`$GITHUB_PATH`**: a path written in one step is prepended to `PATH` in the next
- **`if:` conditions**: one step that runs only on success, one that runs only on failure, one with `always()`
- **`continue-on-error`**: a step that exits non-zero but does not fail the action
- **`working-directory`**: a step that runs in a subdirectory
- **Step-level `env:`**: overrides the seed env for one step only
- **Annotations**: `::warning::` and `::error::` written to stdout
- **Failure path**: a step that exits 1 when an input flag is set

All `run:` steps must use `shell: sh`. No bash-specific syntax allowed.

### test file

Tests to write (one `test()` per scenario):

1. **Basic output** — runs with a provided name input, asserts `greeting` output is set correctly
2. **Input default** — runs without the optional input, asserts the default value is used
3. **Env seed is readable** — passes `env:` to the run call, asserts the step reads it via `$GITHUB_OUTPUT`
4. **Step-level env overrides seed** — asserts the step-level override wins for that step and the seed is restored in the next
5. **GITHUB_ENV threads between steps** — a value written in step N is readable as an env var in step N+1
6. **GITHUB_PATH prepends to PATH** — a path added in one step is present in `$PATH` in the next
7. **working-directory** — asserts `$PWD` inside the step matches the configured subdirectory
8. **continue-on-error** — a failing step with `continue-on-error: true` does not fail the action; `toHaveStepSucceeded` passes
9. **if: failure() runs on failure** — trigger a failure via the input flag, assert the failure handler step ran and the always step ran
10. **if: always() always runs** — assert `always-runs` step ran in both the success and failure paths
11. **Warning annotation** — assert `toHaveAnnotation({ level: 'warning', ... })` on the result
12. **Error annotation on failure** — trigger failure, assert the error annotation appears

---

## Part 2 — sh coverage

### Mechanism

Zero external dependencies. Works by prepending a trace header to the script that uses `set -x` and a custom `PS4` to emit a parseable marker for each executed line number to stderr.

Header to prepend:
```sh
PS4='::COVERED::${LINENO}::'
export PS4
set -x
```

After execution, parse the stderr for lines matching `::COVERED::N::` (where N is a line number). Build a `Record<number, number>` mapping line number to hit count. Line numbers in the map are relative to the **original** script (before prepending the header), so subtract the header line count from each parsed line number.

Coverage metric produced: **line coverage** only (no branch coverage — sh has no reliable branch instrumentation without external tools).

### Packages to change

#### `packages/shell`

- `ShellSandboxOptions`: add optional `coverage?: boolean`
- `ShellSandboxResult`: add optional `shellCoverage?: { lineHits: Record<number, number> }`
- `shell-sandbox.ts`: when `coverage: true` and shell is `sh` or `bash`, prepend the trace header to the script, parse stderr for `::COVERED::N::` markers after the process exits, populate `shellCoverage` in the result
- New file `src/sh-coverage.ts`: exports `parseShCoverage(stderr: string, headerLineCount: number): Record<number, number>` — strips the header offset from line numbers and counts hits

#### `packages/core`

- `step-runner.ts`: when a `run:` step completes, attach `result.shellCoverage` to the `StepResult` (new optional field)
- `ExecutionResult` (in `executor-registry.ts`): add optional `shellCoverage?: Array<{ path: string; lineHits: Record<number, number> }>` to carry shell coverage up from composite executor runs

#### `packages/types`

- `StepResult`: add optional `shellCoverage?: { lineHits: Record<number, number> }`

#### `packages/coverage`

- New file `src/sh-coverage.ts`: `buildShStats(lineHits: Record<number, number>, source: string)` — reads the source file, counts total executable lines (non-blank, non-comment), returns `{ lines: CoverageStat }`. No statement/branch/function stats.
- `collector.ts`: accumulate `shellCoverage` entries keyed by script path (the `scriptPath` written to the temp file maps back to the fixture action dir — needs a stable path strategy); include `shShellLines` in `FileCoverage` and aggregate totals
- `types.ts`: add `shShellLines?: CoverageStat` to `FileCoverage` and to the `CoverageMetric` union
- `text-reporter.ts` and `html-reporter.ts`: render the new `shShellLines` column in the JS-file table (or a new "Shell files" section)

### Open question

The temp file path used by `ShellSandbox` is ephemeral. To map coverage back to the fixture source file, the sandbox needs to receive the canonical source path (e.g., the `run:` step script as written in the action) or coverage needs to be keyed by step id + action path instead of file path. Decide this before implementing.
