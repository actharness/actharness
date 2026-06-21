# Session: implement python shell support

## What this session should deliver

1. `fixtures/python/` — full integration fixture test for `shell: python3` and `shell: python` composite actions (13 tests)
2. `python` coverage — statement/branch/line coverage via `coverage.py`, wired end-to-end through the stack

Start with the fixture. Get all 13 tests green. Then tackle coverage.

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
| `packages/coverage` | Coverage collector, reporters, `sh-coverage.ts` / `pwsh-coverage.ts` (models for python coverage) |
| `packages/cli` | Test runner — wires everything together |
| `fixtures/` | Integration fixture tests — each is a real `action.yml` + a `.test.ts` |

---

## Current state of python support

`ShellSandbox` in `packages/shell/src/shell-sandbox.ts` already handles `python` and `python3` — it uses `.py` extension and spawns `python`/`python3` directly with the script path as the sole argument. There is no fixture integration test and no coverage yet.

---

## Spec

Full spec is at `specs/shell/shell-python.md`. Key points below.

### Part 1 — fixture

Location: `fixtures/python/`

Two files: `action.yml` (uses `shell: python3`) and `action-python.yml` (identical but uses `shell: python`). Look at `fixtures/sh/sh.test.ts` and `fixtures/pwsh/pwsh.test.ts` for the exact API shape and assertion style to follow.

The `action.yml` must exercise (using plain Python — no `@actions/core` equivalent):
- **Inputs**: one with a default, one required. Read via `os.environ['INPUT_<NAME>']`
- **Outputs**: write `key=value\n` to `open(os.environ['GITHUB_OUTPUT'], 'a')`
- **Env threading**: write `KEY=value\n` to `open(os.environ['GITHUB_ENV'], 'a')`; assert in next step
- **`$GITHUB_PATH`**: write a path to `open(os.environ['GITHUB_PATH'], 'a')`; assert in `os.environ['PATH']` in next step
- **`if:` conditions**: success, failure, always steps
- **`continue-on-error`**: a step that calls `sys.exit(1)` with `continue-on-error: true`
- **`working-directory`**: assert `os.getcwd()` matches the subdirectory
- **Step-level `env:`**: assert the step-level env key wins
- **Annotations**: `print('::warning::message')` to stdout
- **Failure path**: `sys.exit(1)` when an input flag is set

13 tests:
1. Basic output — provide name input, assert greeting output
2. Input default — omit optional input, assert default
3. Env seed readable — pass `env:` to run call, assert Python step reads it
4. Step-level env override — assert step-level key wins
5. GITHUB_ENV threads between steps
6. GITHUB_PATH prepends to PATH
7. working-directory — assert `os.getcwd()` matches subdirectory
8. continue-on-error — `sys.exit(1)` does not fail the action
9. `if: failure()` runs on failure
10. `if: always()` always runs
11. Warning annotation
12. Error annotation on failure
13. `shell: python` works — run basic output test against `action-python.yml`

### Part 2 — coverage

**Mechanism**: `coverage.py` via a managed virtualenv — one per binary, created lazily on first use. No user setup required beyond the Python binary being installed.

#### Virtualenv per binary

| Step shell | Venv path                  | Created with                     |
|------------|----------------------------|----------------------------------|
| `python3`  | `<pkg-dir>/.venv-python3`  | `python3 -m venv .venv-python3`  |
| `python`   | `<pkg-dir>/.venv-python`   | `python -m venv .venv-python`    |

`<pkg-dir>` is the directory of `@actharness/shell` on disk (resolved at runtime via `import.meta.url`).

On first coverage run for a given binary:
1. Check if `<venv>/bin/python` (or `<venv>/Scripts/python.exe` on Windows) exists.
2. If not: run `<bin> -m venv <venv-path>` then `<venv>/bin/pip install coverage --quiet`.
3. Cache the resolved venv python path in memory for the rest of the process.

If venv creation fails, fall back to running the script without coverage and emit a warning annotation: `::warning::python coverage skipped — binary not found`.

#### Coverage run

Once the venv python is resolved (call it `<venv-python>`):
1. Run: `<venv-python> -m coverage run --branch --data-file=<tmp.coveragedata> script.py`
2. Export JSON: `<venv-python> -m coverage json --data-file=<tmp.coveragedata> -o <tmp.json>`
3. Read and parse `<tmp.json>`, clean up both temp files.

The JSON format from `coverage.py`:
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

Coverage metrics produced: **pythonShellStatements**, **pythonShellBranches**, **pythonShellLines**. No function metric (not reported by `coverage.py` JSON).

---

## What already exists — do not redo

- `shell-sandbox.ts` already handles `python`/`python3` binary dispatch (lines 32–34) and `.py` extension (lines 51–52)
- `ShellSandboxOptions.coverage?: boolean` already exists (used by sh/pwsh)
- `ShellSandboxResult.shellCoverage?: { lineHits: Record<number, number> }` exists but carries sh/pwsh line hits — **Python coverage is structurally different** (statements + branches + lines, not just line hits). The result type needs extension.
- `ExecutionResult.shellCoverage?: Array<{ path: string; lineHits: Record<number, number> }>` in `packages/core/src/executor-registry.ts` — similarly needs extension for Python's richer data.

