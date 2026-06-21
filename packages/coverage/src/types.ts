// Domain types for @actharness/coverage public API.

import type { PythonCoverageData } from '@actharness/types';
export type { PythonCoverageData };

export type ReporterName =
  | 'text'
  | 'text-summary'
  | 'lcov'
  | 'lcovonly'
  | 'html'
  | 'html-spa'
  | 'json'
  | 'json-summary'
  | 'cobertura'
  | 'clover'
  | 'teamcity'
  | 'none';

export type CoverageMetric =
  | 'steps'
  | 'ifBranches'
  | 'inputs'
  | 'outputs'
  // v0.2: JS coverage from V8 inspector — present only for node actions
  | 'jsStatements'
  | 'jsBranches'
  | 'jsFunctions'
  | 'jsLines'
  | 'shShellLines'
  | 'bashShellLines'
  | 'pwshShellLines'
  | 'pythonShellStatements'
  | 'pythonShellBranches'
  | 'pythonShellLines'
  | 'nodeShellLines'
  | 'nodeShellStatements'
  | 'nodeShellBranches';

export interface CoverageStat {
  covered: number;
  total: number;
  pct: number;
}

export interface IfBranchRow {
  step: string;
  expression: string;
  trueCount: number;
  falseCount: number;
  /** True when the false branch is semantically impossible (e.g. always()). Excluded from branch coverage totals. */
  falseBranchImpossible?: boolean;
}

export interface InputCoverageRow {
  name: string;
  hasDefault: boolean;
  coveredProvided: boolean;
  coveredDefault: boolean;
  providedCount: number;
  defaultCount: number;
}

export interface OutputCoverageRow {
  name: string;
  covered: boolean;
  count: number;
}

export interface FileCoverage {
  path: string;
  steps: CoverageStat;
  ifBranches: CoverageStat;
  inputs: CoverageStat;
  outputs: CoverageStat;
  ifBranchTable: IfBranchRow[];
  inputTable: InputCoverageRow[];
  outputTable: OutputCoverageRow[];
  /** Per-step body execution counts (stepId → times body ran). */
  stepHits: Record<string, number>;
  /** Per-step reached counts (stepId → times condition evaluated or step processed). */
  stepReached: Record<string, number>;
  uncoveredSteps: string[];
  /**per-step sh line hits for source annotation: stepId → (scriptLineNum → hitCount). shell: sh only. */
  shStepLineHits?: Record<string, Record<number, number>> | undefined;
  /**per-step bash line hits for source annotation: stepId → (scriptLineNum → hitCount). shell: bash only. */
  bashStepLineHits?: Record<string, Record<number, number>> | undefined;
  /**per-step pwsh line hits for source annotation: stepId → (scriptLineNum → hitCount). */
  pwshStepLineHits?: Record<string, Record<number, number>> | undefined;
  /**per-step python line hits for source annotation: stepId → (scriptLineNum → hitCount). Executed lines → 1, missing lines → 0. */
  pyStepLineHits?: Record<string, Record<number, number>> | undefined;
  /**shell: node line coverage via V8. */
  nodeShellLines?: CoverageStat | undefined;
  /**shell: node statement coverage via V8. */
  nodeShellStatements?: CoverageStat | undefined;
  /**shell: node branch coverage via V8. */
  nodeShellBranches?: CoverageStat | undefined;
  /**per-step shell: node Istanbul data for inline source annotation. */
  nodeShStepIstanbul?: Record<string, JsIstanbulData> | undefined;
}

interface IstanbulLoc { line: number; column: number; }
interface IstanbulRange { start: IstanbulLoc; end: IstanbulLoc; }

/** Istanbul-format per-file data produced by v8-to-istanbul. Used for source annotation. */
export interface JsIstanbulData {
  s: Record<string, number>;
  b: Record<string, number[]>;
  f: Record<string, number>;
  statementMap: Record<string, IstanbulRange>;
  branchMap: Record<string, { type: string; locations: IstanbulRange[] }>;
  fnMap: Record<string, { name: string; decl: IstanbulRange; loc: IstanbulRange }>;
}

/**Per-Python-file coverage.py data (one entry per source file, keyed by absolute path). */
export interface PythonShellFileCoverage {
  path: string;
  statements: CoverageStat;
  branches: CoverageStat;
  lines: CoverageStat;
  pythonCoverageData: PythonCoverageData;
}

/**Per-shell:node-step Istanbul coverage (one entry per step, keyed by `<actionPath>#<stepId>`). */
export interface NodeShellFileCoverage {
  path: string;
  statements: CoverageStat;
  branches: CoverageStat;
  lines: CoverageStat;
  uncoveredLines: number[];
}

/**Per-sh-step line coverage (one entry per step, keyed by `<actionPath>#<stepId>`). */
export interface ShShellFileCoverage {
  path: string;
  lines: CoverageStat;
  uncoveredLines: number[];
}

/**Per-bash-step line coverage (one entry per step, keyed by `<actionPath>#<stepId>`). */
export interface BashShellFileCoverage {
  path: string;
  lines: CoverageStat;
  uncoveredLines: number[];
}

/**Per-pwsh-step line coverage (one entry per step, keyed by `<actionPath>#<stepId>`). */
export interface PwshShellFileCoverage {
  path: string;
  lines: CoverageStat;
  uncoveredLines: number[];
}

/** Per-JS-file V8 coverage (one entry per source file, keyed by absolute path). */
export interface JsFileCoverage {
  path: string;
  statements: CoverageStat;
  branches: CoverageStat;
  functions: CoverageStat;
  lines: CoverageStat;
  /** Full Istanbul-format data for source annotation (statements, branches, functions). */
  istanbulData: JsIstanbulData;
}

export interface CoverageReport {
  files: Record<string, FileCoverage>;
  /** JS file-level V8 coverage, keyed by absolute JS file path. */
  jsFiles: Record<string, JsFileCoverage>;
  /**Python file-level coverage.py data, keyed by absolute Python source path. */
  pythonShellFiles: Record<string, PythonShellFileCoverage>;
  /**sh-step line coverage, keyed by `<actionPath>#<stepId>`. */
  shShellFiles: Record<string, ShShellFileCoverage>;
  /**bash-step line coverage, keyed by `<actionPath>#<stepId>`. */
  bashShellFiles: Record<string, BashShellFileCoverage>;
  /**pwsh-step line coverage, keyed by `<actionPath>#<stepId>`. */
  pwshShellFiles: Record<string, PwshShellFileCoverage>;
  /**shell:node per-step Istanbul coverage, keyed by `<actionPath>#<stepId>`. */
  nodeShellFiles: Record<string, NodeShellFileCoverage>;
  total: Record<CoverageMetric, CoverageStat>;
}

export interface CoverageOptions {
  include?: string[];
  exclude?: string[];
  reporters?: ReporterName[];
  coverageDir?: string;
  /** Thresholds per metric. JS metrics are silently skipped for non-node actions. */
  thresholds?: Partial<Record<CoverageMetric, number>>;
}
