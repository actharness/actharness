import type { CoverageMap } from 'istanbul-lib-coverage';

export interface Thresholds {
  statements?: number;
  branches?: number;
  functions?: number;
  ifBranches?: number;
}

export interface ThresholdResult {
  passed: boolean;
  failures: string[];
}

export function checkThresholds(map: CoverageMap, thresholds: Thresholds): ThresholdResult {
  const failures: string[] = [];

  let totalStatements = 0, coveredStatements = 0;
  let totalBranches = 0, coveredBranches = 0;
  let totalFunctions = 0, coveredFunctions = 0;

  for (const fc of Object.values(map.data)) {
    for (const count of Object.values(fc.data.s)) {
      totalStatements++;
      if ((count as number) > 0) coveredStatements++;
    }
    for (const arr of Object.values(fc.data.b)) {
      for (const count of arr as number[]) {
        totalBranches++;
        if (count > 0) coveredBranches++;
      }
    }
    for (const count of Object.values(fc.data.f)) {
      totalFunctions++;
      if ((count as number) > 0) coveredFunctions++;
    }
  }

  const pct = (covered: number, total: number) =>
    total === 0 ? 100 : Math.floor((covered / total) * 100);

  if (thresholds.statements !== undefined) {
    const actual = pct(coveredStatements, totalStatements);
    if (actual < thresholds.statements) {
      failures.push(`Statements: ${actual}% < ${thresholds.statements}% (${coveredStatements}/${totalStatements})`);
    }
  }

  if (thresholds.branches !== undefined || thresholds.ifBranches !== undefined) {
    const limit = thresholds.ifBranches ?? thresholds.branches!;
    const actual = pct(coveredBranches, totalBranches);
    if (actual < limit) {
      failures.push(`Branches: ${actual}% < ${limit}% (${coveredBranches}/${totalBranches})`);
    }
  }

  if (thresholds.functions !== undefined) {
    const actual = pct(coveredFunctions, totalFunctions);
    if (actual < thresholds.functions) {
      failures.push(`Functions: ${actual}% < ${thresholds.functions}% (${coveredFunctions}/${totalFunctions})`);
    }
  }

  return { passed: failures.length === 0, failures };
}
