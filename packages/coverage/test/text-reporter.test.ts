import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildTextReport, buildTextSummary } from '../src/text-reporter.js';
import type { CoverageReport, CoverageStat, FileCoverage, JsFileCoverage, JsIstanbulData, NodeShellFileCoverage, PythonShellFileCoverage, ShShellFileCoverage, BashShellFileCoverage, PwshShellFileCoverage } from '../src/types.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

function makeStat(covered: number, total: number): CoverageStat {
  return { covered, total, pct: total === 0 ? 100 : (covered / total) * 100 };
}

const zeroStat: CoverageStat = { covered: 0, total: 0, pct: 0 };
const emptyIstanbul: JsIstanbulData = { s: {}, b: {}, f: {}, statementMap: {}, branchMap: {}, fnMap: {} };

function makeReport(overrides: Partial<{
  stepsC: number; stepsT: number;
  ifC: number; ifT: number;
  inC: number; inT: number;
  outC: number; outT: number;
}> = {}): CoverageReport {
  const { stepsC = 0, stepsT = 0, ifC = 0, ifT = 0, inC = 0, inT = 0, outC = 0, outT = 0 } = overrides;
  return {
    files: {},
    jsFiles: {},
    pythonShellFiles: {},
    shShellFiles: {},
    bashShellFiles: {},
    pwshShellFiles: {},
    nodeShellFiles: {},
    total: {
      steps: makeStat(stepsC, stepsT),
      ifBranches: makeStat(ifC, ifT),
      inputs: makeStat(inC, inT),
      outputs: makeStat(outC, outT),
      jsStatements: zeroStat,
      jsBranches: zeroStat,
      jsFunctions: zeroStat,
      jsLines: zeroStat,
      shShellLines: zeroStat,
      bashShellLines: zeroStat,
      pwshShellLines: zeroStat,
      nodeShellLines: zeroStat,
      nodeShellStatements: zeroStat,
      nodeShellBranches: zeroStat,
      pythonShellStatements: zeroStat,
      pythonShellBranches: zeroStat,
      pythonShellLines: zeroStat,
    },
  };
}

function makeReportWithFile(path: string): CoverageReport {
  const stat = (c: number, t: number) => makeStat(c, t);
  const fc = {
    path,
    steps: stat(2, 4),
    ifBranches: stat(1, 2),
    inputs: stat(0, 3),
    outputs: stat(0, 0),
    ifBranchTable: [],
    inputTable: [],
    outputTable: [],
    stepHits: {},
    stepReached: {},
    uncoveredSteps: [],
  };
  const total = {
    steps: stat(2, 4),
    ifBranches: stat(1, 2),
    inputs: stat(0, 3),
    outputs: stat(0, 0),
    jsStatements: zeroStat,
    jsBranches: zeroStat,
    jsFunctions: zeroStat,
    jsLines: zeroStat,
    shShellLines: zeroStat,
    bashShellLines: zeroStat,
    pwshShellLines: zeroStat,
    nodeShellLines: zeroStat,
    nodeShellStatements: zeroStat,
    nodeShellBranches: zeroStat,
    pythonShellStatements: zeroStat,
    pythonShellBranches: zeroStat,
    pythonShellLines: zeroStat,
  };
  return { files: { [path]: fc }, jsFiles: {}, pythonShellFiles: {}, shShellFiles: {}, bashShellFiles: {}, pwshShellFiles: {}, nodeShellFiles: {}, total };
}

function makeReportWithJs(jsFile: JsFileCoverage): CoverageReport {
  const jsStat = jsFile.statements;
  return {
    files: {},
    jsFiles: { [jsFile.path]: jsFile },
    pythonShellFiles: {},
    shShellFiles: {},
    bashShellFiles: {},
    pwshShellFiles: {},
    nodeShellFiles: {},
    total: {
      steps: zeroStat,
      ifBranches: zeroStat,
      inputs: zeroStat,
      outputs: zeroStat,
      jsStatements: jsStat,
      jsBranches: jsFile.branches,
      jsFunctions: jsFile.functions,
      jsLines: jsFile.lines,
      shShellLines: zeroStat,
      bashShellLines: zeroStat,
      pwshShellLines: zeroStat,
      nodeShellLines: zeroStat,
      nodeShellStatements: zeroStat,
      nodeShellBranches: zeroStat,
      pythonShellStatements: zeroStat,
      pythonShellBranches: zeroStat,
      pythonShellLines: zeroStat,
    },
  };
}

