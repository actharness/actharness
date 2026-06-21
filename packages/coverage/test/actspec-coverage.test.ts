// Tests for actharness-coverage.ts — module-level singleton with vi.resetModules().

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyIncludeExclude } from '../src/actharness-coverage.js';
import type { CoverageReport, FileCoverage, CoverageStat } from '../src/types.js';

const mockRegisterRunListener = vi.hoisted(() => vi.fn());
vi.mock('@actharness/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actharness/core')>();
  return { ...actual, registerRunListener: mockRegisterRunListener };
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

// ── actharnessCoverage() ─────────────────────────────────────────────────────────

describe('actharnessCoverage()', () => {
  it('registers a run listener', async () => {
    const { actharnessCoverage } = await import('../src/actharness-coverage.js');
    actharnessCoverage();
    expect(mockRegisterRunListener).toHaveBeenCalledOnce();
  });

  it('returns void', async () => {
    const { actharnessCoverage } = await import('../src/actharness-coverage.js');
    const result = actharnessCoverage();
    expect(result).toBeUndefined();
  });

  it('is idempotent — second call does not register another listener', async () => {
    const { actharnessCoverage } = await import('../src/actharness-coverage.js');
    actharnessCoverage();
    actharnessCoverage();
    expect(mockRegisterRunListener).toHaveBeenCalledOnce();
  });
});

// ── getCoverage() ─────────────────────────────────────────────────────────────

describe('getCoverage()', () => {
  it('returns a CoverageReport after actharnessCoverage() is called', async () => {
    const { actharnessCoverage, getCoverage } = await import('../src/actharness-coverage.js');
    actharnessCoverage();
    const report = await getCoverage();
    expect(report).toHaveProperty('files');
    expect(report).toHaveProperty('total');
    expect(typeof report.files).toBe('object');
    expect(Array.isArray(report.files)).toBe(false);
  });

  it('throws when actharnessCoverage() has not been called', async () => {
    const { getCoverage } = await import('../src/actharness-coverage.js');
    await expect(getCoverage()).rejects.toThrow('actharnessCoverage() has not been called');
  });
});

// ── applyIncludeExclude() ─────────────────────────────────────────────────────

function makeFileCoverage(path: string, opts: { covered?: number; total?: number } = {}): FileCoverage {
  const stat: CoverageStat = { covered: opts.covered ?? 1, total: opts.total ?? 1, pct: 100 };
  return { path, steps: stat, ifBranches: stat, inputs: stat, outputs: stat, ifBranchTable: [], inputTable: [], outputTable: [], stepHits: {}, stepReached: {}, uncoveredSteps: [] };
}

function makeReport(files: FileCoverage[]): CoverageReport {
  const stat: CoverageStat = { covered: 0, total: 0, pct: 0 };
  return {
    files: Object.fromEntries(files.map((f) => [f.path, f])),
    jsFiles: {},
    total: { steps: stat, ifBranches: stat, inputs: stat, outputs: stat, jsStatements: stat, jsBranches: stat, jsFunctions: stat, jsLines: stat, shShellLines: stat, pwshShellLines: stat, pythonShellStatements: stat, pythonShellBranches: stat, pythonShellLines: stat, bashShellLines: stat, nodeShellLines: stat, nodeShellStatements: stat, nodeShellBranches: stat },
    pythonShellFiles: {},
    shShellFiles: {},
    bashShellFiles: {},
    pwshShellFiles: {},
    nodeShellFiles: {},
  };
}

