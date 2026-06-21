// @actharness/coverage — Istanbul coverage collector for actharness runs.

export { actharnessCoverage, getCoverage, applyIncludeExclude } from './actharness-coverage.js';
export { CoverageCollector, aggregateTotals } from './collector.js';
export type { InputExerciseEntry, OutputExerciseEntry, StepReachedEntry, CoverageFragment, JsCoverageEntry, ShShellCoverageEntry, PythonShellCoverageEntry, NodeShellCoverageEntry } from './collector.js';
export { buildActionCoverage } from './coverage-map.js';
export { generateReports, generateActharnessReports, ACTHARNESS_REPORTER_NAMES } from './reporters.js';
export type { ReporterName, ReportOptions, ActharnessReportOptions } from './reporters.js';
export type { CoverageMetric, CoverageStat, IfBranchRow, InputCoverageRow, OutputCoverageRow, FileCoverage, JsFileCoverage, PythonShellFileCoverage as PyFileCoverage, PythonCoverageData, CoverageReport, CoverageOptions } from './types.js';
export { buildPythonStats } from './python-coverage.js';
export { offsetToLoc, nodeRangeToIstanbul } from './source-map.js';
export type { IstanbulLoc, IstanbulRange } from './source-map.js';
export { createCoverageMap } from './istanbul-compat.js';
export type { CoverageMap } from './istanbul-compat.js';
export { buildIndexHtml, buildFileHtml, generateHtmlReport } from './html-reporter.js';
export { buildTextReport, buildTextSummary } from './text-reporter.js';
