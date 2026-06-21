// Build Istanbul FileCoverage from a ParsedAction + StepResult[].
// Steps → statements; if: conditions → branches.

import { readFileSync } from 'node:fs';
import type { ParsedAction, StepResult, NodeRange } from '@actharness/types';
import { createFileCoverage } from './istanbul-compat.js';
import type { FileCoverage } from './istanbul-compat.js';
import { nodeRangeToIstanbul } from './source-map.js';
import type { IstanbulRange } from './source-map.js';

export interface IstanbulBranchMapping {
  loc: IstanbulRange;
  type: string;
  locations: IstanbulRange[];
  line: number;
  _stepId?: string;
  _expression?: string;
  _falseBranchImpossible?: boolean;
}

function _isAlwaysTrueExpression(expr: string): boolean {
  const t = expr.trim();
  return t === 'always()' || t === '${{ always() }}';
}

interface IstanbulFunctionMapping {
  name: string;
  decl: IstanbulRange;
  loc: IstanbulRange;
  line: number;
}

interface RawFileCoverageData {
  path: string;
  statementMap: Record<string, IstanbulRange & { _stepId?: string }>;
  s: Record<string, number>;
  branchMap: Record<string, IstanbulBranchMapping>;
  b: Record<string, [number, number]>;
  fnMap: Record<string, IstanbulFunctionMapping>;
  f: Record<string, number>;
}

function emptyData(path: string): RawFileCoverageData {
  return {
    path,
    statementMap: {},
    s: {},
    branchMap: {},
    b: {},
    fnMap: {},
    f: {},
  };
}


/** Build Istanbul FileCoverage for one action.yml invocation (current run only; accumulation is handled by the map). */
export function buildActionCoverage(
  action: ParsedAction,
  stepResults: StepResult[],
): FileCoverage {
  const filePath = action._file;
  if (!filePath) {
    return createFileCoverage(emptyData('???')) as unknown as FileCoverage;
  }

  let source: string | undefined;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch {
    source = undefined;
  }

  const steps = action.runs.steps ?? [];

  const statementMap: Record<string, IstanbulRange & { _stepId?: string }> = {};
  const s: Record<string, number> = {};
  const branchMap: Record<string, IstanbulBranchMapping> = {};
  const b: Record<string, [number, number]> = {};
  const fnMap: Record<string, IstanbulFunctionMapping> = {};
  const f: Record<string, number> = {};

  let branchCounter = 0;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepId = step.id ?? `__step_${i + 1}__`;
    const result = stepResults.find((r) => r.id === stepId);

    const sId = String(i);
    const range: IstanbulRange =
      step._range && source
        ? nodeRangeToIstanbul(source, step._range.start, step._range.end)
        : { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 0 } };

    statementMap[sId] = { ...range, _stepId: stepId };
    s[sId] = result?.ran === true ? 1 : 0;

    // Branch: only for explicit if: (not the implied success())
    // bId uses a sequential counter (not step index) to match Istanbul's internal renormalisation.
    if (step.if !== undefined && step.if !== 'success()') {
      const bId = String(branchCounter++);
      const entry: IstanbulBranchMapping = {
        loc: range,
        type: 'if',
        locations: [range, range],
        line: range.start.line,
        _stepId: stepId,
        _expression: step.if,
      };
      if (_isAlwaysTrueExpression(step.if)) entry._falseBranchImpossible = true;
      branchMap[bId] = entry;

      const ifResult = result?.if?.result;
      b[bId] = [ifResult === true ? 1 : 0, ifResult === false ? 1 : 0];
    }
  }

  // Node-action phases (runs.main / pre / post) — same statement/branch model as
  // composite steps above, keyed by phase name instead of step id.
  if (!action.runs.steps && action.runs.main) {
    const phases: { phase: 'pre' | 'main' | 'post'; entrypoint: string; range: NodeRange | undefined }[] = [
      { phase: 'pre', entrypoint: action.runs.pre ?? '', range: action.runs._preRange },
      { phase: 'main', entrypoint: action.runs.main, range: action.runs._mainRange },
      { phase: 'post', entrypoint: action.runs.post ?? '', range: action.runs._postRange },
    ];

    let phaseIdx = 0;
    for (const { phase, entrypoint, range: rawRange } of phases) {
      if (!entrypoint) continue;
      const result = stepResults.find((r) => r.id === phase);

      const sId = `phase_${phaseIdx++}`;
      const range: IstanbulRange =
        rawRange && source
          ? nodeRangeToIstanbul(source, rawRange.start, rawRange.end)
          : { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };

      statementMap[sId] = { ...range, _stepId: phase };
      s[sId] = result?.ran === true ? 1 : 0;

      const ifExpr = phase === 'pre' ? action.runs['pre-if'] : phase === 'post' ? action.runs['post-if'] : undefined;
      const ifRange = phase === 'pre' ? action.runs._preIfRange : phase === 'post' ? action.runs._postIfRange : undefined;
      if (ifExpr !== undefined) {
        const bId = String(branchCounter++);
        const bRange: IstanbulRange =
          ifRange && source
            ? nodeRangeToIstanbul(source, ifRange.start, ifRange.end)
            : range;
        const phaseEntry: IstanbulBranchMapping = {
          loc: bRange,
          type: 'if',
          locations: [bRange, bRange],
          line: bRange.start.line,
          _stepId: phase,
          _expression: ifExpr,
        };
        if (_isAlwaysTrueExpression(ifExpr)) phaseEntry._falseBranchImpossible = true;
        branchMap[bId] = phaseEntry;

        const ifResult = result?.if?.result;
        b[bId] = [ifResult === true ? 1 : 0, ifResult === false ? 1 : 0];
      }
    }
  }

  // The entire action is one "function"
  const actionRange: IstanbulRange = { start: { line: 1, column: 0 }, end: { line: 1, column: 0 } };
  fnMap['0'] = {
    name: action.name || 'action',
    decl: actionRange,
    loc: actionRange,
    line: 1,
  };
  const anyRan = stepResults.some((r) => r.ran);
  f['0'] = anyRan ? 1 : 0;

  return createFileCoverage({
    path: filePath,
    statementMap,
    s,
    branchMap: branchMap as unknown as Record<string, import('istanbul-lib-coverage').BranchMapping>,
    b,
    fnMap: fnMap as unknown as Record<string, import('istanbul-lib-coverage').FunctionMapping>,
    f,
  }) as unknown as FileCoverage;
}
