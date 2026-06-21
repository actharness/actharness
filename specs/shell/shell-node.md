# Spec: node shell support

## Goal

Add end-to-end fixture integration tests for composite actions using `shell: node`, and add V8 line coverage for inline Node.js scripts by reusing the `packages/node` sandbox infrastructure.

---

## Part 1 — Fixture integration test

### Location

`fixtures/node-shell/`

### action.yml

A composite action that exercises the full feature set using `shell: node` throughout. No `@actions/core` — use the file protocol directly:

- **Inputs**: one with a default, one required. Read via `process.env['INPUT_NAME']` (upper-cased, hyphens → underscores).
- **Outputs**: `fs.appendFileSync(process.env.GITHUB_OUTPUT, 'key=value\n')`
- **Env threading**: write `KEY=value\n` to `process.env.GITHUB_ENV` file; assert readable in next step
- **`$GITHUB_PATH`**: append a path to `process.env.GITHUB_PATH` file; assert it appears in `process.env.PATH` in next step
- **`if:` conditions**: success, failure, always steps
- **`continue-on-error`**: a step that calls `process.exit(1)` with `continue-on-error: true`
- **`working-directory`**: assert `process.cwd()` matches the subdirectory
- **Step-level `env:`**: assert the step-level env key wins inside that step
- **Annotations**: `process.stdout.write('::warning::message\n')`
- **Failure path**: `process.exit(1)` when an input flag is set

### test file

Same test cases as `fixtures/python/` — same breadth, adapted for Node.js syntax.

---

## Part 2 — V8 line coverage

### Mechanism

Reuse `packages/node`'s existing V8 coverage infrastructure (`sandbox-bootstrap.mjs` + inspector API) instead of spawning `node scriptPath` directly.

Add a new function to `packages/node`:

```typescript
// packages/node/src/shell-node-sandbox.ts
export async function runShellNode(
  scriptPath: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; lineHits: Record<number, number> }>
```

This forks `sandbox-bootstrap.mjs` with `entrypoint = scriptPath`, empty mocks. The bootstrap's existing filter (`filePath.startsWith(actionDir)` where `actionDir = dirname(scriptPath)`) captures the script — no bootstrap changes needed.

### V8 → lineHits conversion

The V8 entry for the script has `functions[].ranges[]` with `{ startOffset, endOffset, count }` (character offsets). Convert to `Record<number, number>` (1-based script line → hit count):

1. Read the script source.
2. Build `lineStarts: number[]` — character offset of the start of each line.
3. For each range: find the line whose start ≤ `startOffset`; accumulate `count` into `lineHits[lineNum]`.
4. Lines not covered by any range: `lineHits[lineNum] ??= 0`.

### Data flow

`runShellNode` returns `{ lineHits }`. `ShellSandbox.shell()` sets `result.shellCoverage = { lineHits }` — the same union branch as sh/pwsh. No new types needed in `packages/types` or `packages/core`.

### Coverage collector

`shell: node` steps route to a dedicated map `_nodeShCoverageData` (not `_shShellCoverageData`) so the HTML reporter can style them independently. The map follows the exact same pattern as `_shShellCoverageData` throughout: listener, `toFragment`, `fromParts`, `merge`, `reset`, `toCoverageReport`.

- `CoverageFragment`: add `nodeShCoverageEntries?: ShShellCoverageEntry[]`
- `FileCoverage`: add `nodeShellLines?: CoverageStat`, `nodeShStepLineHits?: Record<string, Record<number, number>>`
- `CoverageMetric`: add `'nodeShellLines'`

### HTML reporter

Extend the YAML-line → hit-count lookup to include `nodeShStepLineHits`:

```typescript
const hits = fc.shStepLineHits?.[stepId]
  ?? fc.pwshStepLineHits?.[stepId]
  ?? fc.pyStepLineHits?.[stepId]
  ?? fc.nodeShStepLineHits?.[stepId];
```

---

## Packages to change (in order)

| # | Package | Change |
|---|---------|--------|
| 1 | `packages/node` | New `shell-node-sandbox.ts` — `runShellNode`; export from `index.ts` |
| 2 | `packages/shell` | `shell-sandbox.ts`: when `coverage: true` and `shell: node`, call `runShellNode` |
| 3 | `packages/coverage` | `types.ts`: add `nodeShellLines`, `nodeShStepLineHits`, `nodeShCoverageEntries`; `collector.ts`: add `_nodeShCoverageData`; `html-reporter.ts`: extend hits lookup |
| 4 | `fixtures/node-shell/` | `action.yml` + `node-shell.test.ts` |

---

## What already exists — do not redo

- `buildShellArgv` already handles `shell: node` (`.js` extension, `node scriptPath`)
- `ShellSandboxResult.shellCoverage` already has the `{ lineHits }` branch
- `ExecutionResult.shellCoverage` array element type already has `{ path, lineHits }`
- `composite-executor.ts` already pushes `{ path: key, lineHits }` for the `lineHits` branch
- `sandbox-bootstrap.mjs` V8 filter works for temp scripts without modification
- `ShShellCoverageEntry`, `buildShStats` pattern — reuse as the model for `buildNodeShStats`