---

## Packages to change (in order)

### 1. `packages/shell/src/python-venv.ts` (new file)
- `resolveVenvPython(bin: 'python' | 'python3'): Promise<string>` — lazy-creates and caches the venv python path
- Handles Windows path (`Scripts/python.exe`) vs Unix (`bin/python`)
- On creation failure: throws so `shell-sandbox.ts` can catch and fall back

### 2. `packages/shell/src/python-coverage.ts` (new file)
- Export type: `PythonCoverageData = { executedLines: number[]; missingLines: number[]; executedBranches: [number, number][]; missingBranches: [number, number][] }`
- `parsePythonCoverageJson(json: string, scriptPath: string): PythonCoverageData` — reads the single-file entry from `coverage.py` JSON

### 3. `packages/shell/src/shell-sandbox.ts`
- Add `PythonCoverageData` to `ShellSandboxResult.shellCoverage` union: `{ lineHits: Record<number, number> } | { pythonCoverageData: PythonCoverageData }`
- When `coverage: true` and shell is `python`/`python3`:
  1. Resolve venv python (catch failure → fall back, push warning annotation to stdout)
  2. Run with `coverage run --branch`, then `coverage json`, parse JSON, populate `shellCoverage: { pythonCoverageData }`
  3. Clean up both temp files

### 4. `packages/core/src/executor-registry.ts`
- `ExecutionResult.shellCoverage` needs to carry Python data alongside sh/pwsh. Extend the array element type: `{ path: string; lineHits: Record<number, number> } | { path: string; pythonCoverageData: PythonCoverageData }`

### 5. `packages/types/src/index.ts`
- `StepResult.shellCoverage` needs to carry `PythonCoverageData` alongside `{ lineHits }`: `{ lineHits: Record<number, number> } | { pythonCoverageData: PythonCoverageData }`

### 6. `packages/coverage/src/python-coverage.ts` (new file)
- Import `PythonCoverageData` from `@actharness/shell`
- `buildPythonStats(data: PythonCoverageData): { pythonShellStatements: CoverageStat; pythonShellBranches: CoverageStat; pythonShellLines: CoverageStat }`

### 7. `packages/coverage/src/types.ts`
- Add `'pythonShellStatements' | 'pythonShellBranches' | 'pythonShellLines'` to `CoverageMetric`
- Add `PyFileCoverage` interface: `{ path: string; statements: CoverageStat; branches: CoverageStat; lines: CoverageStat; pythonCoverageData: PythonCoverageData }`
- Add `pythonShellFiles: Record<string, PyFileCoverage>` to `CoverageReport`

### 8. `packages/coverage/src/collector.ts`
- Add `_pythonShellCoverageData: Map<string, PythonCoverageData>` (keyed by `<actionFilePath>#<stepId>`)
- Accumulate entries from `meta.shellCoverage` (same as sh/pwsh)
- In `toCoverageReport()`: build `pythonShellFiles` by running `buildPythonStats` per unique Python source file (aggregate across steps by merging executed/missing sets)

### 9. `packages/coverage/src/text-reporter.ts`
- Render a "Python files" section analogous to the JS files section, showing `pythonShellStatements`, `pythonShellBranches`, `pythonShellLines` per file

### 10. `packages/coverage/src/html-reporter.ts`
- Render a "Python files" section analogous to the JS files section

### 11. `docs/API.md`
- Add `pythonShellStatements`, `pythonShellBranches`, `pythonShellLines` to `CoverageMetric`
- Add `PyFileCoverage` interface
- Add `pythonShellFiles` to `CoverageReport`
- Add `pythonShellStatements?`, `pythonShellBranches?`, `pythonShellLines?` to `FileCoverage` (or note they live in `pythonShellFiles`)

---

## Key architectural decision to resolve before implementing coverage

The `coverage.py` JSON keys the result by the **temp script path** (ephemeral, changes every run). The existing sh/pwsh solution avoids this by passing the canonical key (`<actionFilePath>#<stepId>`) into the sandbox via `ShellSandboxOptions` and attaching it in `step-runner.ts`. Confirm this same pattern will be used for Python before writing any coverage code.

---

## How sh coverage works (use as the model)

- `packages/shell/src/sh-coverage.ts` — parses `::COVERED::N::` markers from stderr
- `packages/shell/src/shell-sandbox.ts` — prepends 3-line header, calls `parseShCoverage` on exit
- `packages/coverage/src/sh-coverage.ts` — `buildShStats` counts executable lines
- `packages/coverage/src/collector.ts` — `_shShellCoverageData` map, `toCoverageReport()` sh loop
- `packages/coverage/src/types.ts` — `shShellLines` in `FileCoverage` and `CoverageMetric`

Follow the same data-flow pattern: sandbox → step result → execution result → collector → stats.

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
- No `v8 ignore` comments are allowed in this library
- Redirect all npm/test output to a file (as shown above) — never pipe directly to tail
