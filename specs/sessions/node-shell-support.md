# Session: implement node shell support

## What this session should deliver

1. `fixtures/node-shell/` — integration fixture for `shell: node` composite action steps (same breadth as `fixtures/python/`)
2. V8 line coverage for `shell: node` steps, wired end-to-end through the stack, annotated in HTML

Start with the fixture. Get all tests green. Then tackle coverage.

---

## Project overview

**actharness** — a GitHub Actions unit testing framework. Users write `.test.ts` files that call `actharness('./action.yml').run({ inputs, env, ... })` and make assertions on the result. The monorepo lives at `/Users/stefanobassan/Projects/theobassan/actspec/`.

Key packages:

| Package | Role |
| ------- | ---- |
| `packages/shell` | `ShellSandbox` — spawns child processes for composite `run:` steps |
| `packages/node` | `runInSandbox` — forks a child process, collects V8 coverage via inspector API |
| `packages/core` | `step-runner.ts` — composite step loop; `executor-registry.ts` — `ExecutionResult` type |
| `packages/types` | Shared types: `StepResult`, `ActharnessOptions`, etc. |
| `packages/composite` | Composite action executor — calls `step-runner` |
| `packages/coverage` | Coverage collector, reporters |
| `packages/cli` | Test runner — wires everything together |
| `fixtures/` | Integration fixture tests — each is a real `action.yml` + a `.test.ts` |

---

## Current state of `shell: node`

`ShellSandbox` in `packages/shell/src/shell-sandbox.ts` already handles `shell: node` — it writes the script to a `.js` file and spawns `node scriptPath` directly. There is no fixture and no coverage.

`packages/node/src/js-sandbox.ts` (`runInSandbox`) already forks `sandbox-bootstrap.mjs`, which enables V8 precise coverage via the inspector API (`Profiler.startPreciseCoverage` with `callCount: true, detailed: true`), then sends raw coverage data back over IPC as `{ path, v8Data }` entries.

---

## Spec

Full spec is at `specs/shell/shell-node.md`. Key points below.

### Part 1 — fixture

Location: `fixtures/node-shell/`

Two files: `action.yml` (uses `shell: node`). Look at `fixtures/python/` for the exact API shape and assertion style.

The `action.yml` must exercise:

- **Inputs**: one with a default, one required. Read via `process.env['INPUT_<NAME>']` (upper-cased, hyphens → underscores).
- **Outputs**: write `key=value\n` to `fs.appendFileSync(process.env.GITHUB_OUTPUT, ...)`
- **Env threading**: write `KEY=value\n` to `process.env.GITHUB_ENV` file; assert in next step
- **`$GITHUB_PATH`**: append a path to `process.env.GITHUB_PATH` file; assert it appears in `process.env.PATH` in next step
- **`if:` conditions**: success, failure, always steps
- **`continue-on-error`**: a step that calls `process.exit(1)` with `continue-on-error: true`
- **`working-directory`**: assert `process.cwd()` matches the subdirectory
- **Step-level `env:`**: assert the step-level env key wins
- **Annotations**: `process.stdout.write('::warning::message\n')`
- **Failure path**: `process.exit(1)` when an input flag is set

Same number of tests as the python fixture.

### Part 2 — coverage

#### Mechanism

Reuse the `packages/node` V8 coverage infrastructure. `ShellSandbox` (when `coverage: true` and `shell: node`) must **not** spawn `node scriptPath` directly. Instead it calls a new lightweight function exported from `packages/node`:

```typescript
// packages/node/src/shell-node-sandbox.ts (new file)
export async function runShellNode(
  scriptPath: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; lineHits: Record<number, number> }>
```

This function forks `sandbox-bootstrap.mjs` (reused as-is) with:

- `entrypoint`: the temp `.js` script path
- `env`: the step env
- no mocks (empty `apiMocks: []`, `networkMocks: []`)

#### V8 → lineHits conversion

`sandbox-bootstrap.mjs` filters coverage entries by `filePath.startsWith(actionDir)` where `actionDir = path.dirname(initData.entrypoint)`. For a temp script at `/tmp/actharness-script-XXXX/script.js`, `actionDir` = `/tmp/actharness-script-XXXX/` — so the script itself **is** captured. No change to the bootstrap needed.

The raw V8 entry for the script has `v8Data.functions[].ranges[]` with `{ startOffset, endOffset, count }` (character offsets into the source file). Convert to `lineHits: Record<number, number>` (1-based script line number → total hit count) inside `runShellNode`:

