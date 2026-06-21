# Spec: python / python3 shell support

## Goal

Add end-to-end fixture integration tests for composite actions using `shell: python` and `shell: python3`, and add statement/branch/line code coverage for Python scripts via `coverage.py`.

Both shell names are treated identically by `ShellSandbox` (same `.py` extension, same args — only the binary name differs). The fixture and coverage implementation must handle both.

---

## Part 1 — Fixture integration test

### Location

`fixtures/python/`

### action.yml

A composite action that exercises the full feature set using Python in composite steps. Use `shell: python3` as the default shell throughout. Add a second action `fixtures/python/action-python.yml` (or a second test) that uses `shell: python` to verify both binary names work. All steps use the GitHub Actions file protocol directly (no `@actions/core` — Python has no equivalent package):

- **Inputs**: one with a default, one required. Read via `os.environ['INPUT_NAME']` (actharness injects `INPUT_*` vars).
- **Outputs**: set by appending `key=value\n` to `open(os.environ['GITHUB_OUTPUT'], 'a')`
- **Env threading**: write `KEY=value\n` to `open(os.environ['GITHUB_ENV'], 'a')`; assert the value is in `os.environ` in the next step
- **`$GITHUB_PATH`**: write a path to `open(os.environ['GITHUB_PATH'], 'a')`; assert it appears in `os.environ['PATH']` in the next step
- **`if:` conditions**: success, failure, always steps
- **`continue-on-error`**: a step that calls `sys.exit(1)` but does not fail the action
- **`working-directory`**: a step that asserts `os.getcwd()` matches the subdirectory
- **Step-level `env:`**: override visible via `os.environ`
- **Annotations**: `print('::warning::message')` to stdout
- **Failure path**: a step that calls `sys.exit(1)` when an input flag is set

### test file

Tests to write (one `test()` per scenario):

1. **Basic output** — provide a name input, assert the greeting output is correct
2. **Input default** — omit the optional input, assert the default string is used
3. **Env seed readable** — pass `env:` to the run call, assert the Python step reads it via `os.environ`
4. **Step-level env override** — assert the step-level env key wins inside that step
5. **GITHUB_ENV threads between steps** — write in step N, assert readable in step N+1
6. **GITHUB_PATH prepends to PATH** — write a path in one step, assert it's in `PATH` in the next
7. **working-directory** — assert `os.getcwd()` matches the configured subdirectory
8. **continue-on-error** — `sys.exit(1)` step with `continue-on-error: true` does not fail the action
9. **if: failure() runs on failure** — trigger failure, assert failure handler ran
10. **if: always() always runs** — assert always step ran in success and failure paths
11. **Warning annotation** — assert `toHaveAnnotation({ level: 'warning', ... })`
12. **Error annotation on failure** — trigger failure, assert error annotation
13. **`shell: python` works** — run the same basic output test against a second action file that uses `shell: python` instead of `shell: python3`, asserting the binary alias is handled correctly

---

## Part 2 — python / python3 coverage

### Mechanism

Uses `coverage.py` via a **managed virtualenv** — one per binary, created lazily on first use. No user setup required; the only prerequisite is that the Python binary itself is installed (which is already required to run `shell: python` or `shell: python3` steps at all).

#### Virtualenv per binary

There are two independent venvs, keyed by binary name:

| Step shell | Venv path                  | Created with                     |
|------------|----------------------------|----------------------------------|
| `python3`  | `<pkg-dir>/.venv-python3`  | `python3 -m venv .venv-python3`  |
| `python`   | `<pkg-dir>/.venv-python`   | `python -m venv .venv-python`    |

`<pkg-dir>` is the directory of `@actharness/shell` on disk (resolved at runtime via `import.meta.url`).

On first coverage run for a given binary:

1. Check if the venv exists (`<venv>/bin/python` or `<venv>/Scripts/python.exe` on Windows).
2. If not: run `<bin> -m venv <venv-path>` then `<venv>/bin/pip install coverage --quiet`.
3. Cache the resolved venv python path in memory for the rest of the process.

If venv creation fails (e.g. `python` binary not found), fall back to running the script without coverage and emit a warning annotation: `::warning::python coverage skipped — binary not found`.

#### Coverage run

Once the venv python is resolved (call it `<venv-python>`):

1. Instead of running `<bin> script.py`, run:

   ```sh
   <venv-python> -m coverage run --branch --data-file=<tmp.coveragedata> script.py
   ```

2. After the script exits, export JSON:

   ```sh
   <venv-python> -m coverage json --data-file=<tmp.coveragedata> -o <tmp.json>
   ```

3. Read and parse `<tmp.json>`, clean up both temp files.

The `coverage.py` JSON format produces:

```json
{
  "files": {
    "/abs/path/to/script.py": {
      "executed_lines": [1, 2, 4],
      "missing_lines": [5, 6],
      "executed_branches": [[2, 4], [4, -1]],
      "missing_branches": [[2, 6]]
    }
  }
}
```

Coverage metrics produced: **statements**, **branches**, **lines**. No function-level metric (not reported by `coverage.py` JSON).

### Packages to change

#### `packages/shell`

- `ShellSandboxOptions`: add optional `coverage?: boolean`
- `ShellSandboxResult`: add optional `shellCoverage?: PythonCoverageData` where `PythonCoverageData = { executedLines: number[]; missingLines: number[]; executedBranches: [number, number][]; missingBranches: [number, number][] }`
- `shell-sandbox.ts`: when `coverage: true` and shell is `python` or `python3`:
  1. Resolve the venv python path for this binary (lazy-create if needed)
  2. Run with coverage, export JSON, parse, populate `shellCoverage`, clean up
  3. On failure: run without coverage, push warning annotation
- New file `src/python-venv.ts`: manages venv lifecycle — `resolveVenvPython(bin: 'python' | 'python3'): Promise<string>`. Handles creation, caching, and error fallback.
- New file `src/python-coverage.ts`: exports `parsePythonCoverage(json: string): PythonCoverageData` and `buildPythonStats(data: PythonCoverageData): { statements: CoverageStat; branches: CoverageStat; lines: CoverageStat }`

#### `packages/core`

- `step-runner.ts`: attach `result.shellCoverage` to `StepResult` when present
- `ExecutionResult`: add optional `shellCoverage?: Array<{ path: string; data: PythonCoverageData }>` (same pattern as `jsCoverage`)

#### `packages/types`

- `StepResult`: add optional `shellCoverage?: PythonCoverageData`

#### `packages/coverage`

- New file `src/python-coverage.ts`: `buildPythonStats(data: PythonCoverageData, source: string)` returns `{ pythonShellStatements: CoverageStat; pythonShellBranches: CoverageStat; pythonShellLines: CoverageStat; pythonCoverageData: PythonCoverageData }`
- New type `PyFileCoverage` in `types.ts`: mirrors `JsFileCoverage` — `{ path, statements, branches, lines, pythonCoverageData }`
- `collector.ts`: accumulate Python coverage entries; produce `pythonShellFiles` in `CoverageReport` (mirrors `jsFiles`)
- `types.ts`: add `pythonShellStatements`, `pythonShellBranches`, `pythonShellLines` to `CoverageMetric`; add `pythonShellFiles` to `CoverageReport`
- `text-reporter.ts` and `html-reporter.ts`: render a "Python files" section analogous to "JS files"

### Open question

Same as sh: temp script path is ephemeral. The `coverage.py` JSON will contain the temp path as the key. Either pass the canonical action-relative path into the sandbox so it can be used as the stable key, or remap after the fact. Decide before implementing — ideally the same solution is applied to all three shell coverage types at once.
