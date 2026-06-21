// CoverageCollector — subscribes to the run sink and accumulates Istanbul coverage.
// Downstream of the run sink; @actharness/core never imports this.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { RunListener, RunResultMeta } from '@actharness/core';
import type { NodeCoverageData, RunResult } from '@actharness/types';
import { parseAction } from '@actharness/core';
import { createCoverageMap } from './istanbul-compat.js';
import type { CoverageMap } from './istanbul-compat.js';
import { buildActionCoverage } from './coverage-map.js';
import { mergeJsCoverage, buildJsStats } from './js-coverage.js';
import { buildShStats } from './sh-coverage.js';
import { buildPwshStats } from './pwsh-coverage.js';
import { buildPythonStats } from './python-coverage.js';
import type {
  CoverageReport,
  FileCoverage,
  JsFileCoverage,
  NodeShellFileCoverage,
  PythonShellFileCoverage,
  ShShellFileCoverage,
  BashShellFileCoverage,
  PwshShellFileCoverage,
  PythonCoverageData,
  CoverageStat,
  IfBranchRow,
  CoverageMetric,
  InputCoverageRow,
  OutputCoverageRow,
} from './types.js';

interface RawStatementEntry {
  start: { line: number; column: number };
  end: { line: number; column: number };
  _stepId?: string;
}

interface RawBranchEntry {
  _stepId?: string;
  _expression?: string;
  _falseBranchImpossible?: boolean;
}

interface RawMapEntry {
  path: string;
  s: Record<string, number>;
  b: Record<string, [number, number]>;
  branchMap: Record<string, RawBranchEntry>;
  statementMap: Record<string, RawStatementEntry>;
}

interface InputRecord {
  inputCounts: Record<string, { provided: number; default: number }>;
  inputDefs: Record<string, { hasDefault: boolean }>;
}

interface OutputRecord {
  // output name → how many runs produced a non-empty value
  counts: Record<string, number>;
}

export interface InputExerciseEntry {
  path: string;
  inputCounts: Record<string, { provided: number; default: number }>;
  inputDefs: Record<string, { hasDefault: boolean }>;
}

export interface OutputExerciseEntry {
  path: string;
  counts: Record<string, number>;
}

export interface StepReachedEntry {
  path: string;
  counts: Record<string, number>;
}

export interface JsCoverageEntry {
  /** Absolute path of the JS source file. */
  path: string;
  /** Raw V8 script coverage object for this file. */
  v8Data: unknown;
  /** Inline source text (used for temp scripts that are deleted before toCoverageReport runs). */
  source?: string;
}

export interface ShShellCoverageEntry {
  /** `<actionFilePath>#<stepId>` stable key. */
  key: string;
  lineHits: Record<number, number>;
}

export interface PythonShellCoverageEntry {
  /** `<actionFilePath>#<stepId>` stable key. */
  key: string;
  pythonCoverageData: PythonCoverageData;
  /** Accumulated hit counts: scriptLineNum → count across all test runs. */
  lineHits: Record<number, number>;
}

export interface NodeShellCoverageEntry {
  /** `<actionFilePath>#<stepId>` stable key. */
  key: string;
  /** Raw V8 coverage entries for this step (one per test run). */
  entries: NodeCoverageData[];
}

export interface CoverageFragment {
  istanbulMap: unknown;
  inputExercises: InputExerciseEntry[];
  outputExercises: OutputExerciseEntry[];
  stepReachedExercises: StepReachedEntry[];
  /** accumulated JS coverage entries (one per node action run). */
  jsCoverageEntries: JsCoverageEntry[];
  /**accumulated sh line coverage entries (shell: sh only). */
  shShellCoverageEntries?: ShShellCoverageEntry[];
  /**accumulated bash line coverage entries (shell: bash only). */
  bashShellCoverageEntries?: ShShellCoverageEntry[];
  /**accumulated pwsh line coverage entries. */
  pwshShellCoverageEntries?: ShShellCoverageEntry[];
  /**accumulated Python coverage entries (pythonCoverageData + lineHits). */
  pythonShellCoverageEntries?: PythonShellCoverageEntry[];
  /**accumulated shell: node raw V8 coverage entries (processed async in toCoverageReport). */
  nodeShellCoverageEntries?: NodeShellCoverageEntry[];
}

const STEP_OUTPUT_RE = /^\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/;

function _isOutputProduced(valueExpr: string | undefined, name: string, result: RunResult): boolean {
  if (!valueExpr) return !!result.outputs[name];
  const m = STEP_OUTPUT_RE.exec(valueExpr);
  if (m) {
    const stepId = m[1]!;
    const outputKey = m[2]!;
    const stepResult = result.steps.find((r) => r.id === stepId);
    return outputKey in (stepResult?.outputs ?? {});
  }
  return !!result.outputs[name];
}

