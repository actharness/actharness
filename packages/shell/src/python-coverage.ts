// Parse coverage.py JSON output into PythonCoverageData.

import type { PythonCoverageData } from '@actharness/types';

export type { PythonCoverageData };

interface CoveragePyFile {
  executed_lines?: number[];
  missing_lines?: number[];
  executed_branches?: [number, number][];
  missing_branches?: [number, number][];
}

interface CoveragePyJson {
  files?: Record<string, CoveragePyFile>;
}

export function parsePythonCoverageJson(json: string, scriptPath: string): PythonCoverageData {
  const parsed = JSON.parse(json) as CoveragePyJson;
  const files = parsed.files ?? {};
  const entry = files[scriptPath] ?? Object.values(files)[0];
  if (!entry) {
    return { executedLines: [], missingLines: [], executedBranches: [], missingBranches: [] };
  }
  return {
    executedLines: entry.executed_lines ?? [],
    missingLines: entry.missing_lines ?? [],
    executedBranches: entry.executed_branches ?? [],
    missingBranches: entry.missing_branches ?? [],
  };
}
