// D19: build Istanbul FileCoverageData from YAML step/job ranges + RunResult signal.
// Steps → statements, if: guards → branches, jobs → statements.

import { createFileCoverage } from './istanbul-compat.js';
import type { FileCoverage, FileCoverageData } from './istanbul-compat.js';
import { extractStepRanges, extractJobRanges, type StepRange, type JobRange } from './yaml-map.js';
import type { RunResult, StepResult } from './types.js';

// Metadata stored alongside the FileCoverageData to map step IDs to Istanbul indices.
export interface ActionCoverageMeta {
  kind: 'action';
  steps: Array<{ id: string; statementIdx: string; branchIdx?: string }>;
}

export interface WorkflowCoverageMeta {
  kind: 'workflow';
  jobs: Array<{ id: string; statementIdx: string }>;
}

export type CoverageMeta = ActionCoverageMeta | WorkflowCoverageMeta;

const MAX_COLUMN = 999;

function loc(startLine: number, endLine: number) {
  return {
    start: { line: startLine, column: 0 },
    end: { line: endLine, column: MAX_COLUMN },
  };
}

export function buildActionCoverage(
  sourceFile: string,
  yamlSource: string,
): { coverage: FileCoverage; meta: ActionCoverageMeta } {
  const stepRanges = extractStepRanges(yamlSource);

  const statementMap: FileCoverageData['statementMap'] = {};
  const s: FileCoverageData['s'] = {};
  const branchMap: FileCoverageData['branchMap'] = {};
  const b: FileCoverageData['b'] = {};

  const meta: ActionCoverageMeta = { kind: 'action', steps: [] };
  let statementIdx = 0;
  let branchIdx = 0;

  for (const step of stepRanges) {
    const sKey = String(statementIdx);
    statementMap[sKey] = loc(step.startLine, step.endLine);
    s[sKey] = 0;

    const stepMeta: ActionCoverageMeta['steps'][number] = { id: step.id, statementIdx: sKey };

    if (step.hasIf) {
      const bKey = String(branchIdx);
      branchMap[bKey] = {
        loc: loc(step.startLine, step.endLine),
        type: 'if',
        line: step.startLine,
        locations: [
          loc(step.startLine, step.endLine), // true: step ran
          loc(step.startLine, step.endLine), // false: step skipped
        ],
      };
      b[bKey] = [0, 0];
      stepMeta.branchIdx = bKey;
      branchIdx++;
    }

    meta.steps.push(stepMeta);
    statementIdx++;
  }

  const data: FileCoverageData = {
    path: sourceFile,
    statementMap,
    fnMap: {},
    branchMap,
    s,
    f: {},
    b,
  };

  return { coverage: createFileCoverage(data), meta };
}

export function buildWorkflowCoverage(
  sourceFile: string,
  yamlSource: string,
): { coverage: FileCoverage; meta: WorkflowCoverageMeta } {
  const jobRanges = extractJobRanges(yamlSource);

  const statementMap: FileCoverageData['statementMap'] = {};
  const s: FileCoverageData['s'] = {};
  const meta: WorkflowCoverageMeta = { kind: 'workflow', jobs: [] };

  let idx = 0;
  for (const job of jobRanges) {
    const key = String(idx);
    statementMap[key] = loc(job.startLine, job.endLine);
    s[key] = 0;
    meta.jobs.push({ id: job.id, statementIdx: key });
    idx++;
  }

  const data: FileCoverageData = {
    path: sourceFile,
    statementMap,
    fnMap: {},
    branchMap: {},
    s,
    f: {},
    b: {},
  };

  return { coverage: createFileCoverage(data), meta };
}

export function updateActionCoverage(
  coverage: FileCoverage,
  meta: ActionCoverageMeta,
  result: RunResult,
): void {
  for (const step of result.steps) {
    const stepMeta = meta.steps.find(m => m.id === step.id);
    if (!stepMeta) continue;

    if (step.ran) {
      (coverage.data.s[stepMeta.statementIdx] as number)++;
    }

    if (step.if !== undefined && stepMeta.branchIdx !== undefined) {
      const branchArr = coverage.data.b[stepMeta.branchIdx] as number[];
      if (step.if.result) {
        branchArr[0]++;  // true branch: step ran
      } else {
        branchArr[1]++;  // false branch: step skipped
      }
    }
  }
}

export function updateWorkflowCoverage(
  coverage: FileCoverage,
  meta: WorkflowCoverageMeta,
  jobId: string,
  ran: boolean,
): void {
  const jobMeta = meta.jobs.find(j => j.id === jobId);
  if (!jobMeta) return;
  if (ran) (coverage.data.s[jobMeta.statementIdx] as number)++;
}