function statOf(counts: number[]): CoverageStat {
  const total = counts.length;
  const covered = counts.filter((c) => c > 0).length;
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

function branchStatOf(b: Record<string, [number, number]>, branchMap: Record<string, RawBranchEntry>): CoverageStat {
  let total = 0;
  let covered = 0;
  for (const [id, [t, f]] of Object.entries(b)) {
    if (branchMap[id]?._falseBranchImpossible) {
      total += 1;
      covered += t > 0 ? 1 : 0;
    } else {
      total += 2;
      covered += (t > 0 ? 1 : 0) + (f > 0 ? 1 : 0);
    }
  }
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

function buildIfBranchTable(entry: RawMapEntry): IfBranchRow[] {
  const rows: IfBranchRow[] = [];
  for (const [id, mapping] of Object.entries(entry.branchMap)) {
    if (mapping._expression !== undefined && mapping._stepId !== undefined) {
      const counts = entry.b[id];
      const row: IfBranchRow = {
        step: mapping._stepId,
        expression: mapping._expression,
        trueCount: counts?.[0] ?? 0,
        falseCount: counts?.[1] ?? 0,
      };
      if (mapping._falseBranchImpossible) row.falseBranchImpossible = true;
      rows.push(row);
    }
  }
  return rows;
}

export class CoverageCollector {
  private _map: CoverageMap;
  private _inputData: Map<string, InputRecord>;
  private _outputData: Map<string, OutputRecord>;
  private _stepReachedData: Map<string, Record<string, number>>;
  /** accumulated raw V8 coverage entries from node action runs. */
  private _jsCoverageEntries: JsCoverageEntry[];
  /**accumulated sh line hits keyed by `<actionFilePath>#<stepId>`. shell: sh only. */
  private _shShellCoverageData: Map<string, Record<number, number>>;
  /**accumulated bash line hits keyed by `<actionFilePath>#<stepId>`. shell: bash only. */
  private _bashShellCoverageData: Map<string, Record<number, number>>;
  /**accumulated pwsh line hits keyed by `<actionFilePath>#<stepId>`. */
  private _pwshShellCoverageData: Map<string, Record<number, number>>;
  /**accumulated Python coverage data keyed by `<actionFilePath>#<stepId>`. */
  private _pythonShellCoverageData: Map<string, { pythonCoverageData: PythonCoverageData; lineHits: Record<number, number> }>;
  /**accumulated shell: node raw V8 entries; processed async in toCoverageReport. */
  private _nodeShellCoverageEntries: NodeShellCoverageEntry[];

  constructor() {
    this._map = createCoverageMap({}) as unknown as CoverageMap;
    this._inputData = new Map();
    this._outputData = new Map();
    this._stepReachedData = new Map();
    this._jsCoverageEntries = [];
    this._shShellCoverageData = new Map();
    this._bashShellCoverageData = new Map();
    this._pwshShellCoverageData = new Map();
    this._pythonShellCoverageData = new Map();
    this._nodeShellCoverageEntries = [];
  }

  get coverageMap(): CoverageMap {
    return this._map;
  }

  /** Create a RunListener that updates this collector on every run. */
  createListener(): RunListener {
    return (result, meta: RunResultMeta) => {
      if (!meta.sourceFile) return;

      let action;
      try {
        action = parseAction(meta.sourceFile);
      } catch {
        return;
      }

      const fileCoverage = buildActionCoverage(action, result.steps);
      this._map.addFileCoverage(fileCoverage as unknown as Parameters<CoverageMap['addFileCoverage']>[0]);

      // parseAction always sets _file when given a valid action directory
      const path = action._file as string;

      const reachedRecord = this._stepReachedData.get(path) ?? {};
      const steps = action.runs.steps ?? [];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i]!;
        const stepId = step.id ?? `__step_${i + 1}__`;
        const stepResult = result.steps.find((r) => r.id === stepId);
        const hasExplicitIf = step.if !== undefined && step.if !== 'success()';
        const wasReached = hasExplicitIf ? stepResult !== undefined : stepResult?.ran === true;
        reachedRecord[stepId] = (reachedRecord[stepId] ?? 0) + (wasReached ? 1 : 0);
      }

      // Node-action phases (pre/main/post) — same "was this exercised" tracking as
      // composite steps above, keyed by phase name instead of step id.
      if (!action.runs.steps && action.runs.main) {
        const phases: { phase: 'pre' | 'main' | 'post'; entrypoint: string | undefined; ifExpr: string | undefined }[] = [
          { phase: 'pre', entrypoint: action.runs.pre, ifExpr: action.runs['pre-if'] },
          { phase: 'main', entrypoint: action.runs.main, ifExpr: undefined },
          { phase: 'post', entrypoint: action.runs.post, ifExpr: action.runs['post-if'] },
        ];
        for (const { phase, entrypoint, ifExpr } of phases) {
          if (!entrypoint) continue;
          const stepResult = result.steps.find((r) => r.id === phase);
          const wasReached = ifExpr !== undefined ? stepResult !== undefined : stepResult?.ran === true;
          reachedRecord[phase] = (reachedRecord[phase] ?? 0) + (wasReached ? 1 : 0);
        }
      }

      this._stepReachedData.set(path, reachedRecord);

      if (meta.inputsExercised) {
        let record = this._inputData.get(path);
        if (!record) {
          record = { inputCounts: {}, inputDefs: {} };
          for (const [name, def] of Object.entries(action.inputs ?? {})) {
            record.inputDefs[name] = { hasDefault: (def as { default?: unknown }).default !== undefined };
            record.inputCounts[name] = { provided: 0, default: 0 };
          }
          this._inputData.set(path, record);
        }
        for (const [name, variant] of Object.entries(meta.inputsExercised)) {
          if (!record.inputCounts[name]) {
            record.inputCounts[name] = { provided: 0, default: 0 };
          }
          record.inputCounts[name]![variant as 'provided' | 'default']++;
        }
      }

      if (meta.jsCoverage) {
        const entries = meta.jsCoverage as JsCoverageEntry[];
        for (const entry of entries) {
          this._jsCoverageEntries.push(entry);
        }
      }

      if (meta.shellCoverage) {
        const steps = action.runs.steps ?? [];
        for (const entry of meta.shellCoverage) {
          const hashIdx = entry.path.lastIndexOf('#');
          if (hashIdx === -1) continue;
          if ('pythonCoverageData' in entry) {
            const hits = this._pythonShellCoverageData.get(entry.path)?.lineHits ?? {};
            for (const line of entry.pythonCoverageData.executedLines) hits[line] = (hits[line] ?? 0) + 1;
            for (const line of entry.pythonCoverageData.missingLines) { hits[line] ??= 0; }
            this._pythonShellCoverageData.set(entry.path, { pythonCoverageData: entry.pythonCoverageData, lineHits: hits });
          } else if ('nodeCoverageData' in entry) {
            const existing = this._nodeShellCoverageEntries.find((e) => e.key === entry.path);
            if (existing) {
              existing.entries.push(...entry.nodeCoverageData);
            } else {
              this._nodeShellCoverageEntries.push({ key: entry.path, entries: [...entry.nodeCoverageData] });
            }
          } else {
            const stepId = entry.path.slice(hashIdx + 1);
            const step = steps.find((s, i) => (s.id ?? `__step_${i + 1}__`) === stepId);
            const shell = (step?.shell ?? '').trim().toLowerCase();
            const isPwsh = shell === 'pwsh' || shell === 'powershell';
            const isBash = shell === 'bash';
            const targetMap = isPwsh ? this._pwshShellCoverageData : isBash ? this._bashShellCoverageData : this._shShellCoverageData;
            const existing = targetMap.get(entry.path) ?? {};
            for (const [lineStr, count] of Object.entries(entry.lineHits)) {
              const line = Number(lineStr);
              existing[line] = (existing[line] ?? 0) + count;
            }
            targetMap.set(entry.path, existing);
          }
        }
      }

      if (action.outputs) {
        let outRecord = this._outputData.get(path);
        if (!outRecord) {
          outRecord = { counts: {} };
          this._outputData.set(path, outRecord);
        }
        for (const [name, def] of Object.entries(action.outputs)) {
          const produced = _isOutputProduced(def.value, name, result);
          outRecord.counts[name] = (outRecord.counts[name] ?? 0) + (produced ? 1 : 0);
        }
      }

    };
  }

  /** Convert accumulated coverage to the domain CoverageReport. */
  async toCoverageReport(): Promise<CoverageReport> {
    const rawMap = this._map.toJSON() as unknown as Record<string, RawMapEntry>;
    const files: Record<string, FileCoverage> = {};

    for (const entry of Object.values(rawMap)) {
      const steps = statOf(Object.values(entry.s));
      const ifBranches = branchStatOf(entry.b, entry.branchMap);
      const ifBranchTable = buildIfBranchTable(entry);
      const inputs = this._computeInputStat(entry.path);
      const inputTable = this._buildInputTable(entry.path);
      const uncoveredSteps = Object.entries(entry.s)
        .filter(([id, count]) => count === 0 && entry.statementMap[id]?._stepId !== undefined)
        .map(([id]) => entry.statementMap[id]!._stepId!);

      const stepHits: Record<string, number> = {};
      for (const [id, count] of Object.entries(entry.s)) {
        const stepId = entry.statementMap[id]?._stepId;
        if (stepId !== undefined) stepHits[stepId] = count;
      }

      const { stat: outputs, table: outputTable } = this._computeOutputStat(entry.path);
      const stepReached: Record<string, number> = { ...(this._stepReachedData.get(entry.path) ?? {}) };

      files[entry.path] = {
        path: entry.path,
        steps,
        ifBranches,
        inputs,
        outputs,
        ifBranchTable,
        inputTable,
        outputTable,
        stepHits,
        stepReached,
        uncoveredSteps,
      };
    }

    const jsStatsByPath = mergeJsCoverage(this._jsCoverageEntries);
    const jsFiles: Record<string, JsFileCoverage> = {};
    const zero = { covered: 0, total: 0, pct: 0 };
    for (const [jsPath, entries] of jsStatsByPath) {
      const rawStats = await buildJsStats(entries);
      const emptyIstanbul = { s: {}, b: {}, f: {}, statementMap: {}, branchMap: {}, fnMap: {} };
      jsFiles[jsPath] = {
        path: jsPath,
        statements: rawStats.jsStatements ?? zero,
        branches: rawStats.jsBranches ?? zero,
        functions: rawStats.jsFunctions ?? zero,
        lines: rawStats.jsLines ?? zero,
        istanbulData: rawStats.istanbulData ?? emptyIstanbul,
      };
    }

    const shShellFiles: Record<string, ShShellFileCoverage> = {};
    for (const [key, lineHits] of this._shShellCoverageData) {
      const hashIdx = key.lastIndexOf('#');
      if (hashIdx === -1) continue;
      const actionFilePath = key.slice(0, hashIdx);
      const stepId = key.slice(hashIdx + 1);
      const fileCov = files[actionFilePath];
      if (!fileCov) continue;
      let action;
      try {
        action = parseAction(dirname(actionFilePath));
      } catch {
        continue;
      }
      const step = (action.runs.steps ?? []).find(
        (s, i) => (s.id ?? `__step_${i + 1}__`) === stepId,
      );
      if (!step?.run) continue;
      const { lines, executableLines, effectiveHits } = buildShStats(lineHits, step.run);
      const uncoveredLines = executableLines.filter((n) => (effectiveHits[n] ?? 0) === 0).sort((a, b) => a - b);
      shShellFiles[key] = { path: key, lines, uncoveredLines };
      if (!fileCov.shStepLineHits) fileCov.shStepLineHits = {};
      fileCov.shStepLineHits[stepId] = effectiveHits;
    }

    const bashShellFiles: Record<string, BashShellFileCoverage> = {};
    for (const [key, lineHits] of this._bashShellCoverageData) {
      const hashIdx = key.lastIndexOf('#');
      if (hashIdx === -1) continue;
      const actionFilePath = key.slice(0, hashIdx);
      const stepId = key.slice(hashIdx + 1);
      const fileCov = files[actionFilePath];
      if (!fileCov) continue;
      let action;
      try {
        action = parseAction(dirname(actionFilePath));
      } catch {
        continue;
      }
      const step = (action.runs.steps ?? []).find(
        (s, i) => (s.id ?? `__step_${i + 1}__`) === stepId,
      );
      if (!step?.run) continue;
      const { lines, executableLines, effectiveHits } = buildShStats(lineHits, step.run);
      const uncoveredLines = executableLines.filter((n) => (effectiveHits[n] ?? 0) === 0).sort((a, b) => a - b);
      bashShellFiles[key] = { path: key, lines, uncoveredLines };
      if (!fileCov.bashStepLineHits) fileCov.bashStepLineHits = {};
      fileCov.bashStepLineHits[stepId] = effectiveHits;
    }

    const pwshShellFiles: Record<string, PwshShellFileCoverage> = {};
    for (const [key, lineHits] of this._pwshShellCoverageData) {
      const hashIdx = key.lastIndexOf('#');
      if (hashIdx === -1) continue;
      const actionFilePath = key.slice(0, hashIdx);
      const stepId = key.slice(hashIdx + 1);
      const fileCov = files[actionFilePath];
      if (!fileCov) continue;
      let action;
      try {
        action = parseAction(dirname(actionFilePath));
      } catch {
        continue;
      }
      const step = (action.runs.steps ?? []).find(
        (s, i) => (s.id ?? `__step_${i + 1}__`) === stepId,
      );
      if (!step?.run) continue;
      const { lines, executableLines, effectiveHits } = buildPwshStats(lineHits, step.run);
      const uncoveredLines = executableLines.filter((n) => (effectiveHits[n] ?? 0) === 0).sort((a, b) => a - b);
      pwshShellFiles[key] = { path: key, lines, uncoveredLines };
      if (!fileCov.pwshStepLineHits) fileCov.pwshStepLineHits = {};
      fileCov.pwshStepLineHits[stepId] = effectiveHits;
    }

    const pythonShellFiles: Record<string, PythonShellFileCoverage> = {};
    for (const [key, { pythonCoverageData, lineHits }] of this._pythonShellCoverageData) {
      const hashIdx = key.lastIndexOf('#');
      if (hashIdx === -1) continue;
      const actionFilePath = key.slice(0, hashIdx);
      const stepId = key.slice(hashIdx + 1);
      const fileCov = files[actionFilePath];
      if (!fileCov) continue;
      const stats = buildPythonStats(pythonCoverageData);
      pythonShellFiles[key] = {
        path: key,
        statements: stats.pythonShellStatements,
        branches: stats.pythonShellBranches,
        lines: stats.pythonShellLines,
        pythonCoverageData,
      };
      if (!fileCov.pyStepLineHits) fileCov.pyStepLineHits = {};
      fileCov.pyStepLineHits[stepId] = lineHits;
    }

    // Process raw nodeCoverageData entries via v8-to-istanbul and store full Istanbul data per step.
    const nodeShellFiles: Record<string, NodeShellFileCoverage> = {};
    for (const { key, entries } of this._nodeShellCoverageEntries) {
      if (entries.length === 0) continue;
      const hashIdx = key.lastIndexOf('#');
      if (hashIdx === -1) continue;
      const actionFilePath = key.slice(0, hashIdx);
      const stepId = key.slice(hashIdx + 1);
      const fileCov = files[actionFilePath];
      if (!fileCov) continue;
      const rawStats = await buildJsStats(entries);
      const d = rawStats.istanbulData;
      if (!d) continue;
      // Compute nodeShellLines from statementMap (same derivation as jsLines in buildJsStats)
      const lineHits: Record<number, number> = {};
      for (const [id, loc] of Object.entries(d.statementMap)) {
        const count = d.s[id]!;
        lineHits[loc.start.line] = Math.max(lineHits[loc.start.line] ?? 0, count);
      }
      const lineCounts = Object.values(lineHits);
      const covered = lineCounts.filter((c) => c > 0).length;
      const total = lineCounts.length;
      const prev = fileCov.nodeShellLines;
      fileCov.nodeShellLines = {
        covered: (prev?.covered ?? 0) + covered,
        total: (prev?.total ?? 0) + total,
        pct: 0,
      };
      const prevStmt = fileCov.nodeShellStatements;
      fileCov.nodeShellStatements = {
        covered: (prevStmt?.covered ?? 0) + rawStats.jsStatements!.covered,
        total: (prevStmt?.total ?? 0) + rawStats.jsStatements!.total,
        pct: 0,
      };
      const prevBr = fileCov.nodeShellBranches;
      fileCov.nodeShellBranches = {
        covered: (prevBr?.covered ?? 0) + rawStats.jsBranches!.covered,
        total: (prevBr?.total ?? 0) + rawStats.jsBranches!.total,
        pct: 0,
      };
      const uncoveredLineSet = new Set<number>();
      for (const [id, loc] of Object.entries(d.statementMap)) {
        if (d.s[id] === 0) uncoveredLineSet.add(loc.start.line);
      }
      const uncoveredLines = [...uncoveredLineSet].sort((a, b) => a - b);

      nodeShellFiles[key] = {
        path: key,
        statements: rawStats.jsStatements!,
        branches: rawStats.jsBranches!,
        lines: { covered, total, pct: covered === 0 ? 0 : (covered / total) * 100 },
        uncoveredLines,
      };
      if (!fileCov.nodeShStepIstanbul) fileCov.nodeShStepIstanbul = {};
      fileCov.nodeShStepIstanbul[stepId] = d;
    }
    // Recompute nodeShellLines/nodeShellStatements/nodeShellBranches pct now that all steps are accumulated
    for (const fileCov of Object.values(files)) {
      if (fileCov.nodeShellLines && fileCov.nodeShellLines.total > 0) {
        fileCov.nodeShellLines.pct = (fileCov.nodeShellLines.covered / fileCov.nodeShellLines.total) * 100;
      }
      if (fileCov.nodeShellStatements && fileCov.nodeShellStatements.total > 0) {
        fileCov.nodeShellStatements.pct = (fileCov.nodeShellStatements.covered / fileCov.nodeShellStatements.total) * 100;
      }
      if (fileCov.nodeShellBranches && fileCov.nodeShellBranches.total > 0) {
        fileCov.nodeShellBranches.pct = (fileCov.nodeShellBranches.covered / fileCov.nodeShellBranches.total) * 100;
      }
    }

    return {
      files,
      jsFiles,
      pythonShellFiles,
      shShellFiles,
      bashShellFiles,
      pwshShellFiles,
      nodeShellFiles,
      total: aggregateTotals(Object.values(files), jsFiles, pythonShellFiles, shShellFiles, bashShellFiles, pwshShellFiles, nodeShellFiles),
    };
  }

  private _computeInputStat(path: string): CoverageStat {
    const record = this._inputData.get(path);
    if (!record) return { covered: 0, total: 0, pct: 100 };

    let total = 0;
    let covered = 0;
    for (const [name, def] of Object.entries(record.inputDefs)) {
      const counts = record.inputCounts[name] ?? { provided: 0, default: 0 };
      if (def.hasDefault) {
        total += 2;
        covered += (counts.provided > 0 ? 1 : 0) + (counts.default > 0 ? 1 : 0);
      } else {
        total += 1;
        covered += counts.provided > 0 ? 1 : 0;
      }
    }

    return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
  }

  private _buildInputTable(path: string): InputCoverageRow[] {
    const record = this._inputData.get(path);
    if (!record) return [];
    return Object.entries(record.inputDefs).map(([name, def]) => {
      const counts = record.inputCounts[name] ?? { provided: 0, default: 0 };
      return {
        name,
        hasDefault: def.hasDefault,
        coveredProvided: counts.provided > 0,
        coveredDefault: def.hasDefault ? (counts.provided > 0 && counts.default > 0) : true,
        providedCount: counts.provided,
        defaultCount: counts.default,
      };
    });
  }

  private _computeOutputStat(path: string): { stat: CoverageStat; table: OutputCoverageRow[] } {
    const record = this._outputData.get(path);
    if (!record) return { stat: { covered: 0, total: 0, pct: 100 }, table: [] };

    const table: OutputCoverageRow[] = Object.entries(record.counts).map(([name, count]) => ({
      name,
      covered: count > 0,
      count,
    }));
    const total = table.length;
    const covered = table.filter((r) => r.covered).length;
    return { stat: { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 }, table };
  }

  /** Serialize to a fragment object. */
  toFragment(): CoverageFragment {
    return {
      istanbulMap: this._map.toJSON(),
      inputExercises: Array.from(this._inputData.entries()).map(([path, data]) => ({
        path,
        inputCounts: data.inputCounts,
        inputDefs: data.inputDefs,
      })),
      outputExercises: Array.from(this._outputData.entries()).map(([path, data]) => ({
        path,
        counts: { ...data.counts },
      })),
      stepReachedExercises: Array.from(this._stepReachedData.entries()).map(([path, counts]) => ({
        path,
        counts: { ...counts },
      })),
      jsCoverageEntries: [...this._jsCoverageEntries],
      shShellCoverageEntries: Array.from(this._shShellCoverageData.entries()).map(([key, lineHits]) => ({
        key,
        lineHits: { ...lineHits },
      })),
      bashShellCoverageEntries: Array.from(this._bashShellCoverageData.entries()).map(([key, lineHits]) => ({
        key,
        lineHits: { ...lineHits },
      })),
      pwshShellCoverageEntries: Array.from(this._pwshShellCoverageData.entries()).map(([key, lineHits]) => ({
        key,
        lineHits: { ...lineHits },
      })),
      pythonShellCoverageEntries: Array.from(this._pythonShellCoverageData.entries()).map(([key, { pythonCoverageData, lineHits }]) => ({
        key,
        pythonCoverageData: { ...pythonCoverageData, executedLines: [...pythonCoverageData.executedLines], missingLines: [...pythonCoverageData.missingLines], executedBranches: [...pythonCoverageData.executedBranches], missingBranches: [...pythonCoverageData.missingBranches] },
        lineHits: { ...lineHits },
      })),
      nodeShellCoverageEntries: [...this._nodeShellCoverageEntries],
    };
  }

  /** Merge in coverage from another collector. */
  merge(other: CoverageCollector): void {
    this._jsCoverageEntries.push(...other._jsCoverageEntries);
    for (const [key, { pythonCoverageData, lineHits: otherHits }] of other._pythonShellCoverageData) {
      const hits = this._pythonShellCoverageData.get(key)?.lineHits ?? {};
      for (const [lineStr, count] of Object.entries(otherHits)) {
        const line = Number(lineStr);
        hits[line] = (hits[line] ?? 0) + count;
      }
      this._pythonShellCoverageData.set(key, { pythonCoverageData, lineHits: hits });
    }
    for (const [key, otherHits] of other._shShellCoverageData) {
      const existing = this._shShellCoverageData.get(key) ?? {};
      for (const [lineStr, count] of Object.entries(otherHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      this._shShellCoverageData.set(key, existing);
    }
    for (const [key, otherHits] of other._bashShellCoverageData) {
      const existing = this._bashShellCoverageData.get(key) ?? {};
      for (const [lineStr, count] of Object.entries(otherHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      this._bashShellCoverageData.set(key, existing);
    }
    for (const [key, otherHits] of other._pwshShellCoverageData) {
      const existing = this._pwshShellCoverageData.get(key) ?? {};
      for (const [lineStr, count] of Object.entries(otherHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      this._pwshShellCoverageData.set(key, existing);
    }
    for (const { key, entries } of other._nodeShellCoverageEntries) {
      const existing = this._nodeShellCoverageEntries.find((e) => e.key === key);
      if (existing) {
        existing.entries.push(...entries);
      } else {
        this._nodeShellCoverageEntries.push({ key, entries: [...entries] });
      }
    }
    this._map.merge(other._map as unknown as Parameters<CoverageMap['merge']>[0]);

    for (const [path, otherRecord] of other._outputData) {
      const existing = this._outputData.get(path);
      if (!existing) {
        this._outputData.set(path, { counts: { ...otherRecord.counts } });
      } else {
        for (const [name, count] of Object.entries(otherRecord.counts)) {
          existing.counts[name] = (existing.counts[name] ?? 0) + count;
        }
      }
    }

    for (const [path, otherRecord] of other._inputData) {
      const existing = this._inputData.get(path);
      if (!existing) {
        this._inputData.set(path, {
          inputCounts: Object.fromEntries(
            Object.entries(otherRecord.inputCounts).map(([k, v]) => [k, { ...v }]),
          ),
          inputDefs: { ...otherRecord.inputDefs },
        });
      } else {
        for (const [name, counts] of Object.entries(otherRecord.inputCounts)) {
          existing.inputCounts[name] = {
            provided: (existing.inputCounts[name]?.provided ?? 0) + counts.provided,
            default: (existing.inputCounts[name]?.default ?? 0) + counts.default,
          };
        }
        for (const [name, def] of Object.entries(otherRecord.inputDefs)) {
          if (!existing.inputDefs[name]) existing.inputDefs[name] = def;
        }
      }
    }

    for (const [path, otherCounts] of other._stepReachedData) {
      const existing = this._stepReachedData.get(path);
      if (!existing) {
        this._stepReachedData.set(path, { ...otherCounts });
      } else {
        for (const [stepId, count] of Object.entries(otherCounts)) {
          existing[stepId] = (existing[stepId] ?? 0) + count;
        }
      }
    }

  }

  /** Reset to empty. */
  reset(): void {
    this._map = createCoverageMap({}) as unknown as CoverageMap;
    this._inputData = new Map();
    this._outputData = new Map();
    this._stepReachedData = new Map();
    this._jsCoverageEntries = [];
    this._shShellCoverageData = new Map();
    this._bashShellCoverageData = new Map();
    this._pwshShellCoverageData = new Map();
    this._pythonShellCoverageData = new Map();
    this._nodeShellCoverageEntries = [];
  }

  /** Write the raw JSON coverage fragment to a file. */
  flush(outputDir: string, filename = 'coverage-actharness.json'): void {
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, filename), JSON.stringify(this.toFragment(), null, 2));
  }

  /** Reconstruct a CoverageCollector from a serialized fragment. */
  static fromParts(
    istanbulMap: unknown,
    inputExercises: InputExerciseEntry[],
    outputExercises: OutputExerciseEntry[] = [],
    stepReachedExercises: StepReachedEntry[] = [],
    jsCoverageEntries: JsCoverageEntry[] = [],
    shShellCoverageEntries: ShShellCoverageEntry[] = [],
    bashShellCoverageEntries: ShShellCoverageEntry[] = [],
    pwshShellCoverageEntries: ShShellCoverageEntry[] = [],
    pythonShellCoverageEntries: PythonShellCoverageEntry[] = [],
    nodeShellCoverageEntries: NodeShellCoverageEntry[] = [],
  ): CoverageCollector {
    const c = new CoverageCollector();
    (c._map as unknown as { merge(d: unknown): void }).merge(
      createCoverageMap(istanbulMap as Parameters<typeof createCoverageMap>[0]),
    );
    for (const entry of inputExercises) {
      c._inputData.set(entry.path, {
        inputCounts: Object.fromEntries(
          Object.entries(entry.inputCounts).map(([k, v]) => [k, { ...v }]),
        ),
        inputDefs: { ...entry.inputDefs },
      });
    }
    for (const entry of outputExercises) {
      c._outputData.set(entry.path, { counts: { ...entry.counts } });
    }
    for (const entry of stepReachedExercises) {
      c._stepReachedData.set(entry.path, { ...entry.counts });
    }
    c._jsCoverageEntries.push(...jsCoverageEntries);
    for (const entry of shShellCoverageEntries) {
      const existing = c._shShellCoverageData.get(entry.key) ?? {};
      for (const [lineStr, count] of Object.entries(entry.lineHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      c._shShellCoverageData.set(entry.key, existing);
    }
    for (const entry of bashShellCoverageEntries) {
      const existing = c._bashShellCoverageData.get(entry.key) ?? {};
      for (const [lineStr, count] of Object.entries(entry.lineHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      c._bashShellCoverageData.set(entry.key, existing);
    }
    for (const entry of pwshShellCoverageEntries) {
      const existing = c._pwshShellCoverageData.get(entry.key) ?? {};
      for (const [lineStr, count] of Object.entries(entry.lineHits)) {
        const line = Number(lineStr);
        existing[line] = (existing[line] ?? 0) + count;
      }
      c._pwshShellCoverageData.set(entry.key, existing);
    }
    for (const entry of pythonShellCoverageEntries) {
      const existing = c._pythonShellCoverageData.get(entry.key);
      const hits = existing?.lineHits ?? {};
      for (const [lineStr, count] of Object.entries(entry.lineHits)) {
        const line = Number(lineStr);
        hits[line] = (hits[line] ?? 0) + count;
      }
      c._pythonShellCoverageData.set(entry.key, { pythonCoverageData: entry.pythonCoverageData, lineHits: hits });
    }
    for (const { key, entries } of nodeShellCoverageEntries) {
      const existing = c._nodeShellCoverageEntries.find((e) => e.key === key);
      if (existing) {
        existing.entries.push(...entries);
      } else {
        c._nodeShellCoverageEntries.push({ key, entries: [...entries] });
      }
    }
    return c;
  }
}

export function aggregateTotals(
  files: FileCoverage[],
  jsFiles: Record<string, JsFileCoverage> = {},
  pythonShellFiles: Record<string, PythonShellFileCoverage> = {},
  shShellFiles: Record<string, ShShellFileCoverage> = {},
  bashShellFiles: Record<string, BashShellFileCoverage> = {},
  pwshShellFiles: Record<string, PwshShellFileCoverage> = {},
  nodeShellFiles: Record<string, NodeShellFileCoverage> = {},
): Record<CoverageMetric, CoverageStat> {
  let stepCovered = 0, stepTotal = 0;
  let branchCovered = 0, branchTotal = 0;
  let inputCovered = 0, inputTotal = 0;
  let outCovered = 0, outTotal = 0;
  let nodeShLnCovered = 0, nodeShLnTotal = 0;

  for (const f of files) {
    stepCovered += f.steps.covered;
    stepTotal += f.steps.total;
    branchCovered += f.ifBranches.covered;
    branchTotal += f.ifBranches.total;
    inputCovered += f.inputs.covered;
    inputTotal += f.inputs.total;
    outCovered += f.outputs.covered;
    outTotal += f.outputs.total;
    if (f.nodeShellLines) {
      nodeShLnCovered += f.nodeShellLines.covered;
      nodeShLnTotal += f.nodeShellLines.total;
    }
  }

  let shLnCovered = 0, shLnTotal = 0;
  for (const f of Object.values(shShellFiles)) {
    shLnCovered += f.lines.covered;
    shLnTotal += f.lines.total;
  }

  let bashLnCovered = 0, bashLnTotal = 0;
  for (const f of Object.values(bashShellFiles)) {
    bashLnCovered += f.lines.covered;
    bashLnTotal += f.lines.total;
  }

  let pwshLnCovered = 0, pwshLnTotal = 0;
  for (const f of Object.values(pwshShellFiles)) {
    pwshLnCovered += f.lines.covered;
    pwshLnTotal += f.lines.total;
  }

  let nodeShStmtCovered = 0, nodeShStmtTotal = 0;
  let nodeShBrCovered = 0, nodeShBrTotal = 0;
  for (const f of Object.values(nodeShellFiles)) {
    nodeShStmtCovered += f.statements.covered;
    nodeShStmtTotal += f.statements.total;
    nodeShBrCovered += f.branches.covered;
    nodeShBrTotal += f.branches.total;
  }

  let jsStmtCovered = 0, jsStmtTotal = 0;
  let jsBrCovered = 0, jsBrTotal = 0;
  let jsFnCovered = 0, jsFnTotal = 0;
  let jsLnCovered = 0, jsLnTotal = 0;

  for (const f of Object.values(jsFiles)) {
    jsStmtCovered += f.statements.covered;
    jsStmtTotal += f.statements.total;
    jsBrCovered += f.branches.covered;
    jsBrTotal += f.branches.total;
    jsFnCovered += f.functions.covered;
    jsFnTotal += f.functions.total;
    jsLnCovered += f.lines.covered;
    jsLnTotal += f.lines.total;
  }

  let pyStmtCovered = 0, pyStmtTotal = 0;
  let pyBrCovered = 0, pyBrTotal = 0;
  let pyLnCovered = 0, pyLnTotal = 0;

  for (const f of Object.values(pythonShellFiles)) {
    pyStmtCovered += f.statements.covered;
    pyStmtTotal += f.statements.total;
    pyBrCovered += f.branches.covered;
    pyBrTotal += f.branches.total;
    pyLnCovered += f.lines.covered;
    pyLnTotal += f.lines.total;
  }

  const pct = (c: number, t: number) => t === 0 ? 0 : (c / t) * 100;

  return {
    steps: { covered: stepCovered, total: stepTotal, pct: pct(stepCovered, stepTotal) },
    ifBranches: { covered: branchCovered, total: branchTotal, pct: pct(branchCovered, branchTotal) },
    inputs: { covered: inputCovered, total: inputTotal, pct: pct(inputCovered, inputTotal) },
    outputs: { covered: outCovered, total: outTotal, pct: pct(outCovered, outTotal) },
    jsStatements: { covered: jsStmtCovered, total: jsStmtTotal, pct: pct(jsStmtCovered, jsStmtTotal) },
    jsBranches: { covered: jsBrCovered, total: jsBrTotal, pct: pct(jsBrCovered, jsBrTotal) },
    jsFunctions: { covered: jsFnCovered, total: jsFnTotal, pct: pct(jsFnCovered, jsFnTotal) },
    jsLines: { covered: jsLnCovered, total: jsLnTotal, pct: pct(jsLnCovered, jsLnTotal) },
    shShellLines: { covered: shLnCovered, total: shLnTotal, pct: pct(shLnCovered, shLnTotal) },
    bashShellLines: { covered: bashLnCovered, total: bashLnTotal, pct: pct(bashLnCovered, bashLnTotal) },
    pwshShellLines: { covered: pwshLnCovered, total: pwshLnTotal, pct: pct(pwshLnCovered, pwshLnTotal) },
    nodeShellLines: { covered: nodeShLnCovered, total: nodeShLnTotal, pct: pct(nodeShLnCovered, nodeShLnTotal) },
    nodeShellStatements: { covered: nodeShStmtCovered, total: nodeShStmtTotal, pct: pct(nodeShStmtCovered, nodeShStmtTotal) },
    nodeShellBranches: { covered: nodeShBrCovered, total: nodeShBrTotal, pct: pct(nodeShBrCovered, nodeShBrTotal) },
    pythonShellStatements: { covered: pyStmtCovered, total: pyStmtTotal, pct: pct(pyStmtCovered, pyStmtTotal) },
    pythonShellBranches: { covered: pyBrCovered, total: pyBrTotal, pct: pct(pyBrCovered, pyBrTotal) },
    pythonShellLines: { covered: pyLnCovered, total: pyLnTotal, pct: pct(pyLnCovered, pyLnTotal) },
  };
}
