// JS coverage: converts raw V8 inspector data to Istanbul CoverageStat objects.
// v8-to-istanbul does the heavy lifting; we read source files synchronously to avoid
// making the caller deal with nested async chains.

import { readFileSync } from 'node:fs';
import v8ToIstanbul from 'v8-to-istanbul';
import istanbulLibCoverage from 'istanbul-lib-coverage';
const { createFileCoverage } = istanbulLibCoverage;
import type { JsCoverageEntry } from './collector.js';
import type { CoverageStat, JsIstanbulData } from './types.js';

interface V8FunctionCoverage {
  functionName: string;
  isBlockCoverage: boolean;
  ranges: { startOffset: number; endOffset: number; count: number }[];
}

interface V8ScriptCoverage {
  functions: V8FunctionCoverage[];
}

function statOf(counts: number[]): CoverageStat {
  const total = counts.length;
  const covered = counts.filter((c) => c > 0).length;
  return { covered, total, pct: total === 0 ? 0 : (covered / total) * 100 };
}

/**
 * Groups JsCoverageEntry items by their source path.
 * Returns Map<path, entries[]> — callers pass the per-path array to buildJsStats.
 */
export function mergeJsCoverage(entries: JsCoverageEntry[]): Map<string, JsCoverageEntry[]> {
  const byPath = new Map<string, JsCoverageEntry[]>();
  for (const entry of entries) {
    const existing = byPath.get(entry.path);
    if (existing) {
      existing.push(entry);
    } else {
      byPath.set(entry.path, [entry]);
    }
  }
  return byPath;
}

/** Returns zeroed JS coverage stats (used for zero-fill when no node action ran). */
export function emptyJsStats(): {
  jsStatements: CoverageStat;
  jsBranches: CoverageStat;
  jsFunctions: CoverageStat;
  jsLines: CoverageStat;
} {
  const zero = { covered: 0, total: 0, pct: 0 };
  return { jsStatements: zero, jsBranches: zero, jsFunctions: zero, jsLines: zero };
}

/**
 * Converts merged V8 coverage entries for one source file to Istanbul CoverageStat objects.
 * Returns a partial object — only keys with data are included (callers spread the result).
 */
export async function buildJsStats(entries: JsCoverageEntry[]): Promise<{
  jsStatements?: CoverageStat;
  jsBranches?: CoverageStat;
  jsFunctions?: CoverageStat;
  jsLines?: CoverageStat;
  istanbulData?: JsIstanbulData;
}> {
  if (entries.length === 0) return {};

  const path = entries[0]!.path;

  let source: string;
  if (entries[0]!.source !== undefined) {
    source = entries[0]!.source;
  } else {
    try {
      source = readFileSync(path, 'utf8');
    } catch {
      return {};
    }
  }

  // Convert each run's raw V8 coverage to Istanbul shape independently, then merge
  // the Istanbul results by statement/branch/function id. V8 only emits a range entry
  // for code NOT executed in that run, so the set of ranges (and their offsets) shifts
  // depending on which branches ran — merging raw V8 ranges by array position across
  // runs is unsound. Istanbul's maps come from static AST parsing and are stable across
  // runs of the same file, so merging by id is well-defined.
  let merged: ReturnType<typeof createFileCoverage> | null = null;
  for (const entry of entries) {
    const converter = v8ToIstanbul(path, 0, { source });
    await converter.load();
    converter.applyCoverage(
      (entry.v8Data as V8ScriptCoverage).functions as Parameters<typeof converter.applyCoverage>[0],
    );
    const istanbulRaw = converter.toIstanbul();
    const fileCovData = Object.values(istanbulRaw)[0]!;
    const fc = createFileCoverage(fileCovData as Parameters<typeof createFileCoverage>[0]);
    if (merged) {
      merged.merge(fc);
    } else {
      merged = fc;
    }
  }
  const d = merged!.toJSON() as unknown as JsIstanbulData;

  const sCounts = Object.values(d.s);
  const bCounts = Object.values(d.b).flatMap((arr) => arr);
  const fCounts = Object.values(d.f);

  // Line coverage: for each unique line, take the max hit count across all statements on it.
  const lineHits: Record<number, number> = {};
  for (const [id, loc] of Object.entries(d.statementMap)) {
    const count = d.s[id]!;
    const line = loc.start.line;
    lineHits[line] = Math.max(lineHits[line] ?? 0, count);
  }
  const lineCounts = Object.values(lineHits);

  return {
    jsStatements: statOf(sCounts),
    jsBranches: statOf(bCounts),
    jsFunctions: statOf(fCounts),
    jsLines: statOf(lineCounts),
    istanbulData: d,
  };
}