// ── buildTextReport ───────────────────────────────────────────────────────────

describe('buildTextReport', () => {
  it('returns a string with header columns', () => {
    const report = makeReport();
    const text = buildTextReport(report, '/root');
    expect(text).toContain('Steps');
    expect(text).toContain('If-Branches');
    expect(text).toContain('Inputs');
    expect(text).not.toContain('With-Inputs');
  });

  it('includes "All files" total row', () => {
    const text = buildTextReport(makeReport(), '/root');
    expect(text).toContain('All files');
  });

  it('includes file rows with relative paths', () => {
    const text = buildTextReport(makeReportWithFile('/root/action.yml'), '/root');
    expect(text).toContain('action.yml');
  });

  it('shows n/a for zero-total stats', () => {
    const text = buildTextReport(makeReport(), '/root');
    expect(text).toContain('n/a');
  });

  it('shows percentage and fraction for non-zero stats', () => {
    const text = buildTextReport(makeReportWithFile('/root/action.yml'), '/root');
    expect(text).toMatch(/\d+\.\d+%/);
    expect(text).toMatch(/\d+\/\d+/);
  });

  it('sorts files alphabetically', () => {
    const stat = makeStat(1, 2);
    const base = { ifBranches: stat, inputs: stat, outputs: stat, ifBranchTable: [], inputTable: [], outputTable: [], stepHits: {}, stepReached: {}, uncoveredSteps: [] };
    const report: CoverageReport = {
      files: {
        '/root/z.yml': { path: '/root/z.yml', steps: stat, ...base },
        '/root/a.yml': { path: '/root/a.yml', steps: stat, ...base },
      },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: stat, ifBranches: stat, inputs: stat, outputs: stat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, '/root');
    expect(text.indexOf('a.yml')).toBeLessThan(text.indexOf('z.yml'));
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
    const text = buildTextReport(makeReportWithJs(jsFile), '/root');
    expect(text).toContain('JS File');
    expect(text).toContain('Stmts');
    expect(text).toContain('index.js');
    expect(text).toContain('All JS files');
  });

  it('does not show JS Coverage section when jsFiles is empty', () => {
    const text = buildTextReport(makeReport(), '/root');
    expect(text).not.toContain('JS File');
  });

  it('shows Python Coverage section when pythonShellFiles has entries, sorted alphabetically (covers lines 108-135)', () => {
    const pyStat = makeStat(3, 4);
    const emptyPythonData = { executedLines: [] as number[], missingLines: [] as number[], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const pyFileA: PythonShellFileCoverage = {
      path: '/root/a_script.py',
      statements: pyStat,
      branches: zeroStat,
      lines: pyStat,
      pythonCoverageData: { ...emptyPythonData, executedLines: [1, 2, 3], missingLines: [4, 2] },
    };
    const pyFileZ: PythonShellFileCoverage = {
      path: '/root/z_script.py',
      statements: zeroStat,
      branches: zeroStat,
      lines: zeroStat,
      pythonCoverageData: emptyPythonData,
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
    const text = buildTextReport(report, '/root');
    expect(text).toContain('Python');
    expect(text).toContain('a_script.py');
    expect(text).toContain('z_script.py');
    expect(text).toContain('All Python Shell steps');
    expect(text).toContain('Stmts');
    expect(text).toContain('Branches');
    expect(text.indexOf('a_script.py')).toBeLessThan(text.indexOf('z_script.py'));
  });

  it('does not show Python Coverage section when pythonShellFiles is empty', () => {
    const text = buildTextReport(makeReport(), '/root');
    expect(text).not.toContain('Python');
  });

  it('shows Node Shell Coverage section when nodeShellFiles has entries, sorted alphabetically', () => {
    const stmtStat = makeStat(2, 3);
    const brStat = makeStat(1, 2);
    const lnStat = makeStat(2, 3);
    const nodeShFileA: NodeShellFileCoverage = { path: '/root/a.yml#step-a', statements: stmtStat, branches: brStat, lines: lnStat, uncoveredLines: [] };
    const nodeShFileZ: NodeShellFileCoverage = { path: '/root/z.yml#step-z', statements: zeroStat, branches: zeroStat, lines: zeroStat, uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: { '/root/z.yml#step-z': nodeShFileZ, '/root/a.yml#step-a': nodeShFileA },
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
        jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat,
        shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat,
        nodeShellLines: lnStat, nodeShellStatements: stmtStat, nodeShellBranches: brStat,
        pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
      },
    };
    const text = buildTextReport(report, '/root');
    expect(text).toContain('Node Shell Step');
    expect(text).toContain('a.yml#step-a');
    expect(text).toContain('z.yml#step-z');
    expect(text).toContain('All Node Shell steps');
    expect(text).toContain('Stmts');
    expect(text).toContain('Branches');
    expect(text).toContain('Uncov. Lines');
    expect(text.indexOf('a.yml#step-a')).toBeLessThan(text.indexOf('z.yml#step-z'));
  });

  it('shows formatted uncovered line ranges in Node Shell Coverage section', () => {
    const stat = makeStat(1, 3);
    // consecutive → '1–3'; gap → '1, 3'; empty → no output (covers trunc padded branch)
    const nodeShCons: NodeShellFileCoverage = { path: '/root/a.yml#step-a', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 2, 3] };
    const nodeShGap: NodeShellFileCoverage = { path: '/root/b.yml#step-b', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 3] };
    const nodeShEmpty: NodeShellFileCoverage = { path: '/root/c.yml#step-c', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [] };
    // range then gap → '1–2, 4' (covers else-with-range path in formatRanges loop)
    const nodeShMix: NodeShellFileCoverage = { path: '/root/e.yml#step-e', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 2, 4] };
    // long range to trigger truncation (> 20 chars): 1, 3, 5, 7, 9, 11, 13, 15, 17 = 28 chars
    const nodeShLong: NodeShellFileCoverage = { path: '/root/d.yml#step-d', statements: stat, branches: zeroStat, lines: stat, uncoveredLines: [1, 3, 5, 7, 9, 11, 13, 15, 17] };
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
        '/root/d.yml#step-d': nodeShLong,
        '/root/e.yml#step-e': nodeShMix,
      },
      total: {
        steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat,
        jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat,
        shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat,
        nodeShellLines: stat, nodeShellStatements: stat, nodeShellBranches: zeroStat,
        pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat,
      },
    };
    const text = buildTextReport(report, '/root');
    expect(text).toContain('1–3');
    expect(text).toContain('1, 3');
    expect(text).toContain('1–2, 4');
    expect(text).toContain('…');
  });

  it('does not show Node Shell Coverage section when nodeShellFiles is empty', () => {
    const text = buildTextReport(makeReport(), '/root');
    expect(text).not.toContain('Node Shell Step');
  });

  it('sorts JS files alphabetically', () => {
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
    const text = buildTextReport(report, '/root');
    expect(text.indexOf('a.js')).toBeLessThan(text.indexOf('z.js'));
  });

  // ── integration tests for computeUncoveredYamlRunLines / computeUncoveredJsLines ──

  function makeFc(path: string, overrides: Partial<FileCoverage> = {}): FileCoverage {
    return {
      path,
      steps: zeroStat,
      ifBranches: zeroStat,
      inputs: zeroStat,
      outputs: zeroStat,
      ifBranchTable: [],
      inputTable: [],
      outputTable: [],
      stepHits: {},
      stepReached: {},
      uncoveredSteps: [],
      ...overrides,
    };
  }

  function makeReportFromFc(fc: FileCoverage): CoverageReport {
    const z = zeroStat;
    return {
      files: { [fc.path]: fc },
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: z, ifBranches: z, inputs: z, outputs: z, jsStatements: z, jsBranches: z, jsFunctions: z, jsLines: z, shShellLines: z, bashShellLines: z, pwshShellLines: z, nodeShellLines: z, nodeShellStatements: z, nodeShellBranches: z, pythonShellStatements: z, pythonShellBranches: z, pythonShellLines: z },
    };
  }

  it('integration: computes uncovered YAML run lines for sh step with block scalar (hits path)', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    // Only line 1 tracked — lines 2 and 3 are undefined, triggering ?? 0 null branch,
    // and producing 2 uncovered YAML lines to exercise the sort comparator.
    const fc = makeFc(fixturePath, {
      shStepLineHits: { step1: { 1: 1 } },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-sh-multiline-run');
    expect(text).toContain('Uncov. Lines');
  });

  it('integration: skips sh step when no hits data is available (hits falsy path)', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const fc = makeFc(fixturePath);
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-sh-multiline-run');
  });

  it('integration: skips steps without run (uses-only steps)', () => {
    const fixturePath = join(FIXTURES, 'uses-with', 'action.yml');
    const fc = makeFc(fixturePath);
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('uses-with');
  });

  it('integration: handles inline run where runHeaderLine is not found', () => {
    const fixturePath = join(FIXTURES, 'with-inline-run', 'action.yml');
    const fc = makeFc(fixturePath, {
      shStepLineHits: { '__step_1__': { 1: 0 } },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-inline-run');
  });

  it('integration: skips comment lines in sh run script', () => {
    const fixturePath = join(FIXTURES, 'with-sh-comment-run', 'action.yml');
    const fc = makeFc(fixturePath, {
      shStepLineHits: { step1: { 2: 0 } },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-sh-comment-run');
  });

  it('integration: computes uncovered YAML run lines for node shell step (nodeShStepIstanbul path)', () => {
    const fixturePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const istanbul: JsIstanbulData = {
      s: { '0': 0, '1': 1 },
      b: {},
      f: {},
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
        '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
      },
      branchMap: {},
      fnMap: {},
    };
    const fc = makeFc(fixturePath, {
      nodeShStepIstanbul: { step1: istanbul },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-node-run');
  });

  it('integration: isBlockScalar=false for inline node shell run (covers line 80 false branch)', () => {
    const fixturePath = join(FIXTURES, 'with-node-inline-run', 'action.yml');
    const istanbul: JsIstanbulData = {
      s: { '0': 0 },
      b: {},
      f: {},
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 22 } },
      },
      branchMap: {},
      fnMap: {},
    };
    const fc = makeFc(fixturePath, {
      nodeShStepIstanbul: { step1: istanbul },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('with-node-inline-run');
  });

  it('integration: covers ?? [] branch for node action with no steps (line 132)', () => {
    const fixturePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const fc = makeFc(fixturePath);
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('node-main-only');
  });

  it('integration: isBlockScalar=false for sh step with inline run key', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const fc = makeFc(fixturePath, {
      shStepLineHits: { step1: { 1: 0 } },
    });
    const text = buildTextReport(makeReportFromFc(fc), FIXTURES);
    expect(text).toContain('simple');
  });

  it('integration: computes uncovered JS lines from non-empty Istanbul data', () => {
    const jsStat = makeStat(1, 3);
    const istanbul: JsIstanbulData = {
      s: { '0': 0, '1': 0, '2': 1 },
      b: {},
      f: {},
      statementMap: {
        '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
        '1': { start: { line: 3, column: 0 }, end: { line: 3, column: 10 } },
        '2': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 } },
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
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: jsStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: jsStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, '/root');
    expect(text).toContain('Uncov. Lines');
    expect(text).toContain('1');
  });

  it('shows Sh Shell Coverage section when shShellFiles has entries (covers computeUncoveredYamlLinesForStep block-scalar path)', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const stepKey = `${fixturePath}#step1`;
    const fixturePath2 = join(FIXTURES, 'with-sh-comment-run', 'action.yml');
    const stepKey2 = `${fixturePath2}#step1`;
    const shFile: ShShellFileCoverage = { path: stepKey, lines: makeStat(1, 3), uncoveredLines: [2, 3] };
    const shFile2: ShShellFileCoverage = { path: stepKey2, lines: makeStat(2, 2), uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [stepKey]: shFile, [stepKey2]: shFile2 },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(3, 5), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
    expect(text).toContain('All Sh Shell steps');
    expect(text).toContain('Uncov. Lines');
  });

  it('shows Bash Shell Coverage section when bashShellFiles has entries (covers computeUncoveredYamlLinesForStep inline path)', () => {
    const fixturePath = join(FIXTURES, 'simple', 'action.yml');
    const stepKey = `${fixturePath}#step1`;
    const fixturePath2 = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const stepKey2 = `${fixturePath2}#step1`;
    const bashFile: BashShellFileCoverage = { path: stepKey, lines: makeStat(1, 1), uncoveredLines: [1] };
    const bashFile2: BashShellFileCoverage = { path: stepKey2, lines: makeStat(3, 3), uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: { [stepKey]: bashFile, [stepKey2]: bashFile2 },
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: makeStat(4, 4), pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Bash Shell Step');
    expect(text).toContain('All Bash Shell steps');
  });

  it('shows Pwsh Shell Coverage section when pwshShellFiles has entries', () => {
    const fixturePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    const stepKey = `${fixturePath}#step1`;
    const fixturePath2 = join(FIXTURES, 'simple', 'action.yml');
    const stepKey2 = `${fixturePath2}#step1`;
    const pwshFile: PwshShellFileCoverage = { path: stepKey, lines: makeStat(1, 1), uncoveredLines: [1] };
    const pwshFile2: PwshShellFileCoverage = { path: stepKey2, lines: makeStat(1, 1), uncoveredLines: [] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: { [stepKey]: pwshFile, [stepKey2]: pwshFile2 },
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: zeroStat, bashShellLines: zeroStat, pwshShellLines: makeStat(2, 2), nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Pwsh Shell Step');
    expect(text).toContain('All Pwsh Shell steps');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when file is unreadable (covers readFileSync catch)', () => {
    const badKey = '/nonexistent/action.yml#step1';
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, '/nonexistent');
    expect(text).toContain('Sh Shell Step');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when parseAction fails (covers parseAction catch)', () => {
    const testFilePath = fileURLToPath(import.meta.url);
    const badKey = `${testFilePath}#step1`;
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when stepId not found (covers stepIdx===-1 branch)', () => {
    const fixturePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const badKey = `${fixturePath}#nonexistent_step`;
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when step has no run (covers !step.run branch)', () => {
    const fixturePath = join(FIXTURES, 'uses-with', 'action.yml');
    const badKey = `${fixturePath}#greet-step`;
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when action has no steps (covers ?? [] right-side branch)', () => {
    const fixturePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const badKey = `${fixturePath}#main`;
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
  });

  it('computeUncoveredYamlLinesForStep: returns raw lines when runHeaderLine not found (covers runHeaderLine===undefined branch)', () => {
    const fixturePath = join(FIXTURES, 'with-inline-run', 'action.yml');
    const badKey = `${fixturePath}#__step_1__`;
    const shFile: ShShellFileCoverage = { path: badKey, lines: makeStat(0, 1), uncoveredLines: [1] };
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: { [badKey]: shFile },
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: { steps: zeroStat, ifBranches: zeroStat, inputs: zeroStat, outputs: zeroStat, jsStatements: zeroStat, jsBranches: zeroStat, jsFunctions: zeroStat, jsLines: zeroStat, shShellLines: makeStat(0, 1), bashShellLines: zeroStat, pwshShellLines: zeroStat, nodeShellLines: zeroStat, nodeShellStatements: zeroStat, nodeShellBranches: zeroStat, pythonShellStatements: zeroStat, pythonShellBranches: zeroStat, pythonShellLines: zeroStat },
    };
    const text = buildTextReport(report, FIXTURES);
    expect(text).toContain('Sh Shell Step');
  });
});

