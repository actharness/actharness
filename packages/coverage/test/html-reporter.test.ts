import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndexHtml, buildFileHtml, buildJsFileHtml, generateHtmlReport } from '../src/html-reporter.js';
import type { CoverageReport, FileCoverage, JsFileCoverage, JsIstanbulData, NodeShellFileCoverage, PythonShellFileCoverage, ShShellFileCoverage, BashShellFileCoverage, PwshShellFileCoverage } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function makeStat(covered: number, total: number) {
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

const zeroStat = { covered: 0, total: 0, pct: 0 };
const emptyIstanbul: JsIstanbulData = { s: {}, b: {}, f: {}, statementMap: {}, branchMap: {}, fnMap: {} };

function makeEmptyReport(): CoverageReport {
  return {
    files: {},
    jsFiles: {},
    pythonShellFiles: {},
    shShellFiles: {},
    bashShellFiles: {},
    pwshShellFiles: {},
    nodeShellFiles: {},
    total: {
      steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
      jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat,
      pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
    },
  };
}

function makeFileCoverage(path: string, opts: {
  stepsCovered?: number; stepsTotal?: number;
  ifCovered?: number; ifTotal?: number;
  inCovered?: number; inTotal?: number;
  outCovered?: number; outTotal?: number;
  ifBranchTable?: FileCoverage['ifBranchTable'];
  inputTable?: FileCoverage['inputTable'];
  outputTable?: FileCoverage['outputTable'];
  stepHits?: Record<string, number>;
  stepReached?: Record<string, number>;
  shStepLineHits?: FileCoverage['shStepLineHits'];
  nodeShStepIstanbul?: FileCoverage['nodeShStepIstanbul'];
} = {}): FileCoverage {
  const stepHits = opts.stepHits ?? {};
  const stepReached = opts.stepReached ?? Object.fromEntries(Object.entries(stepHits).map(([k, v]) => [k, v]));
  return {
    path,
    steps: makeStat(opts.stepsCovered ?? 0, opts.stepsTotal ?? 0),
    ifBranches: makeStat(opts.ifCovered ?? 0, opts.ifTotal ?? 0),
    inputs: makeStat(opts.inCovered ?? 0, opts.inTotal ?? 0),
    outputs: makeStat(opts.outCovered ?? 0, opts.outTotal ?? 0),
    ifBranchTable: opts.ifBranchTable ?? [],
    inputTable: opts.inputTable ?? [],
    outputTable: opts.outputTable ?? [],
    stepHits,
    stepReached,
    uncoveredSteps: [],
    shStepLineHits: opts.shStepLineHits,
    nodeShStepIstanbul: opts.nodeShStepIstanbul,
  };
}

// ── buildIndexHtml ────────────────────────────────────────────────────────────

describe('buildIndexHtml', () => {
  it('returns an HTML string with doctype', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('includes "actharness coverage" title', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).toContain('actharness coverage');
  });

  it('includes table headers for all metrics', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).toContain('Steps');
    expect(html).toContain('If-Branches');
    expect(html).toContain('Inputs');
    expect(html).not.toContain('With-Inputs');
  });

  it('includes file link when report has files', () => {
    const fc = makeFileCoverage('/root/action.yml');
    const report: CoverageReport = {
      files: { '/root/action.yml': fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('action.yml.html');
    expect(html).toContain('action.yml');
  });

  it('shows n/a for zero-total stats', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).toContain('n/a');
  });

  it('shows percentage for non-zero stats', () => {
    const fc = makeFileCoverage('/root/action.yml', { stepsCovered: 2, stepsTotal: 4 });
    const report: CoverageReport = {
      files: { '/root/action.yml': fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('50.0%');
  });

  it('applies pct-high class when pct >= 80 (covers pctClass high branch)', () => {
    const fc = makeFileCoverage('/root/action.yml', { stepsCovered: 9, stepsTotal: 10 });
    const report: CoverageReport = {
      files: { '/root/action.yml': fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('pct-high');
  });

  it('applies pct-low class when pct < 50 (covers pctClass low branch)', () => {
    const fc = makeFileCoverage('/root/action.yml', { stepsCovered: 1, stepsTotal: 10 });
    const report: CoverageReport = {
      files: { '/root/action.yml': fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('pct-low');
  });

  it('applies pct-medium class when pct is 50-79', () => {
    const fc = makeFileCoverage('/root/action.yml', { stepsCovered: 6, stepsTotal: 10 });
    const report: CoverageReport = {
      files: { '/root/action.yml': fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('pct-medium');
  });

  it('shows JS Coverage section when jsFiles has entries', () => {
    const jsStat = makeStat(3, 3);
    const jsFile: JsFileCoverage = {
      path: '/root/index.js',
      statements: jsStat,
      branches: zeroStat,
      functions: zeroStat,
      lines: jsStat,
      istanbulData: emptyIstanbul,
    };
    const report: CoverageReport = {
      files: {},
      jsFiles: { '/root/index.js': jsFile },
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: jsStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: jsStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: jsStat, nodeShellBranches: zeroStat},
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('JS Coverage (V8)');
    expect(html).toContain('index.js');
    expect(html).toContain('Stmts');
    expect(html).toContain('Uncovered Lines');
    expect(html).toContain('href="index.js.html"');
  });

  it('does not show JS Coverage section when jsFiles is empty', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).not.toContain('JS Coverage');
  });

  it('shows uncovered JS line numbers from non-empty Istanbul statementMap', () => {
    const jsStat = makeStat(1, 3);
    const istanbul: JsIstanbulData = {
      s: { '0': 0, '1': 0, '2': 1 },
      b: {},
      f: {},
      statementMap: {
        '0': { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
        '1': { start: { line: 7, column: 0 }, end: { line: 7, column: 10 } },
        '2': { start: { line: 5, column: 0 }, end: { line: 5, column: 10 } },
      },
      branchMap: {},
      fnMap: {},
    };
    const jsFile: JsFileCoverage = { path: '/root/app.js', statements: jsStat, branches: zeroStat, functions: zeroStat, lines: jsStat, istanbulData: istanbul };
    const report: CoverageReport = {
      files: {},
      jsFiles: { '/root/app.js': jsFile },
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: jsStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: jsStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: jsStat, nodeShellBranches: zeroStat},
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('3');
  });

  it('shows Python Coverage section when pythonShellFiles has entries, sorted alphabetically (covers lines 180-193)', () => {
    const pyStat = makeStat(2, 3);
    const emptyPy = { executedLines: [] as number[], missingLines: [] as number[], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const pyFileA: PythonShellFileCoverage = {
      path: '/root/a_script.py',
      statements: pyStat,
      branches: zeroStat,
      lines: pyStat,
      pythonCoverageData: { ...emptyPy, executedLines: [1, 2], missingLines: [3, 5] },
    };
    const pyFileZ: PythonShellFileCoverage = {
      path: '/root/z_script.py',
      statements: zeroStat,
      branches: zeroStat,
      lines: zeroStat,
      pythonCoverageData: emptyPy,
    };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: { '/root/z_script.py': pyFileZ, '/root/a_script.py': pyFileA },
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
        jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat,
        shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat,
        nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat,
        pythonShellStatements: pyStat, pythonShellBranches: zeroStat, pythonShellLines: pyStat,
      },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('Python Shell Coverage (coverage.py)');
    expect(html).toContain('a_script.py');
    expect(html).toContain('z_script.py');
    expect(html).toContain('Stmts');
    expect(html).toContain('Branches');
    expect(html.indexOf('a_script.py')).toBeLessThan(html.indexOf('z_script.py'));
  });

  it('sorts JS files alphabetically in JS Coverage section (covers sort comparator)', () => {
    const jsStat = makeStat(1, 2);
    const jsFileZ: JsFileCoverage = { path: '/root/z.js', statements: jsStat, branches: zeroStat, functions: zeroStat, lines: jsStat, istanbulData: emptyIstanbul };
    const jsFileA: JsFileCoverage = { path: '/root/a.js', statements: jsStat, branches: zeroStat, functions: zeroStat, lines: jsStat, istanbulData: emptyIstanbul };
    const report: CoverageReport = {
      files: {},
      jsFiles: { '/root/z.js': jsFileZ, '/root/a.js': jsFileA },
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: jsStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: jsStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html.indexOf('a.js')).toBeLessThan(html.indexOf('z.js'));
  });

  it('shows Node Shell Coverage section when nodeShellFiles has entries, sorted alphabetically', () => {
    const stmtStat = makeStat(2, 3);
    const brStat = makeStat(1, 2);
    const lnStat = makeStat(2, 3);
    const nodeShA: NodeShellFileCoverage = { path: '/root/a.yml#step-a', statements: stmtStat, branches: brStat, lines: lnStat, uncoveredLines: [] };
    const nodeShZ: NodeShellFileCoverage = { path: '/root/z.yml#step-z', statements: zeroStat, branches: zeroStat, lines: zeroStat, uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: { '/root/z.yml#step-z': nodeShZ, '/root/a.yml#step-a': nodeShA },
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
        jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat,
        shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat,
        nodeShellLines: lnStat, nodeShellStatements: stmtStat, nodeShellBranches: brStat,
        pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
      },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('Node Shell Coverage (V8)');
    expect(html).toContain('a.yml#step-a');
    expect(html).toContain('z.yml#step-z');
    expect(html).toContain('Stmts');
    expect(html).toContain('Branches');
    expect(html).toContain('Uncovered Lines');
    expect(html.indexOf('a.yml#step-a')).toBeLessThan(html.indexOf('z.yml#step-z'));
  });

  it('shows formatted uncovered line ranges in Node Shell Coverage section', () => {
    const stat = makeStat(1, 3);
    // consecutive lines → '1–3'
    const nodeShCons: NodeShellFileCoverage = { path: '/root/a.yml#step-a', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 2, 3] };
    // gap → '1, 3'
    const nodeShGap: NodeShellFileCoverage = { path: '/root/b.yml#step-b', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 3] };
    // empty → no output
    const nodeShEmpty: NodeShellFileCoverage = { path: '/root/c.yml#step-c', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [] };
    // range then gap → '1–2, 4' (covers else-with-range path in formatRanges loop)
    const nodeShMix: NodeShellFileCoverage = { path: '/root/d.yml#step-d', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 2, 4] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {
        '/root/a.yml#step-a': nodeShCons,
        '/root/b.yml#step-b': nodeShGap,
        '/root/c.yml#step-c': nodeShEmpty,
        '/root/d.yml#step-d': nodeShMix,
      },
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
        jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat,
        shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat,
        nodeShellLines: stat, nodeShellStatements: stat, nodeShellBranches: zeroStat,
        pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
      },
    };
    const html = buildIndexHtml(report, '/root');
    expect(html).toContain('1–3');
    expect(html).toContain('1, 3');
    expect(html).toContain('1–2, 4');
  });

  it('does not show Node Shell Coverage section when nodeShellFiles is empty', () => {
    const html = buildIndexHtml(makeEmptyReport(), '/root');
    expect(html).not.toContain('Node Shell Coverage');
  });

  it('covers ?? [] for node action with no steps in buildIndexHtml (line 211)', () => {
    const fixturePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const report: CoverageReport = {
      files: { [fixturePath]: fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('node-main-only');
  });

  it('shows Sh Shell Coverage section when shShellFiles has 2 entries (covers sort comparator and _computeUncoveredYamlLinesForStep block-scalar)', () => {
    const fp1 = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const fp2 = join(FIXTURES, 'with-sh-comment-run', 'action.yml');
    const sk1 = `${fp1}#step1`;
    const sk2 = `${fp2}#step1`;
    const sh1: ShShellFileCoverage = { path: sk1, lines: makeStat(1, 3), uncoveredLines: [2, 3] };
    const sh2: ShShellFileCoverage = { path: sk2, lines: makeStat(1, 2), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [sk1]: sh1, [sk2]: sh2 },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(2, 5), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
    expect(html).toContain('Uncovered Lines');
  });

  it('shows Bash Shell Coverage section when bashShellFiles has 2 entries (covers sort comparator)', () => {
    const fp1 = join(FIXTURES, 'simple', 'action.yml');
    const fp2 = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const sk1 = `${fp1}#step1`;
    const sk2 = `${fp2}#step1`;
    const b1: BashShellFileCoverage = { path: sk1, lines: makeStat(1, 1), uncoveredLines: [1] };
    const b2: BashShellFileCoverage = { path: sk2, lines: makeStat(3, 3), uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: { [sk1]: b1, [sk2]: b2 },
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: makeStat(4, 4), pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Bash Shell Coverage');
  });

  it('shows Pwsh Shell Coverage section when pwshShellFiles has 2 entries (covers sort comparator)', () => {
    const fp1 = join(FIXTURES, 'with-pwsh', 'action.yml');
    const fp2 = join(FIXTURES, 'simple', 'action.yml');
    const sk1 = `${fp1}#step1`;
    const sk2 = `${fp2}#step1`;
    const p1: PwshShellFileCoverage = { path: sk1, lines: makeStat(1, 1), uncoveredLines: [1] };
    const p2: PwshShellFileCoverage = { path: sk2, lines: makeStat(1, 1), uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: { [sk1]: p1, [sk2]: p2 },
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: makeStat(2, 2), nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Pwsh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when file is unreadable', () => {
    const badKey = '/nonexistent/action.yml#step1';
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when parseAction fails', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const badKey = `${testFilePath}#step1`;
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when stepId not found', () => {
    const fp = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const badKey = `${fp}#nonexistent_step`;
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when step has no run', () => {
    const fp = join(FIXTURES, 'uses-with', 'action.yml');
    const badKey = `${fp}#greet-step`;
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when action has no steps (covers ?? [] right-side branch)', () => {
    const fp = join(FIXTURES, 'node-main-only', 'action.yml');
    const badKey = `${fp}#main`;
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });

  it('_computeUncoveredYamlLinesForStep: returns raw lines when runHeaderLine not found', () => {
    const fp = join(FIXTURES, 'with-inline-run', 'action.yml');
    const badKey = `${fp}#__step_1__`;
    const sh: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: sh },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const html = buildIndexHtml(report, FIXTURES);
    expect(html).toContain('Sh Shell Coverage');
  });
});

// ── buildFileHtml ─────────────────────────────────────────────────────────────

describe('buildFileHtml', () => {
  it('returns an HTML string with doctype', () => {
    const fc = makeFileCoverage('/nonexistent/action.yml');
    const html = buildFileHtml(fc, '/root');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('includes nav link back to index (file in subdirectory)', () => {
    const fc = makeFileCoverage('/root/sub/action.yml');
    const html = buildFileHtml(fc, '/root');
    expect(html).toContain('href="../index.html"');
  });

  it('includes nav link back to index (file at root level)', () => {
    const fc = makeFileCoverage('/root/action.yml');
    const html = buildFileHtml(fc, '/root');
    expect(html).toContain('href="index.html"');
  });

  it('shows error message when source file cannot be read', () => {
    const fc = makeFileCoverage('/nonexistent/path/action.yml');
    const html = buildFileHtml(fc, '/root');
    expect(html).toContain('Could not read source');
  });

  it('renders source view for a real file with steps', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepsCovered: 1, stepsTotal: 1,
      stepHits: { 'step1': 3 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view');
    expect(html).toContain('3x'); // hit count badge
  });

  it('renders T count for steps with if: branches (no F badge)', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepsCovered: 1, stepsTotal: 1,
      ifBranchTable: [{ step: 'step1', expression: 'failure()', trueCount: 1, falseCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-yes'); // T=1
    expect(html).not.toContain('badge-f-miss');
  });

  it('renders the if-branch table section when ifBranchTable is non-empty', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      ifBranchTable: [{ step: 's1', expression: 'failure()', trueCount: 0, falseCount: 1 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('If-Branch Coverage');
    expect(html).toContain('failure()');
    expect(html).toContain('pill-green'); // falseCount=1
    expect(html).toContain('pill-red');   // trueCount=0
  });

  it('renders F n/a badge for always() expression (falseBranchImpossible)', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      ifBranchTable: [{ step: 's1', expression: 'always()', trueCount: 1, falseCount: 0, falseBranchImpossible: true }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('F n/a');
    expect(html).toContain('pill-gray');
    expect(html).not.toContain('F ✗');
  });

  it('renders input coverage table when inputTable is non-empty', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [
        { name: 'greeting', hasDefault: true, coveredProvided: true, coveredDefault: false, providedCount: 1, defaultCount: 0 },
        { name: 'token', hasDefault: false, coveredProvided: false, coveredDefault: true, providedCount: 0, defaultCount: 0 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('Input Coverage');
    expect(html).toContain('greeting');
    expect(html).toContain('token');
    expect(html).toContain('no default'); // token has no default
  });

  it('renders default ✓ badge when hasDefault=true and coveredDefault=true', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [
        { name: 'greeting', hasDefault: true, coveredProvided: true, coveredDefault: true, providedCount: 2, defaultCount: 1 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('default ✓');
  });

  it('renders miss badge (cov-miss) for uncovered step', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepsCovered: 0, stepsTotal: 1,
      stepHits: { 'step1': 0 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cov-miss');
  });

  it('renders cline-no for if-branch when trueCount=0 (covers trueCount false branch)', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'step1': 1 },
      ifBranchTable: [{ step: 'step1', expression: 'failure()', trueCount: 0, falseCount: 1 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-no');  // T=0
    expect(html).not.toContain('badge-f-hit');
  });

  it('uses __step_N__ id for step without id in source view (covers id ?? branch)', () => {
    const fixturePath = join(FIXTURES, 'uses-with', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'greet-step': 2, '__step_2__': 0 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view');
    expect(html).toContain('2x'); // greet-step hit count
  });

  it('marks uses-step as uncovered when stepHits does not include its id (covers ?? 0 right-side branch)', () => {
    const fixturePath = join(FIXTURES, 'uses-with', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'greet-step': 1 }, // __step_2__ absent → stepHits['__step_2__'] === undefined → ?? 0 = 0
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view');
  });

  it('renders source when action has undefined steps (covers steps ?? [] branch)', () => {
    // custom-runner fixture uses non-composite 'using', so steps is undefined
    const fixturePath = join(FIXTURES, 'custom-runner', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view'); // falls through with empty annotations
  });

  // ── node-action phases ──

  it('renders hit-count badge on the main: line for a node action', () => {
    const fixturePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepsCovered: 1, stepsTotal: 1,
      stepHits: { main: 3 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view');
    expect(html).toContain('3x');
  });

  it('renders cov-miss on the main: line when main never ran', () => {
    const fixturePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepsCovered: 0, stepsTotal: 1,
      stepHits: { main: 0 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cov-miss');
  });

  it('renders T count on the pre-if: line, separate from the pre: line, for a node action', () => {
    const fixturePath = join(FIXTURES, 'node-with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { pre: 1, main: 1, post: 0 },
      ifBranchTable: [
        { step: 'pre', expression: 'always()', trueCount: 1, falseCount: 0 },
        { step: 'post', expression: 'failure()', trueCount: 0, falseCount: 1 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    const rows = html.split('</tr>');
    const preIfRow = rows.find((r) => r.includes('always()')) ?? '';
    const preRow = rows.find((r) => r.includes('pre.js')) ?? '';
    expect(preIfRow).toContain('cline-yes'); // T=1
    expect(preIfRow).not.toContain('badge-f-miss');
    // the pre: line itself shows ×reached, not T/F
    expect(preRow).toContain('1x');
  });

  it('defaults hits/reached to 0 when a node-action phase is missing from stepHits/stepReached', () => {
    const fixturePath = join(FIXTURES, 'node-with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { main: 1 }, // pre/post omitted entirely
      stepReached: { main: 1 },
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('source-view');
    expect(html).toContain('0x'); // pre/post default to 0 hits/reached
  });

  it('renders post-if: T count and tracks post phase independently from pre', () => {
    const fixturePath = join(FIXTURES, 'node-with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { pre: 1, main: 1, post: 0 },
      ifBranchTable: [
        { step: 'post', expression: 'failure()', trueCount: 0, falseCount: 1 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    const rows = html.split('</tr>');
    const postIfRow = rows.find((r) => r.includes('failure()')) ?? '';
    expect(postIfRow).toContain('cline-no'); // T=0
    expect(postIfRow).not.toContain('badge-f-hit');
  });

  it('applies chip-low class for < 50% coverage in metrics bar', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, { stepsCovered: 1, stepsTotal: 10 });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('chip-low');
  });

  it('applies chip-medium class for 50-79% coverage in metrics bar', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, { stepsCovered: 6, stepsTotal: 10 });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('chip-medium');
  });

  it('does not render if-branch table when ifBranchTable is empty', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('If-Branch Coverage');
  });

  it('does not render input table when inputTable is empty', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Input Coverage');
  });

  it('metric chips show n/a for zero-total stats', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath); // all zero
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('n/a');
  });

  it('shows T count in column on the if: line when step has _ifRange (no F count)', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { step1: 3 },
      ifBranchTable: [{ step: 'step1', expression: "inputs.greeting != ''", trueCount: 3, falseCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain("if: ${{ inputs.greeting != '' }}");
    expect(html).toContain('cline-yes'); // T=3
    expect(html).not.toContain('badge-f-miss');
  });

  it('if: line is cov-hit when condition was evaluated (reached > 0)', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { step1: 0 },
      stepReached: { step1: 1 },
      ifBranchTable: [{ step: 'step1', expression: "inputs.greeting != ''", trueCount: 0, falseCount: 1 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    // if: line should be cov-hit because the step was reached (condition evaluated once)
    // body lines should be cov-miss because hits=0
    const lines = html.split('\n');
    const ifLineHtml = lines.find((l) => l.includes("inputs.greeting != ''")) ?? '';
    expect(ifLineHtml).toContain('cov-hit');
  });

  it('if: line is cov-miss when condition was never evaluated', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { step1: 0 },
      ifBranchTable: [{ step: 'step1', expression: "inputs.greeting != ''", trueCount: 0, falseCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    const lines = html.split('\n');
    const ifLineHtml = lines.find((l) => l.includes("inputs.greeting != ''")) ?? '';
    expect(ifLineHtml).toContain('cov-miss');
  });

  it('annotates input lines with providedCount on main lines and defaultCount on default line', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [{ name: 'greeting', hasDefault: true, coveredProvided: true, coveredDefault: true, providedCount: 3, defaultCount: 1 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('3x'); // providedCount on main input lines
    expect(html).toContain('1x'); // defaultCount on default: line
    expect(html).toContain('cline-yes'); // both covered
  });

  it('annotates input lines with cline-no when both provided and default are uncovered', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [{ name: 'greeting', hasDefault: true, coveredProvided: false, coveredDefault: false, providedCount: 0, defaultCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    const lines = html.split('\n');
    const greetingLine = lines.find((l) => l.includes('greeting:')) ?? '';
    expect(greetingLine).toContain('cov-miss');
    expect(html).toContain('cline-no'); // both ×0
  });

  it('shows no default count when input has no default', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [{ name: 'greeting', hasDefault: false, coveredProvided: true, coveredDefault: true, providedCount: 2, defaultCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('2x'); // providedCount
    expect(html).toContain('cline-yes');
  });

  it('skips input annotation when input is not in inputTable', () => {
    const fixturePath = join(FIXTURES, 'with-if', 'action.yml');
    const fc = makeFileCoverage(fixturePath, { inputTable: [] });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Input Coverage');
  });

  it('skips input annotation when input has no _range (bare input)', () => {
    const fixturePath = join(FIXTURES, 'bare-input', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      inputTable: [{ name: 'bare', hasDefault: false, coveredProvided: true, coveredDefault: true, providedCount: 1, defaultCount: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    // no _range means no inline annotation — only the Input Coverage table section appears
    expect(html).toContain('Input Coverage');
    // bare: line should be cline-neutral (no count), not annotated with a count
    const bareRow = html.split('</tr>').find((r) => r.includes('bare:')) ?? '';
    expect(bareRow).toContain('cline-neutral');
    expect(bareRow).not.toContain('cline-yes');
    expect(bareRow).not.toContain('cline-no');
  });

  it('renders output coverage table with covered and uncovered outputs', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      outputTable: [
        { name: 'greeting', covered: true, count: 3 },
        { name: 'farewell', covered: false, count: 0 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('Output Coverage');
    expect(html).toContain('greeting');
    expect(html).toContain('produced');
    expect(html).toContain('farewell');
    expect(html).toContain('not produced');
  });

  // ── sh/pwsh per-line coverage coloring ──

  it('colors sh run-block lines using shStepLineHits and shows per-line hit count', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 3 } }),
      // line 2 is absent (never traced) — exercises the hits[scriptLineNum] ?? 0 path
      shStepLineHits: { step1: { 1: 2, 3: 1 } },
    };
    const html = buildFileHtml(fc, FIXTURES);
    const rows = html.split('</tr>');
    const line1Row = rows.find((r) => r.includes('line1')) ?? '';
    const line2Row = rows.find((r) => r.includes('line2')) ?? '';
    const line3Row = rows.find((r) => r.includes('line3')) ?? '';
    expect(line1Row).toContain('cov-hit');
    expect(line1Row).toContain('2x');   // per-line count, not step count
    expect(line2Row).toContain('cov-miss');
    expect(line2Row).toContain('0x');   // absent from hits → 0
    expect(line3Row).toContain('cov-hit');
    expect(line3Row).toContain('1x');
  });

  it('colors sh run-block lines red when hits object is empty', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 0 } }),
      shStepLineHits: { step1: {} },
    };
    const html = buildFileHtml(fc, FIXTURES);
    const rows = html.split('</tr>');
    const line1Row = rows.find((r) => r.includes('line1')) ?? '';
    expect(line1Row).toContain('cov-miss');
    expect(line1Row).toContain('0x');
  });

  it('colors python run-block lines using pyStepLineHits (executed → cov-hit, missing → cov-miss)', () => {
    const fixturePath = join(FIXTURES, 'with-python-run', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 1 } }),
      pyStepLineHits: { step1: { 1: 1, 2: 1, 3: 0 } },
    };
    const html = buildFileHtml(fc, FIXTURES);
    const htmlLines = html.split('\n');
    const importLine = htmlLines.find((l) => l.includes('import os')) ?? '';
    const ifLine = htmlLines.find((l) => l.includes("os.environ.get('FLAG')")) ?? '';
    const noLine = htmlLines.find((l) => l.includes("print('no')")) ?? '';
    expect(importLine).toContain('cov-hit');
    expect(ifLine).toContain('cov-hit');
    expect(noLine).toContain('cov-miss');
  });

  it('colors pwsh run-block lines using pwshStepLineHits', () => {
    const fixturePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 1 } }),
      pwshStepLineHits: { step1: { 1: 3 } },
    };
    const html = buildFileHtml(fc, FIXTURES);
    const htmlLines = html.split('\n');
    const runLine = htmlLines.find((l) => l.includes('Write-Output')) ?? '';
    expect(runLine).toContain('cov-hit');
  });

  it('skips per-line annotation when run: is inline with the dash (runHeaderLine not found, __step_N__ id path)', () => {
    // Step has no id (uses __step_1__ key) and run: is inline with the `-` list marker.
    // The regex /^\s+run\s*:/ does NOT match `  - run: echo hi` because `-` precedes `run:`.
    // This exercises: the __step_N__ id fallback (line 352) and the continue when
    // runHeaderLine is not found in the YAML range (line 370).
    const fixturePath = join(FIXTURES, 'with-inline-run', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { '__step_1__': 1 } }),
      shStepLineHits: { '__step_1__': { 1: 1 } },
    };
    const html = buildFileHtml(fc, FIXTURES);
    // Should not crash; no per-line annotation is added (inline run: not supported)
    expect(html).toContain('source-view');
  });

  it('does not show Sh Lines chip in metrics bar (moved to index Sh Shell Coverage section)', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Sh Lines:');
  });

  it('does not show Pwsh Lines chip in metrics bar (moved to index Pwsh Shell Coverage section)', () => {
    const fixturePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Pwsh Lines:');
  });

  it('colors shell:node run-block lines using nodeShStepIstanbul (covered line)', () => {
    const fixturePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const istanbul: JsIstanbulData = {
      s: { '0': 3 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 21 } } },
      branchMap: {}, fnMap: {},
    };
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 1 } }),
      nodeShellLines: makeStat(1, 1),
      nodeShStepIstanbul: { step1: istanbul },
    };
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-yes');
    expect(html).toContain('3x');
    expect(html).toContain('cov-hit');
  });

  it('colors shell:node run-block lines using nodeShStepIstanbul (uncovered line)', () => {
    const fixturePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 21 } } },
      branchMap: {}, fnMap: {},
    };
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 1 } }),
      nodeShellLines: makeStat(0, 1),
      nodeShStepIstanbul: { step1: istanbul },
    };
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-no');
    expect(html).toContain('cov-miss');
  });

  it('shows Node Lines chip in metrics bar when nodeShellLines.total > 0', () => {
    const fixturePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath),
      nodeShellLines: makeStat(1, 1),
    };
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('Node Lines: 1/1');
  });

  it('annotates shell:node run: flow scalar (isBlockScalar=false) — maps all script lines to run: line', () => {
    // run: "console.log('hi')" — no block scalar indicator, so isBlockScalar=false
    // All script content maps to the single run: YAML line number
    const fixturePath = join(FIXTURES, 'with-node-run-folded', 'action.yml');
    const istanbul: JsIstanbulData = {
      s: { '0': 1 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } } },
      branchMap: {}, fnMap: {},
    };
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath, { stepHits: { step1: 1 } }),
      nodeShellLines: makeStat(1, 1),
      nodeShStepIstanbul: { step1: istanbul },
    };
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-yes');
    expect(html).toContain('1x');
  });

  it('does not show Sh Lines chip when shShellLines is undefined', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Sh Lines:');
  });

  it('does not show Sh Lines chip when shShellLines.total is 0', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc: FileCoverage = {
      ...makeFileCoverage(fixturePath),
    };
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Sh Lines:');
  });

  it('renders cov-miss for input name lines never explicitly provided; default: line can be cov-hit', () => {
    const fixturePath = join(FIXTURES, 'with-inputs', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'step1': 0 },
      inputTable: [
        { name: 'greeting', hasDefault: true, coveredProvided: false, coveredDefault: true, providedCount: 0, defaultCount: 1 },
        { name: 'token', hasDefault: false, coveredProvided: false, coveredDefault: true, providedCount: 0, defaultCount: 0 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    const rows = html.split('</tr>');
    // greeting: and token: key lines show cov-miss (coveredProvided=false)
    const greetingRow = rows.find((r) => r.includes('greeting:')) ?? '';
    const tokenRow = rows.find((r) => r.includes('token:')) ?? '';
    expect(greetingRow).toContain('cov-miss');
    expect(tokenRow).toContain('cov-miss');
    // default: line for greeting gets cov-hit because coveredDefault=true
    const defaultRow = rows.find((r) => r.includes('default: World')) ?? '';
    expect(defaultRow).toContain('cov-hit');
  });

  it('renders cov-hit for input when coveredProvided=true', () => {
    const fixturePath = join(FIXTURES, 'with-inputs', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'step1': 1 },
      inputTable: [
        { name: 'greeting', hasDefault: true, coveredProvided: true, coveredDefault: false, providedCount: 1, defaultCount: 0 },
      ],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cov-hit');
  });

  it('renders covered output source lines with cov-hit and count in column', () => {
    const fixturePath = join(FIXTURES, 'with-outputs', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'step1': 1 },
      outputTable: [{ name: 'greeting', covered: true, count: 1 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cov-hit');
    expect(html).toContain('cline-yes'); // count=1 > 0
    expect(html).toContain('1x');
  });

  it('renders uncovered output source lines with cov-miss and cline-no in column', () => {
    const fixturePath = join(FIXTURES, 'with-outputs', 'action.yml');
    const fc = makeFileCoverage(fixturePath, {
      stepHits: { 'step1': 0 },
      outputTable: [{ name: 'greeting', covered: false, count: 0 }],
    });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).toContain('cline-no'); // count=0
  });

  it('skips output annotation when output is not in outputTable', () => {
    // with-outputs has "greeting" output, but outputTable is empty → no annotation
    const fixturePath = join(FIXTURES, 'with-outputs', 'action.yml');
    const fc = makeFileCoverage(fixturePath, { outputTable: [] });
    const html = buildFileHtml(fc, FIXTURES);
    expect(html).not.toContain('Output Coverage');
  });
});

// ── buildJsFileHtml ───────────────────────────────────────────────────────────

function makeJsFile(path: string, istanbul: JsIstanbulData = emptyIstanbul, overrides: Partial<JsFileCoverage> = {}): JsFileCoverage {
  return { path, statements: zeroStat, branches: zeroStat, functions: zeroStat, lines: zeroStat, istanbulData: istanbul, ...overrides };
}

// js-sample.js: line 1 = "function hi() { return 1; }", line 2 = "module.exports = { hi };"
describe('buildJsFileHtml', () => {
  const fixturePath = join(FIXTURES, 'js-sample.js');

  it('returns an HTML string with doctype', () => {
    expect(buildJsFileHtml(makeJsFile('/nonexistent/index.js'), '/root')).toContain('<!DOCTYPE html>');
  });

  it('includes nav link back to index (file at root level)', () => {
    expect(buildJsFileHtml(makeJsFile('/root/index.js'), '/root')).toContain('href="index.html"');
  });

  it('includes nav link back to index (file in subdirectory)', () => {
    expect(buildJsFileHtml(makeJsFile('/root/sub/index.js'), '/root')).toContain('href="../index.html"');
  });

  it('shows error when source file cannot be read', () => {
    expect(buildJsFileHtml(makeJsFile('/nonexistent/index.js'), '/root')).toContain('Could not read source');
  });

  it('shows n/a for zero-total metrics', () => {
    expect(buildJsFileHtml(makeJsFile(fixturePath), FIXTURES)).toContain('n/a');
  });

  it('shows metric values when total > 0', () => {
    const stat = makeStat(2, 4);
    const html = buildJsFileHtml(makeJsFile(fixturePath, emptyIstanbul, { statements: stat }), FIXTURES);
    expect(html).toContain('2/4');
    expect(html).toContain('50.0%');
  });

  it('applies chip-high class for high coverage', () => {
    const html = buildJsFileHtml(makeJsFile(fixturePath, emptyIstanbul, { statements: makeStat(9, 10) }), FIXTURES);
    expect(html).toContain('chip-high');
  });

  it('applies chip-low class for low coverage', () => {
    const html = buildJsFileHtml(makeJsFile(fixturePath, emptyIstanbul, { statements: makeStat(1, 10) }), FIXTURES);
    expect(html).toContain('chip-low');
  });

  it('renders cline-yes and hit count Nx for a covered line', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 3 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cline-yes');
    expect(html).toContain('3x');
  });

  it('renders cline-no and 0x for an uncovered line', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cline-no');
    expect(html).toContain('0x');
  });

  it('renders cline-neutral (&nbsp;) for a line with no statement', () => {
    // line 2 has no statement mapped to it → neutral
    const istanbul: JsIstanbulData = {
      s: { '0': 1 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cline-neutral');
    expect(html).toContain('&nbsp;');
  });

  it('wraps uncovered statement inline with cstat-no span', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 9 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cstat-no');
  });

  it('does not add cstat-no for a covered statement', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 2 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).not.toContain('class="cstat-no"');
  });

  it('treats missing s[id] as 0 and marks statement uncovered with cstat-no', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: {},  // no entry for '0'
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cstat-no');
    expect(html).toContain('cline-no');
  });

  it('wraps uncovered function declaration inline with fstat-no span', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: { '0': 0 },
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 11 } }, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } } },
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('fstat-no');
  });

  it('does not add fstat-no for a covered function', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: { '0': 5 },
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 11 } }, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } } },
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).not.toContain('class="fstat-no"');
  });

  it('treats missing f[id] as 0 and marks function uncovered with fstat-no', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: {},  // no entry for '0'
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi', decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 11 } }, loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } } } },
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('fstat-no');
  });

  it('inserts I marker (missing-if-branch) for uncovered if-branch', () => {
    // arr[0]=0 → if path not taken
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [0, 1] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('missing-if-branch');
    expect(html).toContain('>I<');
  });

  it('inserts E marker (missing-if-branch) for uncovered else-branch', () => {
    // arr[1]=0 → else path not taken
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('missing-if-branch');
    expect(html).toContain('>E<');
  });

  it('inserts E marker for implicit else (only 1 location but arr[1]=0)', () => {
    // Istanbul implicit else: 2 counts, 1 location, arr[1]=0 → synthesise else location from if location
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('missing-if-branch');
    expect(html).toContain('>E<');
  });

  it('wraps uncovered non-if branch with cbranch-no span', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'switch', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cbranch-no');
  });

  it('skips annotation when all branch counts are 0 and more than one location (sumCount=0, length>1)', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [0, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).not.toContain('class="missing-if-branch"');
    expect(html).not.toContain('cbranch-no"');
  });

  it('annotates single-location uncovered branch (sumCount=0, length=1)', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'cond-expr', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cbranch-no');
  });

  it('skips branch annotation when b key has no matching branchMap entry', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: { '99': [0, 1] }, f: {},
      statementMap: {},
      branchMap: {},  // no entry for '99'
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).not.toContain('class="missing-if-branch"');
    expect(html).not.toContain('cbranch-no"');
  });

  it('skips branch annotation when branch location start line is out of bounds', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'switch', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 99, column: 0 }, end: { line: 99, column: 10 } },  // out of bounds
      ] } },
      fnMap: {},
    };
    // should not throw; the out-of-bounds line is skipped
    expect(() => buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES)).not.toThrow();
  });

  it('skips statement annotation when statement start line is out of bounds', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 99, column: 0 }, end: { line: 99, column: 10 } } },
      branchMap: {}, fnMap: {},
    };
    expect(() => buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES)).not.toThrow();
  });

  it('skips function annotation when function decl line is out of bounds', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: { '0': 0 },
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi', decl: { start: { line: 99, column: 0 }, end: { line: 99, column: 10 } }, loc: { start: { line: 99, column: 0 }, end: { line: 99, column: 10 } } } },
    };
    expect(() => buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES)).not.toThrow();
  });

  it('uses multi-line statement range when annotating cline coverage', () => {
    // Statement spans line 1 and line 2 → both lines get covered status
    const istanbul: JsIstanbulData = {
      s: { '0': 1 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 2, column: 5 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    // both line 1 and line 2 should be cline-yes
    const yesCount = (html.match(/cline-yes/g) ?? []).length;
    expect(yesCount).toBeGreaterThanOrEqual(2);
  });

  it('uses multi-line decl range for fstat-no wrap (endCol = originalLength)', () => {
    // decl spans 2 lines → endCol is set to originalLength of line 1
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: { '0': 0 },
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi',
        decl: { start: { line: 1, column: 0 }, end: { line: 2, column: 5 } },
        loc:  { start: { line: 1, column: 0 }, end: { line: 2, column: 5 } },
      } },
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('fstat-no');
  });

  it('uses multi-line statement range for cstat-no wrap (endCol = originalLength)', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 2, column: 5 } } },
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cstat-no');
  });

  it('escapes > in source code (covers _codeEsc > replace)', () => {
    // js-gt.js contains "a > b" — the > must be escaped to &gt;
    const gtFixture = join(FIXTURES, 'js-gt.js');
    const html = buildJsFileHtml(makeJsFile(gtFixture), FIXTURES);
    expect(html).toContain('&gt;');
  });

  it('uses originalLength() for cbranch-no wrap when startCol >= endCol (degenerate range)', () => {
    // start.column > end.column → endCol = end.column+1 <= startCol → falls back to originalLength()
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'switch', locations: [
        { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 10 }, end: { line: 1, column: 9 } },  // endCol=10, startCol=10 → startCol >= endCol
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('cbranch-no"');
  });

  it('uses originalLength() for fstat-no wrap when startCol >= endCol (degenerate decl range)', () => {
    const istanbul: JsIstanbulData = {
      s: {}, b: {}, f: { '0': 0 },
      statementMap: {},
      branchMap: {},
      fnMap: { '0': { name: 'hi',
        decl: { start: { line: 1, column: 10 }, end: { line: 1, column: 9 } },  // endCol=10, startCol=10
        loc:  { start: { line: 1, column: 0 }, end: { line: 1, column: 28 } },
      } },
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('class="fstat-no"');
  });

  it('uses originalLength() for cstat-no wrap when startCol >= endCol (degenerate statement range)', () => {
    const istanbul: JsIstanbulData = {
      s: { '0': 0 }, b: {}, f: {},
      statementMap: { '0': { start: { line: 1, column: 10 }, end: { line: 1, column: 9 } } },  // endCol=10, startCol=10
      branchMap: {}, fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('class="cstat-no"');
  });

  it('covers _InsertionText whitespace-scanning paths using indented fixture', () => {
    // js-indented.js has "  return a + b;" (leading spaces) and "  " (whitespace-only line),
    // exercising the findFirstNonBlank and findLastNonBlank false branches in the constructor.
    const indentedFixture = join(FIXTURES, 'js-indented.js');
    const html = buildJsFileHtml(makeJsFile(indentedFixture), FIXTURES);
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('covers _InsertionText _findOffset: break + extend when branch I-marker precedes statement close at same col', () => {
    // _annotateBranches inserts I at col 5; _annotateStatements wraps col 0→5,
    // so the close insertAt(5, false) finds {pos:5} already in offs:
    //   (o.pos===pos && !before) cumulates; o.pos>=pos breaks; o.pos===pos extends len.
    const istanbul: JsIstanbulData = {
      s: { '0': 0 },
      b: { '0': [0, 1] },
      f: {},
      statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 4 } } },
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: 5 }, end: { line: 1, column: 10 } },
        { start: { line: 1, column: 15 }, end: { line: 1, column: 25 } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('class="cstat-no"');
    expect(html).toContain('missing-if-branch');
  });

  it('covers implicit else when prev location has no column (covers ?? 0 fallback on lines 691-692)', () => {
    // locs[0] has no column → prev.start.column and prev.end.column are undefined,
    // so the ?? 0 fallback branches on lines 691-692 are taken.
    const istanbul: JsIstanbulData = {
      s: {}, b: { '0': [1, 0] }, f: {},
      statementMap: {},
      branchMap: { '0': { type: 'if', locations: [
        { start: { line: 1, column: undefined as unknown as number }, end: { line: 1, column: undefined as unknown as number } },
      ] } },
      fnMap: {},
    };
    const html = buildJsFileHtml(makeJsFile(fixturePath, istanbul), FIXTURES);
    expect(html).toContain('missing-if-branch');
    expect(html).toContain('>E<');
  });
});

