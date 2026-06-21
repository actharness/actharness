# Session: uncovered lines column in all summary tables

## What this session should deliver

Add an **Uncovered Lines** column to every summary table in both the HTML index and the text report:

| Table | Lines shown |
| ----- | ----------- |
| Action YML Files | YAML line numbers of `run:` script lines with 0 hits (all shell types combined) |
| JS Coverage | JS file line numbers where any Istanbul statement has count = 0 |
| Python Shell Coverage | Script line numbers from `pythonCoverageData.missingLines` |
| Node Shell Coverage | Script line numbers where any Istanbul statement has count = 0 |

Format: compact ranges, e.g. `3–5, 12, 18–20`. Empty cell if everything is covered.

---

## Project overview

**actharness** — a GitHub Actions unit testing framework. Monorepo at `/Users/stefanobassan/Projects/theobassan/actspec/`.

Key packages:

| Package | Role |
| ------- | ---- |
| `packages/coverage` | Coverage collector, types, HTML + text reporters |
| `packages/types` | Shared types including `PythonCoverageData` |

---

## Current state

The HTML index (`buildIndexHtml` in `packages/coverage/src/html-reporter.ts`) already shows four summary tables with stats (covered/total/pct) but no uncovered line numbers. The text reporter (`buildTextReport` in `packages/coverage/src/text-reporter.ts`) has the same four sections.

### Data already available — no collection changes needed for these

**JS files:** `JsFileCoverage.istanbulData` (`JsIstanbulData`) is already stored on each entry. Uncovered lines = unique `loc.start.line` values from `statementMap` entries where `s[id] === 0`. Compute at render time.

**Python Shell steps:** `PyFileCoverage.pythonCoverageData` is already stored. `pythonCoverageData.missingLines: number[]` is exactly the uncovered script line numbers. Use directly at render time.

### Data that needs one new field

**Node Shell steps:** `NodeShFileCoverage` currently has only aggregate stats. The Istanbul result `d` (`JsIstanbulData`) is available in `toCoverageReport` at the point where `nodeShellFiles[key]` is built. Add `uncoveredLines: number[]` to `NodeShFileCoverage` and populate it there.

### Data computed at render time from the YAML source

**Action YML files:** Uncovered YAML line numbers come from the same maps already built inside `buildFileHtml` (`lineShPwshCoverage` for sh/pwsh/py, `lineNodeShAnnotated` for node shell). Extract this logic into a shared helper `_computeUncoveredYamlRunLines(fc, source, lines, steps)` that both `buildFileHtml` and `buildIndexHtml` can call. `buildIndexHtml` must read each action.yml file to call this helper — this is acceptable since report generation is a one-shot operation.

---

## Line range formatter

Add a pure helper `formatRanges(lines: number[]): string` to `html-reporter.ts` and `text-reporter.ts` (or a shared util). Ranges are `–` separated (`3–5`), groups are `, ` separated.

```ts
function formatRanges(lines: number[]): string {
  if (lines.length === 0) return '';
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!, end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === end + 1) { end = sorted[i]!; }
    else { ranges.push(start === end ? `${start}` : `${start}–${end}`); start = end = sorted[i]!; }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(', ');
}
```

---

## Packages to change

### 1. `packages/coverage/src/types.ts`

Add `uncoveredLines: number[]` to `NodeShFileCoverage`:

```ts
export interface NodeShFileCoverage {
  path: string;
  statements: CoverageStat;
  branches: CoverageStat;
  lines: CoverageStat;
  uncoveredLines: number[];   // ← new: script line numbers (1-based) with count = 0
}
```

No changes needed to `JsFileCoverage`, `PyFileCoverage`, or `FileCoverage`.

---

### 2. `packages/coverage/src/collector.ts`

In `toCoverageReport`, in the `nodeCoverageData` loop, at the point where `nodeShellFiles[key]` is assigned (currently around line 503), compute `uncoveredLines` from the merged Istanbul result `d`:

```ts
const uncoveredLineSet = new Set<number>();
for (const [id, loc] of Object.entries(d.statementMap)) {
  if ((d.s[id] ?? 0) === 0) uncoveredLineSet.add(loc.start.line);
}
const uncoveredLines = [...uncoveredLineSet].sort((a, b) => a - b);

nodeShellFiles[key] = {
  path: key,
  statements: rawStats.jsStatements!,
  branches: rawStats.jsBranches!,
  lines: { covered, total, pct: covered === 0 ? 0 : (covered / total) * 100 },
  uncoveredLines,
};
```

Also update `aggregateTotals` — it receives `nodeShellFiles` but only sums stats; `uncoveredLines` is per-step and does not aggregate, so no change there.

Update any test helpers in `packages/coverage/test/coverage.test.ts` that construct `NodeShFileCoverage` objects to include `uncoveredLines: []`.

---

### 3. `packages/coverage/src/html-reporter.ts`

