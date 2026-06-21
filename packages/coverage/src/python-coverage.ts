// Build Python coverage stats from coverage.py data.

import type { PythonCoverageData } from '@actharness/types';
import type { CoverageStat } from './types.js';

export function buildPythonStats(data: PythonCoverageData): {
  pythonShellStatements: CoverageStat;
  pythonShellBranches: CoverageStat;
  pythonShellLines: CoverageStat;
} {
  const stmtTotal = data.executedLines.length + data.missingLines.length;
  const stmtCovered = data.executedLines.length;
  const pythonShellStatements: CoverageStat = {
    covered: stmtCovered,
    total: stmtTotal,
    pct: stmtTotal === 0 ? 100 : (stmtCovered / stmtTotal) * 100,
  };

  const branchTotal = data.executedBranches.length + data.missingBranches.length;
  const branchCovered = data.executedBranches.length;
  const pythonShellBranches: CoverageStat = {
    covered: branchCovered,
    total: branchTotal,
    pct: branchTotal === 0 ? 100 : (branchCovered / branchTotal) * 100,
  };

  const allLines = new Set([...data.executedLines, ...data.missingLines]);
  const lineTotal = allLines.size;
  const lineCovered = data.executedLines.length;
  const pythonShellLines: CoverageStat = {
    covered: lineCovered,
    total: lineTotal,
    pct: lineTotal === 0 ? 100 : (lineCovered / lineTotal) * 100,
  };

  return { pythonShellStatements, pythonShellBranches, pythonShellLines };
}