// ── generateHtmlReport ────────────────────────────────────────────────────────

describe('generateHtmlReport', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'actharness-html-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('creates index.html in the output directory', () => {
    generateHtmlReport(makeEmptyReport(), tmpDir);
    expect(existsSync(join(tmpDir, 'index.html'))).toBe(true);
  });

  it('index.html contains DOCTYPE', () => {
    generateHtmlReport(makeEmptyReport(), tmpDir);
    const html = readFileSync(join(tmpDir, 'index.html'), 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
  });

  it('creates <rel>.html for each file in the report', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFileCoverage(fixturePath);
    const report: CoverageReport = {
      files: { [fixturePath]: fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: fc.steps, ifBranches: fc.ifBranches, inputs: fc.inputs, outputs: fc.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat
      },
    };
    generateHtmlReport(report, tmpDir, FIXTURES);
    expect(existsSync(join(tmpDir, 'simple', 'action.yml.html'))).toBe(true);
  });

  it('sorts files by path when report has multiple files (covers sort comparator)', () => {
    const fc1 = makeFileCoverage(join(FIXTURES, 'simple', 'action.yml'));
    const fc2 = makeFileCoverage(join(FIXTURES, 'with-if', 'action.yml'));
    const report: CoverageReport = {
      files: { [fc1.path]: fc1, [fc2.path]: fc2 },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: fc1.steps, ifBranches: fc1.ifBranches, inputs: fc1.inputs, outputs: fc1.outputs, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat
      },
    };
    generateHtmlReport(report, tmpDir, FIXTURES);
    expect(existsSync(join(tmpDir, 'index.html'))).toBe(true);
    expect(existsSync(join(tmpDir, 'simple', 'action.yml.html'))).toBe(true);
    expect(existsSync(join(tmpDir, 'with-if', 'action.yml.html'))).toBe(true);
  });

  it('creates output directory if it does not exist', () => {
    const nested = join(tmpDir, 'nested', 'report');
    generateHtmlReport(makeEmptyReport(), nested);
    expect(existsSync(join(nested, 'index.html'))).toBe(true);
  });

  it('creates <rel>.html for each JS file in the report', () => {
    const jsPath = join(FIXTURES, 'js-sample.js');
    const jsFile: JsFileCoverage = { path: jsPath, statements: zeroStat, branches: zeroStat, functions: zeroStat, lines: zeroStat, istanbulData: emptyIstanbul };
    const report: CoverageReport = {
      files: {},
      jsFiles: { [jsPath]: jsFile },
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat
      },
    };
    generateHtmlReport(report, tmpDir, FIXTURES);
    expect(existsSync(join(tmpDir, 'js-sample.js.html'))).toBe(true);
  });

  it('sorts JS files by path (covers JS sort comparator)', () => {
    const jsPath1 = join(FIXTURES, 'js-sample.js');
    const jsPath2 = join(FIXTURES, 'simple', 'action.yml'); // reuse as fake second JS path
    const makeJs = (p: string): JsFileCoverage => ({ path: p, statements: zeroStat, branches: zeroStat, functions: zeroStat, lines: zeroStat, istanbulData: emptyIstanbul });
    const report: CoverageReport = {
      files: {},
      jsFiles: { [jsPath1]: makeJs(jsPath1), [jsPath2]: makeJs(jsPath2) },
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat
      },
    };
    generateHtmlReport(report, tmpDir, FIXTURES);
    expect(existsSync(join(tmpDir, 'index.html'))).toBe(true);
  });
});
