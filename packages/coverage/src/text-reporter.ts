// Custom actharness text coverage reporter.
// Prints a table using the domain CoverageReport — not Istanbul.

import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { parseAction } from '@actharness/core';
import { offsetToLoc } from './source-map.js';
import type { CoverageReport, CoverageStat, FileCoverage, JsIstanbulData, NodeShellFileCoverage, PythonShellFileCoverage, ShShellFileCoverage, BashShellFileCoverage, PwshShellFileCoverage } from './types.js';

function fmtPct(stat: CoverageStat, width = 6): string {
  if (stat.total === 0) return 'n/a'.padStart(width);
  return `${stat.pct.toFixed(1)}%`.padStart(width);
}

function fmtFraction(stat: CoverageStat, width = 10): string {
  if (stat.total === 0) return 'n/a'.padStart(width);
  return `${stat.covered}/${stat.total}`.padStart(width);
}

function bar(pct: number, width = 10): string {
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  const filled = Math.round((pct / 100) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function formatRanges(lines: number[]): string {
  if (lines.length === 0) return '';
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0]!, end = sorted[0]!;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]! === end + 1) { end = sorted[i]!; }
    else { ranges.push(start === end ? `${start}` : `${start}–${end}`); start = end = sorted[i]!; }
  }
  ranges.push(start === end ? `${start}` : `${start}–${end}`);
  return ranges.join(', ');
}

function trunc(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s.padEnd(max);
}

function computeUncoveredJsLines(d: JsIstanbulData): number[] {
  const s = new Set<number>();
  for (const [id, loc] of Object.entries(d.statementMap)) {
    if (d.s[id] === 0) s.add(loc.start.line);
  }
  return [...s].sort((a, b) => a - b);
}

function computeUncoveredYamlLinesForStep(path: string, scriptLines: number[]): number[] {
  const hashIdx = path.lastIndexOf('#');
  if (hashIdx === -1) return scriptLines;
  const actionFilePath = path.slice(0, hashIdx);
  const stepId = path.slice(hashIdx + 1);
  let source: string;
  try {
    source = readFileSync(actionFilePath, 'utf8');
  } catch {
    return scriptLines;
  }
  const lines = source.split('\n');
  let action;
  try {
    action = parseAction(actionFilePath);
  } catch {
    return scriptLines;
  }
  const steps = action.runs.steps ?? [];
  const stepIdx = steps.findIndex((s, i) => (s.id ?? `__step_${i + 1}__`) === stepId);
  if (stepIdx === -1) return scriptLines;
  const step = steps[stepIdx]!;
  if (!step._range || !step.run) return scriptLines;
  const stepStartLine = offsetToLoc(source, step._range.start).line;
  const stepEndLine = offsetToLoc(source, step._range.end).line;
  let runHeaderLine: number | undefined;
  let isBlockScalar = false;
  for (let l = stepStartLine; l <= stepEndLine; l++) {
    const yamlLine = lines[l - 1]!;
    if (/^\s+run\s*:/.test(yamlLine)) {
      runHeaderLine = l;
      isBlockScalar = /:\s*[|>]/.test(yamlLine);
      break;
    }
  }
  if (runHeaderLine === undefined) return scriptLines;
  return scriptLines.map((n) => isBlockScalar ? runHeaderLine! + n : runHeaderLine!);
}

