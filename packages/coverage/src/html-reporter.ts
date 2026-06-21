// Custom actharness HTML coverage reporter.
// Generates self-contained HTML using the domain CoverageReport — not Istanbul.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { parseAction } from '@actharness/core';
import { offsetToLoc } from './source-map.js';
import type { CoverageReport, FileCoverage, JsFileCoverage, JsIstanbulData, NodeShellFileCoverage, ShShellFileCoverage, BashShellFileCoverage, PwshShellFileCoverage, IfBranchRow, InputCoverageRow, OutputCoverageRow } from './types.js';

// ── Icon ──────────────────────────────────────────────────────────────────────
// actharness icon.png (repo root), base64-inlined so report pages stay self-contained.
// Regenerate with: base64 -i icon.png

const ICON_BASE64 =
  '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';

const ICON_DATA_URI = `data:image/png;base64,${ICON_BASE64}`;

// ── CSS ───────────────────────────────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#f6f8fa;color:#24292f;line-height:1.5}
a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}
h1{font-size:18px;font-weight:600;padding:16px 24px;border-bottom:1px solid #d0d7de;background:#fff;display:flex;align-items:center;gap:10px}
h1 img{width:24px;height:24px;border-radius:4px}
h2{font-size:14px;font-weight:600;margin-bottom:8px}
h3{font-size:12px;font-weight:600;color:#57606a;text-transform:uppercase;letter-spacing:.05em;margin:16px 0 6px}
nav{padding:12px 24px;background:#fff;border-bottom:1px solid #d0d7de;font-size:12px}
.container{max-width:1200px;margin:0 auto;padding:24px}
.metrics-bar{display:flex;gap:12px;margin-bottom:20px;flex-wrap:wrap}
.metric-chip{padding:6px 14px;border-radius:20px;font-size:12px;font-weight:600;white-space:nowrap}
.chip-high{background:#dafbe1;color:#1a7f37;border:1px solid #aef0b8}
.chip-medium{background:#fff8c5;color:#7d4e00;border:1px solid #f5d56e}
.chip-low{background:#ffebe9;color:#cf222e;border:1px solid #ffcecb}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #d0d7de;border-radius:6px;overflow:hidden}
th{background:#f6f8fa;padding:8px 12px;text-align:left;font-weight:600;font-size:12px;color:#57606a;border-bottom:1px solid #d0d7de}
td{padding:8px 12px;border-bottom:1px solid #eaecef;vertical-align:top}
tr:last-child td{border-bottom:none}
tr.tfoot td{background:#f6f8fa;font-weight:600;border-top:2px solid #d0d7de}
.pct-high{color:#1a7f37;font-weight:600}
.pct-medium{color:#7d4e00;font-weight:600}
.pct-low{color:#cf222e;font-weight:600}
.source-view{background:#fff;border:1px solid #d0d7de;border-radius:6px;overflow:auto;margin-bottom:20px}
.source-table{width:100%;border-collapse:collapse;table-layout:fixed}
.source-table td{padding:0;vertical-align:top}
.source-table td:first-child{width:52px}
.source-table td:nth-child(2){width:52px}
.line-num{display:block;min-width:48px;padding:1px 10px 1px 8px;text-align:right;color:#8c959f;user-select:none;border-right:1px solid #eaecef;background:#f6f8fa}
.line-content{display:block;padding:1px 12px;white-space:pre;flex:1}
.cov-hit{background:#e6ffec}
.cov-miss{background:#ffebe9}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:11px;font-weight:600;margin:2px}
.pill-green{background:#dafbe1;color:#1a7f37;border:1px solid #aef0b8}
.pill-red{background:#ffebe9;color:#cf222e;border:1px solid #ffcecb}
.pill-gray{background:#eaecef;color:#57606a;border:1px solid #d0d7de}
.section{margin-bottom:20px}
.cov-line-cov{padding:0;background:#f6f8fa;border-right:1px solid #eaecef;vertical-align:top;white-space:nowrap}
.cline-any{display:block;padding:0 5px;text-align:right;min-width:40px}
.cline-yes{background:rgb(230,245,208)}
.cline-no{background:#FCE1E5}
.cstat-no,.fstat-no{background:#F6C6CE}
.cbranch-no{background:yellow;color:#111}
.missing-if-branch{display:inline-block;margin-right:4px;border-radius:3px;color:yellow;background:#333;padding:0 4px;font-weight:bold}
`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function pctClass(pct: number): string {
  if (pct >= 80) return 'pct-high';
  if (pct >= 50) return 'pct-medium';
  return 'pct-low';
}

function chipClass(pct: number): string {
  if (pct >= 80) return 'chip-high';
  if (pct >= 50) return 'chip-medium';
  return 'chip-low';
}

function fmtStat(stat: { covered: number; total: number; pct: number }): string {
  if (stat.total === 0) return '<span class="pct-high">n/a</span>';
  return `<span class="${pctClass(stat.pct)}">${stat.covered}/${stat.total} (${stat.pct.toFixed(1)}%)</span>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function page(title: string, nav: string, body: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title><link rel="icon" type="image/png" href="${ICON_DATA_URI}"><style>${CSS}</style></head><body>
<h1><img src="${ICON_DATA_URI}" alt="">${esc(title)}</h1>
${nav}
<div class="container">${body}</div>
</body></html>`;
}

// ── Line range formatter ──────────────────────────────────────────────────────

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

function _computeUncoveredJsLines(d: JsIstanbulData): number[] {
  const s = new Set<number>();
  for (const [id, loc] of Object.entries(d.statementMap)) {
    if (d.s[id] === 0) s.add(loc.start.line);
  }
  return [...s].sort((a, b) => a - b);
}

function _computeUncoveredYamlLinesForStep(path: string, scriptLines: number[]): number[] {
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

function _computeUncoveredYamlRunLines(
  fc: FileCoverage,
  source: string,
  lines: string[],
  steps: NonNullable<ReturnType<typeof parseAction>['runs']['steps']>,
): number[] {
  const lineShPwshCoverage = new Map<number, number>();
  const lineNodeShAnnotated = new Map<number, { sLine: _SLine; prefix: string }>();
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
      const scriptLines = step.run.split(/(?:\r?\n)|\r/);
      const structured = _buildStructured(scriptLines);
      _annotateLines(nodeShIstanbul, structured);
      _annotateBranches(nodeShIstanbul, structured);
      _annotateFunctions(nodeShIstanbul, structured);
      _annotateStatements(nodeShIstanbul, structured);
      structured.shift();
      for (let scriptIdx = 0; scriptIdx < scriptLines.length; scriptIdx++) {
        const yamlLineNum = isBlockScalar ? runHeaderLine + scriptIdx + 1 : runHeaderLine;
        const yamlLineContent = lines[yamlLineNum - 1]!;
        const scriptLine = scriptLines[scriptIdx]!;
        const yamlIndentLen = yamlLineContent.length - yamlLineContent.trimStart().length;
        const scriptIndentLen = scriptLine.length - scriptLine.trimStart().length;
        const prefix = yamlLineContent.slice(0, Math.max(0, yamlIndentLen - scriptIndentLen));
        lineNodeShAnnotated.set(yamlLineNum, { sLine: structured[scriptIdx]!, prefix });
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
      lineShPwshCoverage.set(yamlLineNum, hits[scriptLineNum] ?? 0);
    }
  }
  const uncovered: number[] = [];
  for (const [lineNum, count] of lineShPwshCoverage) {
    if (count === 0) uncovered.push(lineNum);
  }
  for (const [lineNum, { sLine }] of lineNodeShAnnotated) {
    if (sLine.covered === 'no') uncovered.push(lineNum);
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

// ── Index page ────────────────────────────────────────────────────────────────

export function buildIndexHtml(report: CoverageReport, cwd: string): string {
  const zeroStat = { covered: 0, total: 0, pct: 0 };
  const rows = Object.values(report.files)
    .sort((a, b) => a.path.localeCompare(b.path))
    .map((f) => {
      const rel = relative(cwd, f.path);
      let uncovRun = '';
      try {
        const src = readFileSync(f.path, 'utf8');
        const srcLines = src.split('\n');
        const act = parseAction(f.path);
        const steps = act.runs.steps ?? [];
        uncovRun = formatRanges(_computeUncoveredYamlRunLines(f, src, srcLines, steps));
      } catch { /* leave empty */ }
      return `<tr>
  <td><a href="${rel}.html">${esc(rel)}</a></td>
  <td>${fmtStat(f.steps)}</td>
  <td>${fmtStat(f.ifBranches)}</td>
  <td>${fmtStat(f.inputs)}</td>
  <td>${fmtStat(f.outputs)}</td>
  <td>${esc(uncovRun)}</td>
</tr>`;
    })
    .join('\n');

  const t = report.total;
  let body = `
<div class="section">
<table>
<thead><tr><th>File</th><th>Steps</th><th>If-Branches</th><th>Inputs</th><th>Outputs</th><th>Uncovered Lines</th></tr></thead>
<tbody>${rows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.steps)}</td>
  <td>${fmtStat(t.ifBranches)}</td>
  <td>${fmtStat(t.inputs)}</td>
  <td>${fmtStat(t.outputs)}</td>
  <td></td>
</tr>
</table>
</div>`;

  if (Object.keys(report.jsFiles).length > 0) {
    const jsRows = Object.values(report.jsFiles)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const uncovJs = formatRanges(_computeUncoveredJsLines(f.istanbulData));
        return `<tr>
  <td><a href="${rel}.html">${esc(rel)}</a></td>
  <td>${fmtStat(f.statements)}</td>
  <td>${fmtStat(f.branches)}</td>
  <td>${fmtStat(f.functions)}</td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncovJs)}</td>
</tr>`;
      })
      .join('\n');

    body += `
<div class="section">
<h2>JS Coverage (V8)</h2>
<table>
<thead><tr><th>File</th><th>Stmts</th><th>Branches</th><th>Functions</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${jsRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.jsStatements)}</td>
  <td>${fmtStat(t.jsBranches)}</td>
  <td>${fmtStat(t.jsFunctions)}</td>
  <td>${fmtStat(t.jsLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  if (Object.keys(report.pythonShellFiles).length > 0) {
    const pyRows = Object.values(report.pythonShellFiles)
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const hi = f.path.lastIndexOf('#');
        const href = `${relative(cwd, f.path.slice(0, hi))}.html#step-${f.path.slice(hi + 1)}`;
        const uncovPy = formatRanges(_computeUncoveredYamlLinesForStep(f.path, [...f.pythonCoverageData.missingLines].sort((a, b) => a - b)));
        return `<tr>
  <td><a href="${esc(href)}">${esc(rel)}</a></td>
  <td>${fmtStat(f.statements)}</td>
  <td>${fmtStat(f.branches)}</td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncovPy)}</td>
</tr>`;
      })
      .join('\n');

    body += `
<div class="section">
<h2>Python Shell Coverage (coverage.py)</h2>
<table>
<thead><tr><th>Step</th><th>Stmts</th><th>Branches</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${pyRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.pythonShellStatements)}</td>
  <td>${fmtStat(t.pythonShellBranches)}</td>
  <td>${fmtStat(t.pythonShellLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  if (Object.keys(report.nodeShellFiles).length > 0) {
    const nodeShRows = (Object.values(report.nodeShellFiles) as NodeShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const hi = f.path.lastIndexOf('#');
        const href = `${relative(cwd, f.path.slice(0, hi))}.html#step-${f.path.slice(hi + 1)}`;
        const uncovNodeSh = formatRanges(f.uncoveredLines);
        return `<tr>
  <td><a href="${esc(href)}">${esc(rel)}</a></td>
  <td>${fmtStat(f.statements)}</td>
  <td>${fmtStat(f.branches)}</td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncovNodeSh)}</td>
</tr>`;
      })
      .join('\n');

    body += `
<div class="section">
<h2>Node Shell Coverage (V8)</h2>
<table>
<thead><tr><th>Step</th><th>Stmts</th><th>Branches</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${nodeShRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.nodeShellStatements)}</td>
  <td>${fmtStat(t.nodeShellBranches)}</td>
  <td>${fmtStat(t.nodeShellLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  if (Object.keys(report.shShellFiles).length > 0) {
    const shRows = (Object.values(report.shShellFiles) as ShShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const hi = f.path.lastIndexOf('#');
        const href = `${relative(cwd, f.path.slice(0, hi))}.html#step-${f.path.slice(hi + 1)}`;
        const uncov = formatRanges(_computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return `<tr>
  <td><a href="${esc(href)}">${esc(rel)}</a></td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncov)}</td>
</tr>`;
      })
      .join('\n');
    body += `
<div class="section">
<h2>Sh Shell Coverage</h2>
<table>
<thead><tr><th>Step</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${shRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.shShellLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  if (Object.keys(report.bashShellFiles).length > 0) {
    const bashRows = (Object.values(report.bashShellFiles) as BashShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const hi = f.path.lastIndexOf('#');
        const href = `${relative(cwd, f.path.slice(0, hi))}.html#step-${f.path.slice(hi + 1)}`;
        const uncov = formatRanges(_computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return `<tr>
  <td><a href="${esc(href)}">${esc(rel)}</a></td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncov)}</td>
</tr>`;
      })
      .join('\n');
    body += `
<div class="section">
<h2>Bash Shell Coverage</h2>
<table>
<thead><tr><th>Step</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${bashRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.bashShellLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  if (Object.keys(report.pwshShellFiles).length > 0) {
    const pwshRows = (Object.values(report.pwshShellFiles) as PwshShellFileCoverage[])
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((f) => {
        const rel = relative(cwd, f.path);
        const hi = f.path.lastIndexOf('#');
        const href = `${relative(cwd, f.path.slice(0, hi))}.html#step-${f.path.slice(hi + 1)}`;
        const uncov = formatRanges(_computeUncoveredYamlLinesForStep(f.path, f.uncoveredLines));
        return `<tr>
  <td><a href="${esc(href)}">${esc(rel)}</a></td>
  <td>${fmtStat(f.lines)}</td>
  <td>${esc(uncov)}</td>
</tr>`;
      })
      .join('\n');
    body += `
<div class="section">
<h2>Pwsh Shell Coverage</h2>
<table>
<thead><tr><th>Step</th><th>Lines</th><th>Uncovered Lines</th></tr></thead>
<tbody>${pwshRows}</tbody>
<tr class="tfoot">
  <td>Total</td>
  <td>${fmtStat(t.pwshShellLines)}</td>
  <td></td>
</tr>
</table>
</div>`;
  }

  return page('actharness coverage', '', body);
}

// ── Shared source table ───────────────────────────────────────────────────────

function _sourceRow(lineNum: number, covClass: string, countClass: string, countText: string, content: string, rowId?: string): string {
  const id = rowId ? ` id="${rowId}"` : '';
  return `<tr${id}><td><span class="line-num">${lineNum}</span></td><td class="cov-line-cov"><span class="cline-any ${countClass}">${countText}</span></td><td class="${covClass}"><span class="line-content">${content}</span></td></tr>`;
}

function _sourceTable(rows: string[]): string {
  return `<div class="source-view"><table class="source-table"><tbody>${rows.join('\n')}</tbody></table></div>`;
}

// ── Per-file page ─────────────────────────────────────────────────────────────

interface StepAnnotation {
  startLine: number;
  endLine: number;
  ifLine?: number | undefined;
  stepId: string;
  hits: number;
  reached: number;
  ifBranch?: IfBranchRow | undefined;
}

interface LineInputAnnotation {
  row: InputCoverageRow;
  isFirst: boolean;
  isDefault: boolean;
}

interface LineOutputAnnotation {
  row: OutputCoverageRow;
  isFirst: boolean;
}

export function buildFileHtml(
  fc: FileCoverage,
  cwd: string,
): string {
  const rel = relative(cwd, fc.path);

  // ── Metrics bar ──
  const metricsBarEntries: { label: string; stat: import('./types.js').CoverageStat }[] = [
    { label: 'Steps', stat: fc.steps },
    { label: 'If-Branches', stat: fc.ifBranches },
    { label: 'Inputs', stat: fc.inputs },
    { label: 'Outputs', stat: fc.outputs },
  ];
  if (fc.nodeShellLines && fc.nodeShellLines.total > 0) metricsBarEntries.push({ label: 'Node Lines', stat: fc.nodeShellLines });
  const metricsBar = metricsBarEntries
    .map(({ label, stat }) => {
      const text = stat.total === 0
        ? `${label}: n/a`
        : `${label}: ${stat.covered}/${stat.total} (${stat.pct.toFixed(1)}%)`;
      return `<span class="metric-chip ${chipClass(stat.total === 0 ? 100 : stat.pct)}">${text}</span>`;
    })
    .join('');

  // ── Source view ──
  let uncovChip = '';
  let sourceSection = '';
  try {
    const source = readFileSync(fc.path, 'utf8');
    const lines = source.split('\n');

    // Parse action to get step ranges
    const action = parseAction(fc.path);
    const steps = action.runs.steps ?? [];
    const uncovYamlLines = _computeUncoveredYamlRunLines(fc, source, lines, steps);
    const uncovText = formatRanges(uncovYamlLines);
    uncovChip = `<span class="metric-chip ${uncovYamlLines.length > 0 ? 'chip-low' : 'chip-high'}">Uncov. Lines: ${esc(uncovText || '(none)')}</span>`;

    // Build step annotations indexed by step
    const annotations: StepAnnotation[] = [];
    const ifBranchByStep = new Map(fc.ifBranchTable.map((r) => [r.step, r]));

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const stepId = step.id ?? `__step_${i + 1}__`;
      const hits = fc.stepHits[stepId] ?? 0;
      const reached = fc.stepReached[stepId] ?? 0;

      // parseAction always sets _range for composite steps
      const startLine = offsetToLoc(source, step._range!.start).line;
      const endLine = offsetToLoc(source, step._range!.end).line;

      let ifLine: number | undefined;
      if (step._ifRange) {
        ifLine = offsetToLoc(source, step._ifRange.start).line;
      }

      annotations.push({
        startLine,
        endLine,
        ifLine,
        stepId,
        hits,
        reached,
        ifBranch: ifBranchByStep.get(stepId),
      });
    }

    // Node-action phases (runs.main / pre / post) — same annotation shape as
    // composite steps above, keyed by phase name instead of step id.
    if (!action.runs.steps && action.runs.main) {
      const phases: { phase: 'pre' | 'main' | 'post'; entrypoint: string | undefined; range: typeof action.runs._mainRange; ifRange: typeof action.runs._preIfRange }[] = [
        { phase: 'pre', entrypoint: action.runs.pre, range: action.runs._preRange, ifRange: action.runs._preIfRange },
        { phase: 'main', entrypoint: action.runs.main, range: action.runs._mainRange, ifRange: undefined },
        { phase: 'post', entrypoint: action.runs.post, range: action.runs._postRange, ifRange: action.runs._postIfRange },
      ];

      for (const { phase, entrypoint, range, ifRange } of phases) {
        if (!entrypoint || !range) continue;
        const hits = fc.stepHits[phase] ?? 0;
        const reached = fc.stepReached[phase] ?? 0;

        const startLine = offsetToLoc(source, range.start).line;
        const endLine = offsetToLoc(source, range.end).line;

        let ifLine: number | undefined;
        if (ifRange) {
          ifLine = offsetToLoc(source, ifRange.start).line;
        }

        annotations.push({
          startLine,
          endLine,
          ifLine,
          stepId: phase,
          hits,
          reached,
          ifBranch: ifBranchByStep.get(phase),
        });
      }
    }

    // Build a map: line number → step annotation
    const lineAnnotation = new Map<number, StepAnnotation>();
    for (const ann of annotations) {
      for (let l = ann.startLine; l <= ann.endLine; l++) {
        lineAnnotation.set(l, ann);
      }
      // For node-action phases, `pre-if:`/`post-if:` are separate top-level keys from
      // `pre:`/`post:`, so ifLine can fall outside [startLine, endLine] — unlike composite
      // steps, where `if:` is nested inside the step block range.
      if (ann.ifLine !== undefined && !lineAnnotation.has(ann.ifLine)) {
        lineAnnotation.set(ann.ifLine, ann);
      }
    }

    // Build a map: line number → input annotation
    const lineInputAnnotation = new Map<number, LineInputAnnotation>();
    const inputByName = new Map(fc.inputTable.map((r) => [r.name, r]));
    for (const [name, def] of Object.entries(action.inputs ?? {})) {
      if (!def._range) continue;
      const row = inputByName.get(name);
      if (!row) continue;
      const startLine = offsetToLoc(source, def._range.start).line;
      const endLine = offsetToLoc(source, def._range.end).line;
      let defaultLine: number | undefined;
      if (row.hasDefault) {
        for (let l = startLine; l <= endLine; l++) {
          if (/^\s+default\s*:/.test(lines[l - 1]!)) { defaultLine = l; break; }
        }
      }
      for (let l = startLine; l <= endLine; l++) {
        lineInputAnnotation.set(l, { row, isFirst: l === startLine, isDefault: l === defaultLine });
      }
    }

    // Build a map: line number → output annotation
    const lineOutputAnnotation = new Map<number, LineOutputAnnotation>();
    const outputByName = new Map(fc.outputTable.map((r) => [r.name, r]));
    for (const [name, def] of Object.entries(action.outputs ?? {})) {
      const row = outputByName.get(name);
      if (!row) continue;
      const valStartLine = offsetToLoc(source, def._range!.start).line;
      const endLine = offsetToLoc(source, def._range!.end).line;
      // The output key line (e.g. `  greeting:`) is one line above the value map.
      const firstLine = Math.max(valStartLine - 1, 1);
      for (let l = firstLine; l <= endLine; l++) {
        lineOutputAnnotation.set(l, { row, isFirst: l === firstLine });
      }
    }

    // Build maps for inline run: block coverage annotation.
    // lineShPwshCoverage: YAML line → hit count for sh/bash/pwsh/py steps.
    // lineNodeShAnnotated: YAML line → Istanbul-annotated _SLine for shell:node steps.
    const lineShPwshCoverage = new Map<number, number>();
    const lineNodeShAnnotated = new Map<number, { sLine: _SLine; prefix: string }>();
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (!step.run || !step._range) continue;
      const stepId = step.id ?? `__step_${i + 1}__`;

      const stepStartLine = offsetToLoc(source, step._range.start).line;
      const stepEndLine = offsetToLoc(source, step._range.end).line;

      // Find the `run:` key line within this step's YAML range.
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
        // shell:node: full Istanbul annotation inline
        const scriptLines = step.run.split(/(?:\r?\n)|\r/);
        const structured = _buildStructured(scriptLines);
        _annotateLines(nodeShIstanbul, structured);
        _annotateBranches(nodeShIstanbul, structured);
        _annotateFunctions(nodeShIstanbul, structured);
        _annotateStatements(nodeShIstanbul, structured);
        structured.shift(); // remove leading dummy
        for (let scriptIdx = 0; scriptIdx < scriptLines.length; scriptIdx++) {
          const yamlLineNum = isBlockScalar ? runHeaderLine + scriptIdx + 1 : runHeaderLine;
          const yamlLineContent = lines[yamlLineNum - 1]!;
          const scriptLine = scriptLines[scriptIdx]!;
          const yamlIndentLen = yamlLineContent.length - yamlLineContent.trimStart().length;
          const scriptIndentLen = scriptLine.length - scriptLine.trimStart().length;
          const prefix = yamlLineContent.slice(0, Math.max(0, yamlIndentLen - scriptIndentLen));
          lineNodeShAnnotated.set(yamlLineNum, { sLine: structured[scriptIdx]!, prefix });
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
        lineShPwshCoverage.set(yamlLineNum, hits[scriptLineNum] ?? 0);
      }
    }

    const lineHtml = lines.map((content, idx) => {
      const lineNum = idx + 1;
      const ann = lineAnnotation.get(lineNum);
      const inputAnn = lineInputAnnotation.get(lineNum);
      const outputAnn = lineOutputAnnotation.get(lineNum);
      const isFirstLine = ann?.startLine === lineNum;
      const isIfLine = ann?.ifLine !== undefined && ann.ifLine === lineNum;
      const shPwshCount = lineShPwshCoverage.get(lineNum);
      const nodeShEntry = lineNodeShAnnotated.get(lineNum);

      const rowId = (ann !== undefined && isFirstLine) ? `step-${ann.stepId}` : undefined;

      // shell:node lines: full Istanbul annotation with YAML indentation prefix
      if (nodeShEntry !== undefined) {
        const { sLine: nodeShLine, prefix } = nodeShEntry;
        const covClass = nodeShLine.covered === 'yes' ? ' cov-hit' : nodeShLine.covered === 'no' ? ' cov-miss' : '';
        const countClass = nodeShLine.covered === 'neutral' ? 'cline-neutral' : nodeShLine.hits > 0 ? 'cline-yes' : 'cline-no';
        const countText = nodeShLine.covered === 'neutral' ? '&nbsp;' : `${nodeShLine.hits}x`;
        return _sourceRow(lineNum, covClass, countClass, countText, `${esc(prefix)}${_codeEsc(nodeShLine.text.toString())}`, rowId);
      }

      let covClass = '';
      let countText = '&nbsp;';
      let countClass = 'cline-neutral';

      if (content.trim() !== '') {
        if (shPwshCount !== undefined) {
          covClass = shPwshCount > 0 ? ' cov-hit' : ' cov-miss';
          countText = `${shPwshCount}x`;
          countClass = shPwshCount > 0 ? 'cline-yes' : 'cline-no';
        } else if (ann) {
          if (isIfLine && ann.ifBranch) {
            covClass = ann.reached > 0 ? ' cov-hit' : ' cov-miss';
            countText = `${ann.reached}x`;
            countClass = ann.reached > 0 ? 'cline-yes' : 'cline-no';
          } else if (isFirstLine && !ann.ifLine && ann.ifBranch) {
            covClass = ann.hits > 0 ? ' cov-hit' : ' cov-miss';
            countText = `${ann.ifBranch.trueCount}x`;
            countClass = ann.ifBranch.trueCount > 0 ? 'cline-yes' : 'cline-no';
          } else if (isFirstLine) {
            covClass = ann.reached > 0 ? ' cov-hit' : ' cov-miss';
            countText = `${ann.reached}x`;
            countClass = ann.reached > 0 ? 'cline-yes' : 'cline-no';
          } else if (!isIfLine) {
            covClass = ann.hits > 0 ? ' cov-hit' : ' cov-miss';
            countText = `${ann.hits}x`;
            countClass = ann.hits > 0 ? 'cline-yes' : 'cline-no';
          }
        } else if (inputAnn) {
          if (inputAnn.isDefault) {
            covClass = inputAnn.row.coveredDefault ? ' cov-hit' : ' cov-miss';
            countText = `${inputAnn.row.defaultCount}x`;
            countClass = inputAnn.row.defaultCount > 0 ? 'cline-yes' : 'cline-no';
          } else {
            covClass = inputAnn.row.coveredProvided ? ' cov-hit' : ' cov-miss';
            countText = `${inputAnn.row.providedCount}x`;
            countClass = inputAnn.row.providedCount > 0 ? 'cline-yes' : 'cline-no';
          }
        } else if (outputAnn) {
          covClass = outputAnn.row.covered ? ' cov-hit' : ' cov-miss';
          countText = `${outputAnn.row.count}x`;
          countClass = outputAnn.row.count > 0 ? 'cline-yes' : 'cline-no';
        }
      }

      return _sourceRow(lineNum, covClass, countClass, countText, esc(content), rowId);
    });

    sourceSection = `
<div class="section">
<h2>Source</h2>
${_sourceTable(lineHtml)}
</div>`;
  } catch {
    sourceSection = `<p style="color:#cf222e">Could not read source: ${esc(fc.path)}</p>`;
  }

  // ── If-branch table ──
  let ifSection = '';
  if (fc.ifBranchTable.length > 0) {
    const rows = fc.ifBranchTable.map((r) => {
      const tBadge = r.trueCount > 0
        ? '<span class="pill pill-green">T ✓</span>'
        : '<span class="pill pill-red">T ✗</span>';
      const fBadge = r.falseBranchImpossible
        ? '<span class="pill pill-gray">F n/a</span>'
        : r.falseCount > 0
          ? '<span class="pill pill-green">F ✓</span>'
          : '<span class="pill pill-red">F ✗</span>';
      return `<tr>
  <td>${esc(r.step)}</td>
  <td>${esc(r.expression)}</td>
  <td>${tBadge} ${fBadge}</td>
</tr>`;
    }).join('\n');
    ifSection = `
<div class="section">
<h2>If-Branch Coverage</h2>
<table>
<thead><tr><th>Step</th><th>Expression</th><th>Branches</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
  }

  // ── Input table ──
  let inputSection = '';
  if (fc.inputTable.length > 0) {
    const rows = fc.inputTable.map((r: InputCoverageRow) => {
      const provBadge = r.coveredProvided
        ? '<span class="pill pill-green">provided ✓</span>'
        : '<span class="pill pill-red">provided ✗</span>';
      const defBadge = r.hasDefault
        ? (r.coveredDefault
          ? '<span class="pill pill-green">default ✓</span>'
          : '<span class="pill pill-red">default ✗</span>')
        : '<span class="pill pill-gray">no default</span>';
      return `<tr><td>${esc(r.name)}</td><td>${provBadge} ${defBadge}</td></tr>`;
    }).join('\n');
    inputSection = `
<div class="section">
<h2>Input Coverage</h2>
<table>
<thead><tr><th>Input</th><th>Coverage</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
  }

  // ── Output table ──
  let outputSection = '';
  if (fc.outputTable.length > 0) {
    const rows = fc.outputTable.map((r: OutputCoverageRow) => {
      const badge = r.covered
        ? '<span class="pill pill-green">✓ produced</span>'
        : '<span class="pill pill-red">✗ not produced</span>';
      return `<tr><td>${esc(r.name)}</td><td>${badge}</td></tr>`;
    }).join('\n');
    outputSection = `
<div class="section">
<h2>Output Coverage</h2>
<table>
<thead><tr><th>Output</th><th>Coverage</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>`;
  }

  const depth = dirname(rel);
  const backLink = depth === '.' ? 'index.html' : relative(depth, 'index.html');
  const nav = `<nav><a href="${backLink}">← Summary</a> / ${esc(rel)}</nav>`;
  const body = `
<div class="metrics-bar">${metricsBar}${uncovChip}</div>
${sourceSection}
${ifSection}
${inputSection}
${outputSection}`;

  return page(`actharness coverage — ${basename(fc.path)}`, nav, body);
}

// ── Istanbul-style source annotator ──────────────────────────────────────────
//
// Ported from istanbul-reports/lib/html/annotator.js + insertion-text.js.
// Uses placeholder chars so span tags survive HTML-escaping of source text.

const _LT = '';
const _GT = '';

function _spanO(cls: string, title: string): string {
  return `${_LT}span class="${cls}" title="${title}"${_GT}`;
}
const _spanC = `${_LT}/span${_GT}`;

function _codeEsc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(//g, '<')
    .replace(//g, '>');
}

class _InsertionText {
  private _t: string;
  private _origLen: number;
  private _offsets: { pos: number; len: number }[];
  private _blanks: boolean;
  private _start: number;
  private _end: number;

  constructor(text: string, consumeBlanks = false) {
    this._t = text;
    this._origLen = text.length;
    this._offsets = [];
    this._blanks = consumeBlanks;
    const W = /[ \f\n\r\t\v\u00A0\u2028\u2029]/;
    let s = -1;
    for (let i = 0; i < text.length; i++) { if (!W.test(text[i]!)) { s = i; break; } }
    this._start = s;
    let e = text.length + 1;
    for (let i = text.length - 1; i >= 0; i--) { if (!W.test(text[i]!)) { e = i; break; } }
    this._end = e;
  }

  originalLength(): number { return this._origLen; }

  private _findOffset(pos: number, len: number, before: boolean): number {
    const offs = this._offsets;
    let cum = 0;
    let i = 0;
    let o: { pos: number; len: number } | undefined;
    for (; i < offs.length; i++) {
      o = offs[i]!;
      if (o.pos < pos || (o.pos === pos && !before)) cum += o.len;
      if (o.pos >= pos) break;
    }
    if (o && o.pos === pos) { o.len += len; } else { offs.splice(i, 0, { pos, len }); }
    return cum;
  }

  insertAt(col: number, str: string, before: boolean, consumeBlanks?: boolean): this {
    const cb = consumeBlanks !== undefined ? consumeBlanks : this._blanks;
    col = Math.min(Math.max(col, 0), this._origLen);
    if (cb) { if (col <= this._start) col = 0; if (col > this._end) col = this._origLen; }
    const realPos = col + this._findOffset(col, str.length, before);
    this._t = this._t.substring(0, realPos) + str + this._t.substring(realPos);
    return this;
  }

  wrap(s: number, sText: string, e: number, eText: string, cb?: boolean): this {
    this.insertAt(s, sText, true, cb);
    this.insertAt(e, eText, false, cb);
    return this;
  }

  toString(): string { return this._t; }
}

interface _SLine { covered: 'yes' | 'no' | 'neutral'; hits: number; text: _InsertionText; }

function _buildStructured(lines: string[]): _SLine[] {
  const r: _SLine[] = [{ covered: 'neutral', hits: 0, text: new _InsertionText('') }];
  for (const l of lines) r.push({ covered: 'neutral', hits: 0, text: new _InsertionText(l, true) });
  return r;
}

function _annotateLines(d: JsIstanbulData, st: _SLine[]): void {
  const lm: Record<number, number> = {};
  for (const [id, loc] of Object.entries(d.statementMap)) {
    const c = d.s[id] ?? 0;
    for (let ln = loc.start.line; ln <= loc.end.line; ln++) lm[ln] = Math.max(lm[ln] ?? 0, c);
  }
  for (const [lnStr, c] of Object.entries(lm)) {
    const ln = Number(lnStr);
    if (st[ln]) { st[ln]!.covered = c > 0 ? 'yes' : 'no'; st[ln]!.hits = c; }
  }
}

function _annotateBranches(d: JsIstanbulData, st: _SLine[]): void {
  for (const [name, arr] of Object.entries(d.b)) {
    const sum = arr.reduce((p, n) => p + n, 0);
    const meta = d.branchMap[name];
    if (!meta) continue;
    if (!(sum > 0 || (sum === 0 && arr.length === 1))) continue;
    const locs: ({ start: { line?: number; column?: number }; end: { line?: number; column?: number } })[] = [...meta.locations];
    if (meta.type === 'if' && arr.length === 2 && locs.length === 1 && arr[1] === 0) locs[1] = { start: {}, end: {} };
    for (let i = 0; i < arr.length && i < locs.length; i++) {
      if (arr[i] !== 0) continue;
      const loc = locs[i]!;
      let startLine = loc.start.line;
      let startCol = loc.start.column ?? 0;
      let endCol = (loc.end.column ?? 0) + 1;
      const endLine = loc.end.line;
      if (startLine === undefined && meta.type === 'if') {
        const prev = locs[i - 1]!;
        startLine = prev.start.line;
        startCol = prev.start.column ?? 0;
        endCol = (prev.end.column ?? 0) + 1;
      }
      if (startLine === undefined || !st[startLine]) continue;
      const sl = st[startLine]!;
      const lineEnd = endLine !== startLine ? sl.text.originalLength() : endCol;
      if (meta.type === 'if') {
        sl.text.insertAt(startCol, _spanO('missing-if-branch', `${i === 0 ? 'if' : 'else'} path not taken`) + (i === 0 ? 'I' : 'E') + _spanC, true, false);
      } else {
        sl.text.wrap(startCol, _spanO(`branch-${i} cbranch-no`, 'branch not covered'), startCol < lineEnd ? lineEnd : sl.text.originalLength(), _spanC);
      }
    }
  }
}

function _annotateFunctions(d: JsIstanbulData, st: _SLine[]): void {
  for (const [id, meta] of Object.entries(d.fnMap)) {
    if ((d.f[id] ?? 0) > 0) continue;
    const decl = meta.decl;
    if (!st[decl.start.line]) continue;
    const sl = st[decl.start.line]!;
    const endCol = decl.end.line !== decl.start.line ? sl.text.originalLength() : decl.end.column + 1;
    sl.text.wrap(decl.start.column, _spanO('fstat-no', 'function not covered'), decl.start.column < endCol ? endCol : sl.text.originalLength(), _spanC);
  }
}

function _annotateStatements(d: JsIstanbulData, st: _SLine[]): void {
  for (const [id, loc] of Object.entries(d.statementMap)) {
    if ((d.s[id] ?? 0) > 0) continue;
    if (!st[loc.start.line]) continue;
    const sl = st[loc.start.line]!;
    const endCol = loc.end.line !== loc.start.line ? sl.text.originalLength() : loc.end.column + 1;
    sl.text.wrap(loc.start.column, _spanO('cstat-no', 'statement not covered'), loc.start.column < endCol ? endCol : sl.text.originalLength(), _spanC);
  }
}

// ── JS per-file page ──────────────────────────────────────────────────────────

export function buildJsFileHtml(jsFile: JsFileCoverage, cwd: string): string {
  const rel = relative(cwd, jsFile.path);

  const metricsBar = [
    { label: 'Stmts', stat: jsFile.statements },
    { label: 'Branches', stat: jsFile.branches },
    { label: 'Functions', stat: jsFile.functions },
    { label: 'Lines', stat: jsFile.lines },
  ]
    .map(({ label, stat }) => {
      const text = stat.total === 0
        ? `${label}: n/a`
        : `${label}: ${stat.covered}/${stat.total} (${stat.pct.toFixed(1)}%)`;
      return `<span class="metric-chip ${chipClass(stat.total === 0 ? 100 : stat.pct)}">${text}</span>`;
    })
    .join('');

  let sourceSection = '';
  try {
    const source = readFileSync(jsFile.path, 'utf8');
    const lines = source.split(/(?:\r?\n)|\r/);
    const d = jsFile.istanbulData;
    const structured = _buildStructured(lines);
    _annotateLines(d, structured);
    _annotateBranches(d, structured);
    _annotateFunctions(d, structured);
    _annotateStatements(d, structured);
    structured.shift();

    const rows = structured.map((item, i) => {
      const covClass = item.covered === 'yes' ? ' cov-hit' : item.covered === 'no' ? ' cov-miss' : '';
      const countClass = `cline-${item.covered}`;
      const countText = item.hits > 0 ? `${item.hits}x` : item.covered === 'no' ? '0x' : '&nbsp;';
      return _sourceRow(i + 1, covClass, countClass, countText, _codeEsc(item.text.toString()) || '&nbsp;');
    });

    sourceSection = `
<div class="section">
<h2>Source</h2>
${_sourceTable(rows)}
</div>`;
  } catch {
    sourceSection = `<p style="color:#cf222e">Could not read source: ${esc(jsFile.path)}</p>`;
  }

  const depth = dirname(rel);
  const backLink = depth === '.' ? 'index.html' : relative(depth, 'index.html');
  const nav = `<nav><a href="${backLink}">← Summary</a> / ${esc(rel)}</nav>`;
  const body = `\n<div class="metrics-bar">${metricsBar}</div>\n${sourceSection}`;

  return page(`actharness coverage — ${basename(jsFile.path)}`, nav, body);
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function generateHtmlReport(report: CoverageReport, dir: string, cwd = process.cwd()): void {
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'index.html'), buildIndexHtml(report, cwd));

  const sortedFiles = Object.values(report.files).sort((a, b) => a.path.localeCompare(b.path));
  for (const fc of sortedFiles) {
    const rel = relative(cwd, fc.path);
    const htmlPath = join(dir, rel + '.html');
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, buildFileHtml(fc, cwd));
  }

  const sortedJsFiles = Object.values(report.jsFiles).sort((a, b) => a.path.localeCompare(b.path));
  for (const jsFile of sortedJsFiles) {
    const rel = relative(cwd, jsFile.path);
    const htmlPath = join(dir, rel + '.html');
    mkdirSync(dirname(htmlPath), { recursive: true });
    writeFileSync(htmlPath, buildJsFileHtml(jsFile, cwd));
  }
}