describe('applyIncludeExclude()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'actharness-ie-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns base report unchanged when no include or exclude', () => {
    const base = makeReport([makeFileCoverage('/a/action.yml')]);
    const result = applyIncludeExclude(base, {}, tmpDir);
    expect(result).toBe(base);
  });

  it('returns base report unchanged when include and exclude are empty arrays', () => {
    const base = makeReport([makeFileCoverage('/a/action.yml')]);
    const result = applyIncludeExclude(base, { include: [], exclude: [] }, tmpDir);
    expect(result).toBe(base);
  });

  it('exclude removes matching files from the report', () => {
    const fileA = join(tmpDir, 'action.yml');
    const fileB = join(tmpDir, 'other.yml');
    const base = makeReport([makeFileCoverage(fileA), makeFileCoverage(fileB)]);
    const result = applyIncludeExclude(base, { exclude: ['other.yml'] }, tmpDir);
    expect(result.files[fileA]).toBeDefined();
    expect(result.files[fileB]).toBeUndefined();
  });

  it('exclude does not remove files that do not match the pattern', () => {
    const fileA = join(tmpDir, 'action.yml');
    const base = makeReport([makeFileCoverage(fileA)]);
    const result = applyIncludeExclude(base, { exclude: ['other.yml'] }, tmpDir);
    expect(result.files[fileA]).toBeDefined();
  });

  it('include adds untracked valid action.yml files at 0%', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps:\n    - id: s1\n      run: echo hi\n      shell: bash\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    expect(result.files[actionPath]).toBeDefined();
    expect(result.files[actionPath]!.steps.covered).toBe(0);
    expect(result.files[actionPath]!.steps.total).toBe(1);
    expect(result.files[actionPath]!.uncoveredSteps).toEqual(['s1']);
  });

  it('include does not add files already in the report', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const base = makeReport([makeFileCoverage(actionPath, { covered: 1, total: 1 })]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    expect(result.files[actionPath]!.steps.covered).toBe(1);
  });

  it('include skips files not matching the pattern', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['*.ts'] }, tmpDir);
    expect(result.files[actionPath]).toBeUndefined();
  });

  it('include skips invalid (non-action) yml files', () => {
    const badPath = join(tmpDir, 'not-action.yml');
    writeFileSync(badPath, 'not: valid: action\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['*.yml'] }, tmpDir);
    expect(result.files[badPath]).toBeUndefined();
  });

  it('include + exclude: exclude wins over include for same file', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['*.yml'], exclude: ['action.yml'] }, tmpDir);
    expect(result.files[actionPath]).toBeUndefined();
  });

  it('include skips node_modules directories', () => {
    const nmDir = join(tmpDir, 'node_modules', 'pkg');
    mkdirSync(nmDir, { recursive: true });
    writeFileSync(join(nmDir, 'action.yml'), 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['**/action.yml'] }, tmpDir);
    expect(result.files[join(nmDir, 'action.yml')]).toBeUndefined();
  });

  it('include for action with if: branches populates ifBranchTable', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps:\n    - id: s1\n      if: failure()\n      run: echo hi\n      shell: bash\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.ifBranchTable).toHaveLength(1);
    expect(fc.ifBranchTable[0]).toMatchObject({ step: 's1', expression: 'failure()', trueCount: 0, falseCount: 0 });
    expect(fc.ifBranches.total).toBe(2);
    expect(fc.ifBranches.covered).toBe(0);
  });

  it('scanDir returns empty result when cwd does not exist', () => {
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['*.yml'] }, '/nonexistent/path/xyz');
    expect(Object.keys(result.files)).toHaveLength(0);
  });

  it('re-aggregates total after include adds a new file', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps:\n    - id: s1\n      run: echo hi\n      shell: bash\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    expect(result.total.steps.total).toBe(1);
    expect(result.total.steps.covered).toBe(0);
    expect(result.total.steps.pct).toBe(0);
  });

  it('_buildZeroFileCoverage: action with inputs covers inputTotal (? 2 and : 1 branches)', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\nruns:\n  using: composite\n  steps: []\ninputs:\n  greeting:\n    description: Name\n    default: World\n  token:\n    description: Token\n    required: true\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    // greeting has default → 2 slots; token has no default → 1 slot; total = 3
    expect(fc.inputs.total).toBe(3);
    expect(fc.inputs.covered).toBe(0);
    expect(fc.inputs.pct).toBe(0);
  });

  it('_buildZeroFileCoverage: zero-step action reports pct=100', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(actionPath, 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.steps.total).toBe(0);
    expect(fc.steps.pct).toBe(100);
    expect(fc.ifBranches.pct).toBe(100);
    expect(fc.inputs.pct).toBe(100);
    expect(fc.uncoveredSteps).toEqual([]);
  });

  it('_buildZeroFileCoverage: step with if: always() sets falseBranchImpossible and counts 1 branch', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\nruns:\n  using: composite\n  steps:\n    - id: s1\n      if: ${{ always() }}\n      run: echo hi\n      shell: bash\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.ifBranchTable[0]).toMatchObject({ step: 's1', expression: '${{ always() }}', falseBranchImpossible: true });
    expect(fc.ifBranches.total).toBe(1);
    expect(fc.ifBranches.covered).toBe(0);
  });

  it('_buildZeroFileCoverage: step with if: success() is excluded from ifBranchTable', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\nruns:\n  using: composite\n  steps:\n    - id: s1\n      if: success()\n      run: echo hi\n      shell: bash\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    expect(result.files[actionPath]!.ifBranchTable).toHaveLength(0);
  });

  it('_buildZeroFileCoverage: step with if: failure() but no id uses __step_N__ in table', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\nruns:\n  using: composite\n  steps:\n    - if: failure()\n      run: echo hi\n      shell: bash\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.ifBranchTable[0]?.step).toBe('__step_1__');
    expect(fc.uncoveredSteps[0]).toBe('__step_1__');
  });

  it('_buildZeroFileCoverage: action with outputs populates outputTable at 0%', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\noutputs:\n  greeting:\n    description: hi\n    value: x\nruns:\n  using: composite\n  steps: []\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.outputTable).toHaveLength(1);
    expect(fc.outputTable[0]).toMatchObject({ name: 'greeting', covered: false });
    expect(fc.outputs).toEqual({ covered: 0, total: 1, pct: 0 });
  });

  it('_buildZeroFileCoverage: action without outputs has outputTotal=0 and pct=100', () => {
    const actionPath = join(tmpDir, 'action.yml');
    writeFileSync(
      actionPath,
      'name: T\nruns:\n  using: composite\n  steps: []\n',
    );
    const base = makeReport([]);
    const result = applyIncludeExclude(base, { include: ['action.yml'] }, tmpDir);
    const fc = result.files[actionPath]!;
    expect(fc.outputTable).toHaveLength(0);
    expect(fc.outputs).toEqual({ covered: 0, total: 0, pct: 100 });
  });
});