function computeUncoveredYamlRunLines(
  fc: FileCoverage,
  source: string,
  lines: string[],
  steps: NonNullable<ReturnType<typeof parseAction>['runs']['steps']>,
): number[] {
  const uncovered: number[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!step.run || !step._range) continue;
    const stepId = step.id ?? `__step_${i + 1}__`;
    const stepStartLine = offsetToLoc(source, step._range.start).line;
    const stepEndLine = offsetToLoc(source, step._range.end).line;
    let runHeaderLine: number | undefined;
    let isBlockScalar = false;
    for (let l = stepStartLine; l <= stepEndLine; l++) {
      const yamlLine = lines[l - 1]!;
      if (/^\s+run\s*:/.test(yamlLine)) {
        runHeaderLine = l;
        isBlockScalar = /:\s*[|>]/.test(yamlLine);
        break;
      }
    }
    if (runHeaderLine === undefined) continue;
    const nodeShIstanbul = fc.nodeShStepIstanbul?.[stepId];
    if (nodeShIstanbul) {
      for (const [id, loc] of Object.entries(nodeShIstanbul.statementMap)) {
        if (nodeShIstanbul.s[id] === 0) {
          const yamlLineNum = isBlockScalar ? runHeaderLine + loc.start.line : runHeaderLine;
          uncovered.push(yamlLineNum);
        }
      }
      continue;
    }
    const hits = fc.shStepLineHits?.[stepId] ?? fc.bashStepLineHits?.[stepId] ?? fc.pwshStepLineHits?.[stepId] ?? fc.pyStepLineHits?.[stepId];
    if (!hits) continue;
    const scriptLines = step.run.split('\n');
    for (let scriptIdx = 0; scriptIdx < scriptLines.length; scriptIdx++) {
      const trimmed = scriptLines[scriptIdx]!.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const scriptLineNum = scriptIdx + 1;
      const yamlLineNum = isBlockScalar ? runHeaderLine + scriptLineNum : runHeaderLine;
      if ((hits[scriptLineNum] ?? 0) === 0) uncovered.push(yamlLineNum);
    }
  }
  // Unreached non-shell steps (uses: steps with 0 hits)
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.run || !step._range) continue;
    const stepId = step.id ?? `__step_${i + 1}__`;
    if ((fc.stepHits[stepId] ?? 0) === 0) {
      uncovered.push(offsetToLoc(source, step._range.start).line);
    }
  }
  return [...new Set(uncovered)].sort((a, b) => a - b);
}

