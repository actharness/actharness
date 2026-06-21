# Spec: pwsh shell support

## Goal

Add end-to-end fixture integration tests for composite actions using `shell: pwsh`, and add line-level code coverage for PowerShell scripts via `Set-PSDebug -Trace 2`.

---

## Part 1 — Fixture integration test

### Location

`fixtures/pwsh/`

### action.yml

A composite action that exercises the full feature set using PowerShell (`shell: pwsh`). Inputs are read via `$Env:INPUT_NAME`. Protocol files are written using `Add-Content`:

- **Inputs**: one with a default, one required. Read via `$Env:INPUT_<NAME>` (uppercased, hyphens become underscores per GitHub Actions convention).
- **Outputs**: set by `Add-Content -Path $Env:GITHUB_OUTPUT -Value 'key=value'`
- **Env threading**: write `KEY=value` to `$Env:GITHUB_ENV`; assert the value is in `$Env:KEY` in the next step
- **`$GITHUB_PATH`**: write a path to `$Env:GITHUB_PATH`; assert it appears in `$Env:PATH` in the next step
- **`if:` conditions**: success, failure, always steps
- **`continue-on-error`**: a step that calls `exit 1` but does not fail the action
- **`working-directory`**: a step that asserts `(Get-Location).Path` matches the subdirectory
- **Step-level `env:`**: override visible via `$Env:KEY`
- **Annotations**: `Write-Output '::warning::message'` to stdout
- **Failure path**: a step that calls `exit 1` when an input flag is set

### test file

Tests to write (one `test()` per scenario):

1. **Basic output** — provide a name input, assert the greeting output is correct
2. **Input default** — omit the optional input, assert the default string is used
3. **Env seed readable** — pass `env:` to the run call, assert the PowerShell step reads it via `$Env:`
4. **Step-level env override** — assert the step-level env key wins inside that step
5. **GITHUB_ENV threads between steps** — write in step N, assert readable in step N+1
6. **GITHUB_PATH prepends to PATH** — write a path in one step, assert it's in `PATH` in the next
7. **working-directory** — assert `(Get-Location).Path` matches the configured subdirectory
8. **continue-on-error** — `exit 1` step with `continue-on-error: true` does not fail the action
9. **if: failure() runs on failure** — trigger failure via input flag, assert failure handler ran and always step ran
10. **if: always() always runs** — assert always step ran in both success and failure paths
11. **Warning annotation** — assert `toHaveAnnotation({ level: 'warning', ... })`
12. **Error annotation on failure** — trigger failure, assert error annotation

---

## Part 2 — pwsh coverage

### Mechanism

Zero external dependencies. Uses PowerShell's built-in `Set-PSDebug -Trace 2` which writes a `DEBUG:` line to stderr for every statement executed, including the line number.

When coverage is enabled for a `pwsh` step:

1. Prepend `Set-PSDebug -Trace 2` as the first line of the script before writing it to the temp `.ps1` file.
2. Run the script normally.
3. Parse stderr for lines matching the pattern: `DEBUG:\s+(\d+)\+`
4. The captured number is the line number in the **modified** script (with the prepended line). Subtract 1 to get the line number in the **original** script.
5. Count hits per line number to build `Record<number, number>`.

Example stderr output from `Set-PSDebug -Trace 2`:
```
DEBUG:    1+  >>>> $x = 1
DEBUG:    2+ if ($x -eq 1) {  >>>> Write-Output 'yes' }
DEBUG:    2+ if ($x -eq 1) { Write-Output 'yes'  >>>> }
```

Line 2 appears twice because PowerShell traces each token on the line separately. Count each occurrence as one additional hit for that line (or deduplicate per-statement — decide during implementation).

Coverage metric produced: **line coverage** only. `Set-PSDebug -Trace 2` does not provide branch-level instrumentation. Branch coverage would require AST analysis (out of scope for now).

### Packages to change

#### `packages/shell`

- `ShellSandboxOptions`: add optional `coverage?: boolean`
- `ShellSandboxResult`: add optional `shellCoverage?: { lineHits: Record<number, number> }`
- `shell-sandbox.ts`: when `coverage: true` and shell is `pwsh` or `powershell`:
  1. Prepend `Set-PSDebug -Trace 2\n` to the script
  2. After execution, parse stderr for `DEBUG:\s+(\d+)\+` and build `lineHits` with the 1-line offset applied
  3. Populate `shellCoverage` in the result
- New file `src/pwsh-coverage.ts`: exports `parsePwshCoverage(stderr: string, headerLineCount: number): Record<number, number>`

#### `packages/core`

- `step-runner.ts`: attach `result.shellCoverage` to `StepResult` when present
- `ExecutionResult`: add optional `shellCoverage` array (same pattern as sh)

#### `packages/types`

- `StepResult`: add optional `shellCoverage?: { lineHits: Record<number, number> }`

#### `packages/coverage`

- New file `src/pwsh-coverage.ts`: `buildPwshStats(lineHits: Record<number, number>, source: string)` — counts total executable lines (non-blank, non-comment, comments start with `#`), returns `{ lines: CoverageStat }`
- `collector.ts`: accumulate pwsh coverage entries; include `pwshShellLines` in a "Shell files" section of the report
- `types.ts`: add `pwshShellLines?: CoverageStat` to `FileCoverage`; add `pwshShellLines` to `CoverageMetric`
- `text-reporter.ts` and `html-reporter.ts`: render pwsh line coverage alongside sh line coverage (can share a "Shell files" table)

### Open question

Same path-stability question as sh and python3: the temp `.ps1` file path is ephemeral. Coverage data needs to be keyed by a stable identifier (action path + step id) rather than the temp file path. Decide before implementing — ideally the same solution is applied to all three shell coverage types at once.

### Note on Windows

`shell: pwsh` is available cross-platform (PowerShell 7+). The fixture and coverage implementation must run on macOS and Linux CI, not only Windows. `Set-PSDebug -Trace 2` behaves the same on all platforms.