1. Read the script file source.
2. Build a `lineStarts: number[]` — character offset of the start of each line (line 1 starts at offset 0).
3. For each range `{ startOffset, endOffset, count }`:
   - Find the line number whose start offset ≤ `startOffset` (binary search or linear scan).
   - Accumulate `count` into `lineHits[lineNum]`.
4. For any script line not touched by any range: `lineHits[lineNum] ??= 0`.

This gives the same `Record<number, number>` shape that sh/pwsh produce.

#### Data flow

`runShellNode` returns `lineHits`. `ShellSandbox.shell()` sets:

```typescript
result.shellCoverage = { lineHits };
```

This is the **same union branch** as sh/pwsh — no new types needed in `packages/types` or `packages/core`.

#### Composite executor

`composite-executor.ts` already pushes `{ path: key, lineHits }` for the `lineHits` branch. The existing path handles `shell: node` automatically once `ShellSandbox` returns `{ lineHits }`.

#### Coverage collector

`shell: node` steps must **not** share `_shShellCoverageData` or `_pwshShellCoverageData` — they get a dedicated map so the HTML reporter can style them independently:

- New private field: `_nodeShCoverageData: Map<string, Record<number, number>>`
- In the listener: detect `shell: node` (same `step.shell` check already done for sh vs pwsh) and route to `_nodeShCoverageData`
- `toFragment` / `fromParts` / `merge` / `reset`: follow the exact same pattern as `_shShellCoverageData`
- `CoverageFragment`: add `nodeShCoverageEntries?: ShShellCoverageEntry[]`
- `CoverageReport` / `FileCoverage`: add `nodeShStepLineHits?: Record<string, Record<number, number>>`
- `buildNodeShStats` (new helper): same shape as `buildShStats`
- `CoverageMetric`: add `'nodeShellLines'`

#### HTML reporter

In `buildLineShPwshCoverage` (the function that builds the YAML-line → hit-count map), extend the lookup:

```typescript
const hits = fc.shStepLineHits?.[stepId]
  ?? fc.pwshStepLineHits?.[stepId]
  ?? fc.pyStepLineHits?.[stepId]
  ?? fc.nodeShStepLineHits?.[stepId];
```

---

## Key constraint

`sandbox-bootstrap.mjs` currently filters V8 coverage to `filePath.startsWith(actionDir)`. For a temp script, `actionDir = path.dirname(scriptPath)` — a fresh temp dir every run. The script is the only file in that dir, so the filter works correctly. No changes to the bootstrap.

---

## Packages to change (in order)

### 1. `packages/node/src/shell-node-sandbox.ts` (new file)

- `runShellNode(scriptPath, env, cwd)` — forks bootstrap, collects V8 entry for the script, converts ranges → `lineHits`, cleans up the temp dir.

### 2. `packages/node/src/index.ts`

- Export `runShellNode` and its return type.

### 3. `packages/shell/src/shell-sandbox.ts`

- When `coverage: true` and `shell: node`: call `runShellNode` instead of `spawnAndCapture`; set `result.shellCoverage = { lineHits }`.

### 4. `packages/coverage/src/types.ts`

- Add `nodeShellLines?: CoverageStat` to `FileCoverage`
- Add `nodeShStepLineHits?: Record<string, Record<number, number>>` to `FileCoverage`
- Add `'nodeShellLines'` to `CoverageMetric`

### 5. `packages/coverage/src/collector.ts`

- Add `_nodeShCoverageData` field; wire into listener, `toFragment`, `fromParts`, `merge`, `reset`, `toCoverageReport`
- `CoverageFragment`: add `nodeShCoverageEntries?: ShShellCoverageEntry[]`

### 6. `packages/coverage/src/html-reporter.ts`

- Extend hits lookup to include `nodeShStepLineHits`

### 7. `fixtures/node-shell/` (new)

- `action.yml` + `node-shell.test.ts`

---

## What already exists — do not redo

- `buildShellArgv` already handles `shell: node` (writes `.js`, spawns `node scriptPath`)
- `ShellSandboxResult.shellCoverage` union already has the `{ lineHits }` branch
- `ExecutionResult.shellCoverage` array element type already has `{ path, lineHits }`
- `composite-executor.ts` already pushes `{ path: key, lineHits }` entries
- The `ShShellCoverageEntry` type, `CoverageFragment` fields pattern, and all `merge`/`fromParts`/`toFragment` boilerplate follow the sh/pwsh model exactly

---

## Running tests

```bash
npm test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
```

Or per-package:

```bash
pnpm --filter='./packages/node' test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
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