/** Generate the full text table string for the coverage report. */
export function buildTextReport(report: CoverageReport, cwd = process.cwd()): string {
  const COL_FILE = 36;
  const COL_STAT = 14;
  const COL_UNCOV = 20;

  const row = (...cells: string[]) => `| ${cells.join(' | ')} |`;

  const header = row(
    'File'.padEnd(COL_FILE),
    'Steps'.padEnd(COL_STAT),
    'If-Branches'.padEnd(COL_STAT),
    'Inputs'.padEnd(COL_STAT),
    'Outputs'.padEnd(COL_STAT),
    'Uncov. Lines'.padEnd(COL_UNCOV),
  );

  const divider = '-'.repeat(header.length);

  const fileRows = Object.values(report.files)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
      let uncovRun = '';
      try {
        const src = readFileSync(f.path, 'utf8');
        const srcLines = src.split('\n');
        const act = parseAction(f.path);
        const steps = act.runs.steps ?? [];
        uncovRun = formatRanges(computeUncoveredYamlRunLines(f, src, srcLines, steps));
      } catch { /* leave empty */ }
      return row(
        rel,
        `${fmtPct(f.steps)} ${fmtFraction(f.steps, 7)}`.padStart(COL_STAT),
        `${fmtPct(f.ifBranches)} ${fmtFraction(f.ifBranches, 7)}`.padStart(COL_STAT),
        `${fmtPct(f.inputs)} ${fmtFraction(f.inputs, 7)}`.padStart(COL_STAT),
        `${fmtPct(f.outputs)} ${fmtFraction(f.outputs, 7)}`.padStart(COL_STAT),
        trunc(uncovRun, COL_UNCOV),
      );
    });

  const t = report.total;
  const totalRow = row(
    'All files'.padEnd(COL_FILE),
    `${fmtPct(t.steps)} ${fmtFraction(t.steps, 7)}`.padStart(COL_STAT),
    `${fmtPct(t.ifBranches)} ${fmtFraction(t.ifBranches, 7)}`.padStart(COL_STAT),
    `${fmtPct(t.inputs)} ${fmtFraction(t.inputs, 7)}`.padStart(COL_STAT),
    `${fmtPct(t.outputs)} ${fmtFraction(t.outputs, 7)}`.padStart(COL_STAT),
    ''.padEnd(COL_UNCOV),
  );

  const lines = [divider, header, divider, ...fileRows, divider, totalRow, divider];

  if (Object.keys(report.jsFiles).length > 0) {
    const jsHeader = row(
      'JS File'.padEnd(COL_FILE),
      'Stmts'.padEnd(COL_STAT),
      'Branches'.padEnd(COL_STAT),
      'Funcs'.padEnd(COL_STAT),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const jsDivider = '-'.repeat(jsHeader.length);

    const jsRows = Object.values(report.jsFiles)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncovJs = formatRanges(computeUncoveredJsLines(f.istanbulData));
        return row(
          rel,
          `${fmtPct(f.statements)} ${fmtFraction(f.statements, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.branches)} ${fmtFraction(f.branches, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.functions)} ${fmtFraction(f.functions, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT),
          trunc(uncovJs, COL_UNCOV),
        );
      });

    const jsTotalRow = row(
      'All JS files'.padEnd(COL_FILE),
      `${fmtPct(t.jsStatements)} ${fmtFraction(t.jsStatements, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.jsBranches)} ${fmtFraction(t.jsBranches, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.jsFunctions)} ${fmtFraction(t.jsFunctions, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.jsLines)} ${fmtFraction(t.jsLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', jsDivider, jsHeader, jsDivider, ...jsRows, jsDivider, jsTotalRow, jsDivider);
  }

  if (Object.keys(report.pythonShellFiles).length > 0) {
    const pyHeader = row(
      'Python Shell Step'.padEnd(COL_FILE),
      'Stmts'.padEnd(COL_STAT),
      'Branches'.padEnd(COL_STAT),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const pyDivider = '-'.repeat(pyHeader.length);

    const pyRows = (Object.values(report.pythonShellFiles) as PythonShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncovPy = formatRanges(computeUncoveredYamlLinesForStep(f.path, [...f.pythonCoverageData.missingLines].sort((a, b) => a - b)));
        return row(
          rel,
          `${fmtPct(f.statements)} ${fmtFraction(f.statements, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.branches)} ${fmtFraction(f.branches, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT),
          trunc(uncovPy, COL_UNCOV),
        );
      });

    const pyTotalRow = row(
      'All Python Shell steps'.padEnd(COL_FILE),
      `${fmtPct(t.pythonShellStatements)} ${fmtFraction(t.pythonShellStatements, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.pythonShellBranches)} ${fmtFraction(t.pythonShellBranches, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.pythonShellLines)} ${fmtFraction(t.pythonShellLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', pyDivider, pyHeader, pyDivider, ...pyRows, pyDivider, pyTotalRow, pyDivider);
  }

  if (Object.keys(report.nodeShellFiles).length > 0) {
    const nodeShHeader = row(
      'Node Shell Step'.padEnd(COL_FILE),
      'Stmts'.padEnd(COL_STAT),
      'Branches'.padEnd(COL_STAT),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const nodeShDivider = '-'.repeat(nodeShHeader.length);

    const nodeShRows = (Object.values(report.nodeShellFiles) as NodeShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncovNodeSh = formatRanges(f.uncoveredLines);
        return row(
          rel,
          `${fmtPct(f.statements)} ${fmtFraction(f.statements, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.branches)} ${fmtFraction(f.branches, 7)}`.padStart(COL_STAT),
          `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT),
          trunc(uncovNodeSh, COL_UNCOV),
        );
      });

    const nodeShTotalRow = row(
      'All Node Shell steps'.padEnd(COL_FILE),
      `${fmtPct(t.nodeShellStatements)} ${fmtFraction(t.nodeShellStatements, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.nodeShellBranches)} ${fmtFraction(t.nodeShellBranches, 7)}`.padStart(COL_STAT),
      `${fmtPct(t.nodeShellLines)} ${fmtFraction(t.nodeShellLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', nodeShDivider, nodeShHeader, nodeShDivider, ...nodeShRows, nodeShDivider, nodeShTotalRow, nodeShDivider);
  }

  if (Object.keys(report.shShellFiles).length > 0) {
    const shHeader = row(
      'Sh Shell Step'.padEnd(COL_FILE),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const shDivider = '-'.repeat(shHeader.length);

    const shRows = (Object.values(report.shShellFiles) as ShShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncov = formatRanges(computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return row(rel, `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT), trunc(uncov, COL_UNCOV));
      });

    const shTotalRow = row(
      'All Sh Shell steps'.padEnd(COL_FILE),
      `${fmtPct(t.shShellLines)} ${fmtFraction(t.shShellLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', shDivider, shHeader, shDivider, ...shRows, shDivider, shTotalRow, shDivider);
  }

  if (Object.keys(report.bashShellFiles).length > 0) {
    const bashHeader = row(
      'Bash Shell Step'.padEnd(COL_FILE),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const bashDivider = '-'.repeat(bashHeader.length);

    const bashRows = (Object.values(report.bashShellFiles) as BashShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncov = formatRanges(computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return row(rel, `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT), trunc(uncov, COL_UNCOV));
      });

    const bashTotalRow = row(
      'All Bash Shell steps'.padEnd(COL_FILE),
      `${fmtPct(t.bashShellLines)} ${fmtFraction(t.bashShellLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', bashDivider, bashHeader, bashDivider, ...bashRows, bashDivider, bashTotalRow, bashDivider);
  }

  if (Object.keys(report.pwshShellFiles).length > 0) {
    const pwshHeader = row(
      'Pwsh Shell Step'.padEnd(COL_FILE),
      'Lines'.padEnd(COL_STAT),
      'Uncov. Lines'.padEnd(COL_UNCOV),
    );
    const pwshDivider = '-'.repeat(pwshHeader.length);

    const pwshRows = (Object.values(report.pwshShellFiles) as PwshShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path).padEnd(COL_FILE).slice(0, COL_FILE);
        const uncov = formatRanges(computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return row(rel, `${fmtPct(f.lines)} ${fmtFraction(f.lines, 7)}`.padStart(COL_STAT), trunc(uncov, COL_UNCOV));
      });

    const pwshTotalRow = row(
      'All Pwsh Shell steps'.padEnd(COL_FILE),
      `${fmtPct(t.pwshShellLines)} ${fmtFraction(t.pwshShellLines, 7)}`.padStart(COL_STAT),
      ''.padEnd(COL_UNCOV),
    );

    lines.push('', pwshDivider, pwshHeader, pwshDivider, ...pwshRows, pwshDivider, pwshTotalRow, pwshDivider);
  }

  return lines.join('\n');
}

/** Generate a short single-line summary. */
export function buildTextSummary(report: CoverageReport): string {
  const t = report.total;
  const parts: string[] = [];
  if (t.steps.total > 0) parts.push(`Steps: ${t.steps.pct.toFixed(1)}% ${bar(t.steps.pct)}`);
  if (t.ifBranches.total > 0) parts.push(`If-Branches: ${t.ifBranches.pct.toFixed(1)}% ${bar(t.ifBranches.pct)}`);
  if (t.inputs.total > 0) parts.push(`Inputs: ${t.inputs.pct.toFixed(1)}% ${bar(t.inputs.pct)}`);
  if (t.outputs.total > 0) parts.push(`Outputs: ${t.outputs.pct.toFixed(1)}% ${bar(t.outputs.pct)}`);
  return parts.length === 0 ? 'No coverage data.' : parts.join('  |  ');
}