#### Add `formatRanges` helper (pure function, no side effects)

#### Add `_computeUncoveredJsLines(d: JsIstanbulData): number[]`

```ts
function _computeUncoveredJsLines(d: JsIstanbulData): number[] {
  const s = new Set<number>();
  for (const [id, loc] of Object.entries(d.statementMap)) {
    if ((d.s[id] ?? 0) === 0) s.add(loc.start.line);
  }
  return [...s].sort((a, b) => a - b);
}
```

#### Add `_computeUncoveredYamlRunLines(fc, source, lines, steps): number[]`

Extract the zero-hit YAML line computation from `buildFileHtml` into a standalone helper. It uses `fc.shStepLineHits`, `fc.pwshStepLineHits`, `fc.pyStepLineHits`, and `fc.nodeShStepIstanbul` to build the same `lineShPwshCoverage` and `lineNodeShAnnotated` maps already computed in `buildFileHtml`, then collects YAML lines with 0 hits.

Signature:
```ts
function _computeUncoveredYamlRunLines(
  fc: FileCoverage,
  source: string,
  lines: string[],
  steps: ReturnType<typeof parseAction>['runs']['steps'],
): number[]
```

This function must NOT re-parse the source — callers pass `source` and `lines` so the file is read only once.

#### Update `buildFileHtml`

Call `_computeUncoveredYamlRunLines` with already-loaded `source`/`lines`/`steps` and display the result somewhere visible in the per-file view — e.g. a chip in the metrics bar labeled `Uncov. Lines: 3–5, 12` (red chip if non-empty, green chip if empty/zero).

#### Update `buildIndexHtml`

**Action YML Files table:** Add `<th>Uncovered Lines</th>` column. For each file:
```ts
let uncovRun = '';
try {
  const src = readFileSync(f.path, 'utf8');
  const srcLines = src.split('\n');
  const act = parseAction(f.path);
  const steps = act.runs.steps ?? [];
  uncovRun = formatRanges(_computeUncoveredYamlRunLines(f, src, srcLines, steps));
} catch { /* leave empty */ }
```

**JS Coverage table:** Add `<th>Uncovered Lines</th>`. Per row:
```ts
formatRanges(_computeUncoveredJsLines(f.istanbulData))
```

**Python Shell Coverage table:** Add `<th>Uncovered Lines</th>`. Per row:
```ts
formatRanges([...f.pythonCoverageData.missingLines].sort((a, b) => a - b))
```

**Node Shell Coverage table:** Add `<th>Uncovered Lines</th>`. Per row:
```ts
formatRanges(f.uncoveredLines)
```

The "Total" footer row in each table shows an empty cell for Uncovered Lines (totals don't have a meaningful line list).

---

### 4. `packages/coverage/src/text-reporter.ts`

Add a `COL_UNCOV` column width constant (e.g. 20 chars). Add `Uncov. Lines` as the last column in all four section headers and rows. Sources are the same as above. Truncate with `…` if the range string exceeds `COL_UNCOV`.

---

### 5. `packages/coverage/src/actharness-coverage.ts`

`_buildZeroFileCoverage` and the merge path do not touch `NodeShFileCoverage` directly, but if any test helper constructs one inline, add `uncoveredLines: []`.

---

## Test changes

### `packages/coverage/test/coverage.test.ts`

- Any test that constructs a `NodeShFileCoverage` literal or reads `report.nodeShellFiles[key]` must include/expect `uncoveredLines`.
- Add a test in the `nodeCoverageData — toCoverageReport` describe block: a step with one uncovered statement produces a non-empty `uncoveredLines` in `report.nodeShellFiles[key]`.

### `packages/coverage/test/html-reporter.test.ts`

- Update `makeEmptyReport` and any other helpers that construct `NodeShFileCoverage` to include `uncoveredLines: []`.
- Add assertions for the new `Uncovered Lines` column in the existing Node Shell and JS section tests.
- Add a test that `buildIndexHtml` shows `formatRanges` output for a file with uncovered lines.

### `packages/coverage/test/text-reporter.test.ts`

- Same pattern: update helpers, add column assertions.

---

## Key constraints

- 100% branch coverage must be maintained across all packages. `formatRanges('')` (empty input) and `formatRanges([1,2,3])` (consecutive) and `formatRanges([1,3])` (gap) must all be tested.
- `_computeUncoveredYamlRunLines` reads files at render time — it must not throw; wrap file I/O in try/catch and return `[]` on failure.
- No `v8 ignore` comments allowed.
- Redirect all test output: `npm test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt`
- Never use git commands.
- Never make architectural decisions not in this spec — ask the user first.

---

## Running tests

```bash
cd packages/coverage && npm test 2>&1 | tee /tmp/test-result.txt; cat /tmp/test-result.txt
```

Build:
```bash
npm run build 2>&1 | tee /tmp/build-result.txt; grep -E "error|Done|Failed" /tmp/build-result.txt
```
