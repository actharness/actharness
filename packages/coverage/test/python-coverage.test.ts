import { describe, it, expect } from 'vitest';
import { buildPythonStats } from '../src/python-coverage.js';
import type { PythonCoverageData } from '../src/types.js';

function makeData(overrides: Partial<PythonCoverageData> = {}): PythonCoverageData {
  return {
    executedLines: [],
    missingLines: [],
    executedBranches: [],
    missingBranches: [],
    ...overrides,
  };
}

describe('buildPythonStats', () => {
  it('empty data → all totals 0, pcts 100', () => {
    const result = buildPythonStats(makeData());
    expect(result.pythonShellStatements).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.pythonShellBranches).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.pythonShellLines).toEqual({ covered: 0, total: 0, pct: 100 });
  });

  it('computes pythonShellStatements from executedLines + missingLines', () => {
    const result = buildPythonStats(makeData({ executedLines: [1, 2, 3], missingLines: [4] }));
    expect(result.pythonShellStatements.covered).toBe(3);
    expect(result.pythonShellStatements.total).toBe(4);
    expect(result.pythonShellStatements.pct).toBeCloseTo(75);
  });

  it('computes pythonShellBranches from executedBranches + missingBranches', () => {
    const result = buildPythonStats(makeData({
      executedBranches: [[1, 2], [2, 3]],
      missingBranches: [[3, 4]],
    }));
    expect(result.pythonShellBranches.covered).toBe(2);
    expect(result.pythonShellBranches.total).toBe(3);
    expect(result.pythonShellBranches.pct).toBeCloseTo(66.67);
  });

  it('pythonShellLines uses Set union of executedLines and missingLines (deduplicates)', () => {
    const result = buildPythonStats(makeData({ executedLines: [1, 2], missingLines: [2, 3] }));
    expect(result.pythonShellLines.covered).toBe(2);
    expect(result.pythonShellLines.total).toBe(3);
    expect(result.pythonShellLines.pct).toBeCloseTo(66.67);
  });

  it('100% when all lines are executed and none missing', () => {
    const result = buildPythonStats(makeData({ executedLines: [1, 2, 3], missingLines: [] }));
    expect(result.pythonShellStatements.pct).toBe(100);
    expect(result.pythonShellLines.pct).toBe(100);
  });

  it('0% when no lines are executed', () => {
    const result = buildPythonStats(makeData({ executedLines: [], missingLines: [1, 2] }));
    expect(result.pythonShellStatements.pct).toBe(0);
    expect(result.pythonShellLines.pct).toBe(0);
  });
});
