// Domain API — module-level singleton for in-process coverage collection.

import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import micromatch from 'micromatch';
import { registerRunListener, parseAction } from '@actharness/core';
import { CoverageCollector, aggregateTotals } from './collector.js';
import type { CoverageReport, FileCoverage, IfBranchRow, CoverageOptions, OutputCoverageRow } from './types.js';

let _collector: CoverageCollector | null = null;
let _options: CoverageOptions = {};

/** Initialize coverage collection and register a run listener. Idempotent. */
export function actharnessCoverage(options?: CoverageOptions): void {
  _options = options ?? {};
  if (!_collector) {
    _collector = new CoverageCollector();
    registerRunListener(_collector.createListener());
  }
}

/** Return the current domain CoverageReport. Must be called after actharnessCoverage(). */
export async function getCoverage(): Promise<CoverageReport> {
  if (!_collector) {
    throw new Error('actharnessCoverage() has not been called');
  }
  const base = await _collector.toCoverageReport();
  return applyIncludeExclude(base, _options, process.cwd());
}

/** Apply include/exclude glob options to a base report, scanning the filesystem for untracked files. */
export function applyIncludeExclude(
  base: CoverageReport,
  options: Pick<CoverageOptions, 'include' | 'exclude'>,
  cwd: string,
): CoverageReport {
  const { include, exclude } = options;
  if (!include?.length && !exclude?.length) return base;

  const files: Record<string, FileCoverage> = { ...base.files };

  if (exclude?.length) {
    for (const filePath of Object.keys(files)) {
      const rel = relative(cwd, filePath);
      if (micromatch([rel], exclude).length > 0) {
        delete files[filePath];
      }
    }
  }

  if (include?.length) {
    const allFiles = _scanDir(cwd);
    for (const absPath of allFiles) {
      if (files[absPath]) continue;
      const rel = relative(cwd, absPath);
      if (!micromatch([rel], include).length) continue;
      if (exclude?.length && micromatch([rel], exclude).length > 0) continue;
      const zero = _buildZeroFileCoverage(absPath);
      if (zero) files[absPath] = zero;
    }
  }

  const jsFiles = base.jsFiles;
  const pythonShellFiles = base.pythonShellFiles;
  const shShellFiles = base.shShellFiles;
  const bashShellFiles = base.bashShellFiles;
  const pwshShellFiles = base.pwshShellFiles;
  const nodeShellFiles = base.nodeShellFiles;
  return {
    files,
    jsFiles,
    pythonShellFiles: pythonShellFiles,
    shShellFiles: shShellFiles,
    bashShellFiles: bashShellFiles,
    pwshShellFiles: pwshShellFiles,
    nodeShellFiles: nodeShellFiles,
    total: aggregateTotals(Object.values(files), jsFiles, pythonShellFiles, shShellFiles, bashShellFiles, pwshShellFiles, nodeShellFiles),
  };
}

function _scanDir(cwd: string): string[] {
  try {
    const entries = readdirSync(cwd, { recursive: true, withFileTypes: true });
    return (entries as import('node:fs').Dirent[])
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name))
      .filter((p) => !p.split(sep).includes('node_modules'));
  } catch {
    return [];
  }
}

function _isAlwaysTrueExpression(expr: string): boolean {
  const t = expr.trim();
  return t === 'always()' || t === '${{ always() }}';
}

function _buildZeroFileCoverage(filePath: string): FileCoverage | null {
  try {
    const action = parseAction(filePath);
    const steps = action.runs.steps!;

    const allStepIds = steps.map((s, i) => s.id ?? `__step_${i + 1}__`);
    const ifBranchTable: IfBranchRow[] = [];
    let branchTotal = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (step.if && step.if !== 'success()') {
        const alwaysTrue = _isAlwaysTrueExpression(step.if);
        branchTotal += alwaysTrue ? 1 : 2;
        const row: IfBranchRow = {
          step: step.id ?? `__step_${i + 1}__`,
          expression: step.if,
          trueCount: 0,
          falseCount: 0,
        };
        if (alwaysTrue) row.falseBranchImpossible = true;
        ifBranchTable.push(row);
      }
    }

    const inputEntries = Object.entries(action.inputs ?? {});
    const inputTotal = inputEntries.reduce((sum, [, def]) => {
      return sum + ((def as { default?: unknown }).default !== undefined ? 2 : 1);
    }, 0);

    const stepsTotal = allStepIds.length;

    const stepHits: Record<string, number> = {};
    const stepReached: Record<string, number> = {};
    for (const id of allStepIds) { stepHits[id] = 0; stepReached[id] = 0; }

    const outputEntries = Object.keys(action.outputs ?? {});
    const outputTable: OutputCoverageRow[] = outputEntries.map((name) => ({ name, covered: false, count: 0 }));
    const outputTotal = outputTable.length;

    return {
      path: filePath,
      steps: { covered: 0, total: stepsTotal, pct: stepsTotal === 0 ? 100 : 0 },
      ifBranches: { covered: 0, total: branchTotal, pct: branchTotal === 0 ? 100 : 0 },
      inputs: { covered: 0, total: inputTotal, pct: inputTotal === 0 ? 100 : 0 },
      outputs: { covered: 0, total: outputTotal, pct: outputTotal === 0 ? 100 : 0 },
      ifBranchTable,
      inputTable: [],
      outputTable,
      stepHits,
      stepReached,
      uncoveredSteps: allStepIds,
    };
  } catch {
    return null;
  }
}