// ── buildTextSummary ──────────────────────────────────────────────────────────

describe('buildTextSummary', () => {
  it('returns "No coverage data." when all totals are zero', () => {
    const text = buildTextSummary(makeReport());
    expect(text).toBe('No coverage data.');
  });

  it('shows Steps metric with bar when steps total > 0', () => {
    const text = buildTextSummary(makeReport({ stepsC: 1, stepsT: 2 }));
    expect(text).toContain('Steps:');
    expect(text).toMatch(/[█░]/);
  });

  it('shows If-Branches metric when ifBranches total > 0', () => {
    const text = buildTextSummary(makeReport({ ifC: 0, ifT: 2 }));
    expect(text).toContain('If-Branches:');
  });

  it('shows Inputs metric when inputs total > 0', () => {
    const text = buildTextSummary(makeReport({ inC: 1, inT: 1 }));
    expect(text).toContain('Inputs:');
  });

  it('shows Outputs metric when outputs total > 0', () => {
    const text = buildTextSummary(makeReport({ outC: 1, outT: 2 }));
    expect(text).toContain('Outputs:');
  });

  it('joins multiple metrics with |', () => {
    const text = buildTextSummary(makeReport({ stepsC: 1, stepsT: 2, ifC: 1, ifT: 2 }));
    expect(text).toContain('|');
  });

  it('bar function clamps pct below 0 to 0 (all empty bar)', () => {
    const text = buildTextSummary(makeReport({ stepsC: 0, stepsT: 10 }));
    // 0% → all empty chars
    expect(text).toMatch(/░{10}/);
  });

  it('bar function clamps pct above 100 to 100 (all filled bar)', () => {
    // 100% → all filled chars
    const text = buildTextSummary(makeReport({ stepsC: 10, stepsT: 10 }));
    expect(text).toMatch(/█{10}/);
  });

  it('bar function clamps pct < 0 (covers pct < 0 branch)', () => {
    // inject a stat with negative pct directly
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: { covered: 0, total: 10, pct: -5 },
        ifBranches: zeroStat,
        inputs: zeroStat,
        outputs: zeroStat,
        jsStatements: zeroStat,
        jsBranches: zeroStat,
        jsFunctions: zeroStat,
        jsLines: zeroStat,
        shShellLines: zeroStat,
        bashShellLines: zeroStat,
        pwshShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat,
        pythonShellStatements: zeroStat,
        pythonShellBranches: zeroStat,
        pythonShellLines: zeroStat,
      },
    };
    const text = buildTextSummary(report);
    // clamped to 0 → all empty
    expect(text).toMatch(/░{10}/);
  });

  it('bar function clamps pct > 100 (covers pct > 100 branch)', () => {
    const report: CoverageReport = {
      files: {},
      jsFiles: {},
      pythonShellFiles: {},
      shShellFiles: {},
      bashShellFiles: {},
      pwshShellFiles: {},
      nodeShellFiles: {},
      total: {
        steps: { covered: 12, total: 10, pct: 120 },
        ifBranches: zeroStat,
        inputs: zeroStat,
        outputs: zeroStat,
        jsStatements: zeroStat,
        jsBranches: zeroStat,
        jsFunctions: zeroStat,
        jsLines: zeroStat,
        shShellLines: zeroStat,
        bashShellLines: zeroStat,
        pwshShellLines: zeroStat,
        nodeShellLines: zeroStat,
        nodeShellStatements: zeroStat,
        nodeShellBranches: zeroStat,
        pythonShellStatements: zeroStat,
        pythonShellBranches: zeroStat,
        pythonShellLines: zeroStat,
      },
    };
    const text = buildTextSummary(report);
    // clamped to 100 → all filled
    expect(text).toMatch(/█{10}/);
  });
});
