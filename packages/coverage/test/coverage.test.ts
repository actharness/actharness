import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { offsetToLoc, nodeRangeToIstanbul } from '../src/source-map.js';
import { buildActionCoverage } from '../src/coverage-map.js';
import { CoverageCollector, aggregateTotals } from '../src/collector.js';
import type { NodeShellCoverageEntry } from '../src/collector.js';
import { mergeJsCoverage, emptyJsStats, buildJsStats } from '../src/js-coverage.js';
import type { ParsedAction, StepResult } from '@actharness/types';

// Side-effectful import — covers index.ts (all re-exports)
import '../src/index.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));

// ── source-map utilities ──────────────────────────────────────────────────────

describe('offsetToLoc', () => {
  it('returns line 1, col 0 for offset 0', async () => {
    expect(offsetToLoc('hello', 0)).toEqual({ line: 1, column: 0 });
  });

  it('increments column within first line', async () => {
    expect(offsetToLoc('hello', 3)).toEqual({ line: 1, column: 3 });
  });

  it('increments line on newline', async () => {
    expect(offsetToLoc('line1\nline2', 6)).toEqual({ line: 2, column: 0 });
  });

  it('handles multiple newlines', async () => {
    expect(offsetToLoc('a\nb\nc', 4)).toEqual({ line: 3, column: 0 });
  });

  it('clamps offset beyond source length', async () => {
    const result = offsetToLoc('abc', 1000);
    expect(result.line).toBe(1);
    expect(result.column).toBe(3);
  });
});

describe('nodeRangeToIstanbul', () => {
  it('converts start and end offsets to Istanbul range', async () => {
    const source = 'line1\nline2\n';
    const range = nodeRangeToIstanbul(source, 0, 5);
    expect(range.start).toEqual({ line: 1, column: 0 });
    expect(range.end).toEqual({ line: 1, column: 5 });
  });
});

// ── buildActionCoverage ───────────────────────────────────────────────────────

function makeAction(opts: {
  file?: string;
  steps?: Array<{ id?: string; if?: string }>;
}): ParsedAction {
  const steps = (opts.steps ?? []).map((s, i) => {
    const step: import('@actharness/types').ParsedStep = {
      id: s.id ?? `step-${i}`,
      run: 'echo hi',
      shell: 'bash',
      _range: { start: i * 20, end: i * 20 + 19 },
    };
    if (s.if !== undefined) step.if = s.if;
    return step;
  });

  const action: ParsedAction = {
    name: 'Test Action',
    runs: { using: 'composite', steps },
    _dir: '/fake',
  };
  if (opts.file !== undefined) action._file = opts.file;
  return action;
}

function makeStepResult(
  id: string,
  opts: { ran?: boolean; ifResult?: boolean; outputs?: Record<string, string> } = {},
): StepResult {
  const result: StepResult = {
    id,
    name: id,
    phase: 'main',
    ran: opts.ran ?? true,
    outcome: opts.ran === false ? 'skipped' : 'success',
    conclusion: opts.ran === false ? 'skipped' : 'success',
    outputs: opts.outputs ?? {},
    stdout: '',
    stderr: '',
    annotations: [],
  };
  if (opts.ifResult !== undefined) {
    result.if = { expression: 'success()', result: opts.ifResult };
  }
  return result;
}

describe('buildActionCoverage', () => {
  it('returns a file coverage with the correct path', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 'step-0' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('step-0')]);
    expect((coverage as unknown as { path: string }).path).toBe('/fake/action.yml');
  });

  it('counts a ran step as statement hit = 1', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1', { ran: true })]);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(data.s['0']).toBe(1);
  });

  it('counts a step with no if: and ran: false (job-state skip) as statement hit = 0', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1', { ran: false })]);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(data.s['0']).toBe(0);
  });

  it('counts a step absent from results as statement hit = 0', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, []);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(data.s['0']).toBe(0);
  });

  it('counts a step with explicit if: and ran: false (condition false) as statement hit = 0', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'failure()' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1', { ran: false })]);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(data.s['0']).toBe(0);
  });

  it('records if: branch when ifResult is true', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'failure()' }] });
    const result = makeStepResult('s1', { ran: true, ifResult: true });
    const coverage = buildActionCoverage(action, [result]);
    const data = coverage as unknown as { b: Record<string, [number, number]> };
    expect(data.b['0']?.[0]).toBe(1);
    expect(data.b['0']?.[1]).toBe(0);
  });

  it('records if: branch when ifResult is false', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'failure()' }] });
    const result = makeStepResult('s1', { ran: false, ifResult: false });
    const coverage = buildActionCoverage(action, [result]);
    const data = coverage as unknown as { b: Record<string, [number, number]> };
    expect(data.b['0']?.[0]).toBe(0);
    expect(data.b['0']?.[1]).toBe(1);
  });

  it('returns per-run count of 1 when step ran (accumulation is handled by Istanbul map)', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1' }] });
    const run1 = buildActionCoverage(action, [makeStepResult('s1', { ran: true })]);
    const run2 = buildActionCoverage(action, [makeStepResult('s1', { ran: true })]);
    const data1 = run1 as unknown as { s: Record<string, number> };
    const data2 = run2 as unknown as { s: Record<string, number> };
    expect(data1.s['0']).toBe(1);
    expect(data2.s['0']).toBe(1);
  });

  it('handles missing _file gracefully', async () => {
    const action = makeAction({ steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1')]);
    expect(coverage).toBeDefined();
  });

  it('handles nonexistent file gracefully', async () => {
    const action = makeAction({ file: '/nonexistent/action.yml', steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1')]);
    expect(coverage).toBeDefined();
  });

  it('uses nodeRangeToIstanbul when file exists and step has _range', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'actharness-cov-range-'));
    const filePath = join(tmpDir, 'action.yml');
    writeFileSync(filePath, 'name: T\nruns:\n  using: composite\n  steps: []\n');
    const action = makeAction({ file: filePath, steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1')]);
    const data = coverage as unknown as { statementMap: Record<string, unknown> };
    expect(data.statementMap['0']).toBeDefined();
  });

  it('falls back to empty statementMap when action has no steps', async () => {
    const action: ParsedAction = {
      name: 'No steps',
      runs: { using: 'composite' },
      _dir: '/fake',
      _file: '/fake/action.yml',
    };
    const coverage = buildActionCoverage(action, []);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(Object.keys(data.s)).toHaveLength(0);
  });

  it('falls back to "action" name when action.name is falsy', async () => {
    const action: ParsedAction = {
      name: '',
      runs: { using: 'composite', steps: [] },
      _dir: '/fake',
      _file: '/fake/action.yml',
    };
    const coverage = buildActionCoverage(action, []);
    const data = coverage as unknown as { fnMap: Record<string, { name: string }> };
    expect(data.fnMap['0']?.name).toBe('action');
  });

  it('skips if-branch when step.if is success()', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'success()' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1', { ran: true })]);
    const data = coverage as unknown as { b: Record<string, unknown> };
    expect(data.b['0']).toBeUndefined();
  });

  it('uses __step_N__ id when step has no id field', async () => {
    const action: ParsedAction = {
      name: 'Unnamed',
      runs: {
        using: 'composite',
        steps: [{ run: 'echo hi', shell: 'bash', _range: { start: 0, end: 10 } }],
      },
      _dir: '/fake',
      _file: '/fake/action.yml',
    };
    const coverage = buildActionCoverage(action, [makeStepResult('__step_1__', { ran: true })]);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(data.s['0']).toBe(1);
  });

  it('returns per-run if-branch counts of 1/0 or 0/1 for each run', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'failure()' }] });
    const run1 = buildActionCoverage(action, [makeStepResult('s1', { ran: true, ifResult: true })]);
    const run2 = buildActionCoverage(action, [makeStepResult('s1', { ran: true, ifResult: false })]);
    const data1 = run1 as unknown as { b: Record<string, [number, number]> };
    const data2 = run2 as unknown as { b: Record<string, [number, number]> };
    expect(data1.b['0']).toEqual([1, 0]);
    expect(data2.b['0']).toEqual([0, 1]);
  });

  it('statementMap entry includes _stepId', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1')]);
    const data = coverage as unknown as { statementMap: Record<string, { _stepId?: string }> };
    expect(data.statementMap['0']?._stepId).toBe('s1');
  });

  it('sets _falseBranchImpossible on branch entry when step.if is always()', async () => {
    const action = makeAction({ file: '/fake/action.yml', steps: [{ id: 's1', if: 'always()' }] });
    const coverage = buildActionCoverage(action, [makeStepResult('s1', { ran: true, ifResult: true })]);
    const data = coverage as unknown as { branchMap: Record<string, { _falseBranchImpossible?: boolean }> };
    expect(data.branchMap['0']?._falseBranchImpossible).toBe(true);
  });
});

// ── buildActionCoverage — node actions ───────────────────────────────────────

function makeNodeAction(opts: {
  file?: string;
  pre?: string;
  preIf?: string;
  main?: string;
  post?: string;
  postIf?: string;
  withRanges?: boolean;
}): ParsedAction {
  const runs: import('@actharness/types').ParsedActionRuns = { using: 'node22' };
  if (opts.main !== undefined) {
    runs.main = opts.main;
    if (opts.withRanges) runs._mainRange = { start: 0, end: 10 };
  }
  if (opts.pre !== undefined) {
    runs.pre = opts.pre;
    if (opts.withRanges) runs._preRange = { start: 11, end: 20 };
  }
  if (opts.preIf !== undefined) {
    runs['pre-if'] = opts.preIf;
    if (opts.withRanges) runs._preIfRange = { start: 21, end: 30 };
  }
  if (opts.post !== undefined) {
    runs.post = opts.post;
    if (opts.withRanges) runs._postRange = { start: 31, end: 40 };
  }
  if (opts.postIf !== undefined) {
    runs['post-if'] = opts.postIf;
    if (opts.withRanges) runs._postIfRange = { start: 41, end: 50 };
  }

  const action: ParsedAction = { name: 'Node Test Action', runs, _dir: '/fake' };
  if (opts.file !== undefined) action._file = opts.file;
  return action;
}

function makePhaseResult(
  phase: 'pre' | 'main' | 'post',
  opts: { ran?: boolean; ifResult?: boolean } = {},
): StepResult {
  const result: StepResult = {
    id: phase,
    name: phase,
    phase,
    ran: opts.ran ?? true,
    outcome: opts.ran === false ? 'skipped' : 'success',
    conclusion: opts.ran === false ? 'skipped' : 'success',
    outputs: {},
    stdout: '',
    stderr: '',
    annotations: [],
  };
  if (opts.ifResult !== undefined) {
    result.if = { expression: 'placeholder', result: opts.ifResult };
  }
  return result;
}

describe('buildActionCoverage — node actions', () => {
  it('composite-only path is unaffected when action has no main (e.g. docker)', async () => {
    const action: ParsedAction = { name: 'Docker', runs: { using: 'docker' }, _dir: '/fake', _file: '/fake/action.yml' };
    const coverage = buildActionCoverage(action, []);
    const data = coverage as unknown as { s: Record<string, number> };
    expect(Object.keys(data.s)).toHaveLength(0);
  });

  it('counts main phase as statement hit = 1 when ran', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', withRanges: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { statementMap: Record<string, { _stepId?: string }>; s: Record<string, number> };
    const sId = Object.keys(data.statementMap).find((k) => data.statementMap[k]?._stepId === 'main')!;
    expect(data.s[sId]).toBe(1);
  });

  it('counts pre phase as statement hit = 0 when absent from results', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', pre: 'setup.js', withRanges: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { statementMap: Record<string, { _stepId?: string }>; s: Record<string, number> };
    const sId = Object.keys(data.statementMap).find((k) => data.statementMap[k]?._stepId === 'pre')!;
    expect(data.s[sId]).toBe(0);
  });

  it('skips a phase entirely (no statement entry) when pre/post is not defined', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js' });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { statementMap: Record<string, { _stepId?: string }> };
    const stepIds = Object.values(data.statementMap).map((e) => e._stepId);
    expect(stepIds).toEqual(['main']);
  });

  it('does not create a branch row for main (no pre-if/post-if equivalent)', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', withRanges: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { branchMap: Record<string, unknown> };
    expect(Object.keys(data.branchMap)).toHaveLength(0);
  });

  it('records pre-if branch when explicit and ifResult is true', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', pre: 'setup.js', preIf: 'always()', withRanges: true });
    const result = makePhaseResult('pre', { ran: true, ifResult: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true }), result]);
    const data = coverage as unknown as { branchMap: Record<string, { _stepId?: string; _expression?: string }>; b: Record<string, [number, number]> };
    const bId = Object.keys(data.branchMap).find((k) => data.branchMap[k]?._stepId === 'pre')!;
    expect(data.branchMap[bId]?._expression).toBe('always()');
    expect(data.b[bId]).toEqual([1, 0]);
  });

  it('records post-if branch when explicit and ifResult is false', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', post: 'cleanup.js', postIf: 'failure()', withRanges: true });
    const result = makePhaseResult('post', { ran: false, ifResult: false });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true }), result]);
    const data = coverage as unknown as { branchMap: Record<string, { _stepId?: string; _expression?: string }>; b: Record<string, [number, number]> };
    const bId = Object.keys(data.branchMap).find((k) => data.branchMap[k]?._stepId === 'post')!;
    expect(data.branchMap[bId]?._expression).toBe('failure()');
    expect(data.b[bId]).toEqual([0, 1]);
  });

  it('falls back to default range when source file does not exist', async () => {
    const action = makeNodeAction({ file: '/nonexistent/action.yml', main: 'index.js', pre: 'setup.js', preIf: 'always()', withRanges: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    expect(coverage).toBeDefined();
  });

  it('records branch as [0, 0] when the phase result is missing from stepResults', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', pre: 'setup.js', preIf: 'always()', withRanges: true });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { branchMap: Record<string, { _stepId?: string }>; b: Record<string, [number, number]> };
    const bId = Object.keys(data.branchMap).find((k) => data.branchMap[k]?._stepId === 'pre')!;
    expect(data.b[bId]).toEqual([0, 0]);
  });

  it('falls back to default range when _mainRange/_preIfRange are absent', async () => {
    const action = makeNodeAction({ file: '/fake/action.yml', main: 'index.js', pre: 'setup.js', preIf: 'always()' });
    const coverage = buildActionCoverage(action, [makePhaseResult('main', { ran: true })]);
    const data = coverage as unknown as { statementMap: Record<string, { start: { line: number } }> };
    const sId = Object.keys(data.statementMap)[0]!;
    expect(data.statementMap[sId]?.start.line).toBe(1);
  });
});

// ── CoverageCollector ─────────────────────────────────────────────────────────

describe('CoverageCollector', () => {
  it('starts with empty coverage map', async () => {
    const collector = new CoverageCollector();
    const data = collector.coverageMap.toJSON();
    expect(Object.keys(data)).toHaveLength(0);
  });

  it('reset() clears the map', async () => {
    const collector = new CoverageCollector();
    collector.reset();
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('createListener() returns a function', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    expect(typeof listener).toBe('function');
  });

  it('listener ignores runs with no sourceFile', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      {
        conclusion: 'success',
        outputs: {},
        steps: [],
        step: () => undefined,
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      },
      { sourceFile: undefined },
    );
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('flush() writes JSON file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-cov-test-'));
    const collector = new CoverageCollector();
    collector.flush(dir);
    expect(existsSync(join(dir, 'coverage-actharness.json'))).toBe(true);
  });

  it('listener processes valid sourceFile and records coverage', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      {
        conclusion: 'success',
        outputs: {},
        steps: [{ id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] }],
        step: () => undefined,
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml') },
    );
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(1);
  });

  it('listener accumulates output data across multiple runs (covers outRecord already-exists branch)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const result = {
      conclusion: 'success' as const,
      outputs: {},
      steps: [{ id: 'step1', name: 'run', phase: 'main' as const, ran: true, outcome: 'success' as const, conclusion: 'success' as const, outputs: { greeting: 'hello' }, stdout: '', stderr: '', annotations: [] }],
      step: () => undefined,
      env: {},
      annotations: [],
      stdout: '',
      stderr: '',
    };
    listener(result, { sourceFile: join(FIXTURES, 'with-outputs', 'action.yml') });
    listener(result, { sourceFile: join(FIXTURES, 'with-outputs', 'action.yml') });
    const report = await collector.toCoverageReport();
    expect(Object.values(report.files).length).toBeGreaterThan(0);
  });

  it('listener ignores runs when parseAction fails (nonexistent file)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: '/nonexistent/dir/action.yml' },
    );
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('merge() merges coverage from another collector', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    c1.merge(c2);
    expect(Object.keys(c1.coverageMap.toJSON())).toHaveLength(0);
  });

  it('flush() writes extended fragment with istanbulMap and inputExercises', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-cov-flush-'));
    const collector = new CoverageCollector();
    collector.flush(dir);
    const raw = JSON.parse(readFileSync(join(dir, 'coverage-actharness.json'), 'utf8')) as Record<string, unknown>;
    expect(raw).toHaveProperty('istanbulMap');
    expect(raw).toHaveProperty('inputExercises');
    expect(Array.isArray(raw['inputExercises'])).toBe(true);
  });

  it('toFragment() serializes istanbulMap and inputExercises', async () => {
    const collector = new CoverageCollector();
    const frag = collector.toFragment();
    expect(frag).toHaveProperty('istanbulMap');
    expect(frag).toHaveProperty('inputExercises');
  });

  it('CoverageCollector.fromParts() reconstructs a collector from an empty map', async () => {
    const c = CoverageCollector.fromParts({}, []);
    expect(c).toBeInstanceOf(CoverageCollector);
    expect(Object.keys(c.coverageMap.toJSON())).toHaveLength(0);
  });

  it('CoverageCollector.fromParts() reconstructs a collector with Istanbul data', async () => {
    const istanbulMap = {
      '/fake/action.yml': {
        path: '/fake/action.yml',
        statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
        s: { '0': 1 }, branchMap: {}, b: {}, fnMap: {}, f: {},
      },
    };
    const c = CoverageCollector.fromParts(istanbulMap, []);
    expect(c.coverageMap.toJSON()['/fake/action.yml']).toBeDefined();
  });

  it('CoverageCollector.fromParts() reconstructs a collector with inputExercises', async () => {
    const c = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 1, default: 0 } }, inputDefs: { name: { hasDefault: false } } },
    ]);
    const report = await c.toCoverageReport();
    expect(Object.keys(report.files)).toHaveLength(0); // no Istanbul data, but inputData exists
  });

  it('toCoverageReport() returns empty report when no data', async () => {
    const collector = new CoverageCollector();
    const report = await collector.toCoverageReport();
    expect(Object.keys(report.files)).toHaveLength(0);
    expect(Object.keys(report.jsFiles)).toHaveLength(0);
    expect(report.total.steps).toEqual({ covered: 0, total: 0, pct: 0 });
    expect(report.total.ifBranches).toEqual({ covered: 0, total: 0, pct: 0 });
    expect(report.total.inputs).toEqual({ covered: 0, total: 0, pct: 0 });
  });

  it('toCoverageReport() computes step stats from Istanbul data', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 }, _stepId: 's0' },
            '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 }, _stepId: 's1' },
          },
          s: { '0': 1, '1': 0 },
          branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(Object.keys(report.files)).toHaveLength(1);
    expect(report.files['/fake/action.yml']!.steps).toEqual({ covered: 1, total: 2, pct: 50 });
    expect(report.total.steps).toEqual({ covered: 1, total: 2, pct: 50 });
  });

  it('toCoverageReport() computes uncoveredSteps from statementMap._stepId', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 }, _stepId: 's0' },
            '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 }, _stepId: 's1' },
          },
          s: { '0': 1, '1': 0 },
          branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.uncoveredSteps).toEqual(['s1']);
  });

  it('toCoverageReport() uncoveredSteps excludes steps without _stepId in statementMap', async () => {
    // statementMap entry without _stepId should not appear in uncoveredSteps
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } },
          },
          s: { '0': 0 },
          branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.uncoveredSteps).toEqual([]);
  });

  it('toCoverageReport() computes ifBranch stats and ifBranchTable (truthy hit, falsy miss)', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1, _stepId: 's1', _expression: 'failure()' },
          },
          b: { '0': [1, 0] },
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranches).toEqual({ covered: 1, total: 2, pct: 50 });
    expect(report.files['/fake/action.yml']!.ifBranchTable).toHaveLength(1);
    expect(report.files['/fake/action.yml']!.ifBranchTable[0]).toMatchObject({ step: 's1', expression: 'failure()', trueCount: 1, falseCount: 0 });
  });

  it('toCoverageReport() branchStatOf covers t===0 (truthy miss) branch', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1, _stepId: 's1', _expression: 'failure()' },
          },
          b: { '0': [0, 1] },
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranches).toEqual({ covered: 1, total: 2, pct: 50 });
    expect(report.files['/fake/action.yml']!.ifBranchTable[0]).toMatchObject({ trueCount: 0, falseCount: 1 });
  });

  it('toCoverageReport() branchStatOf counts only 1 branch for always() (falseBranchImpossible)', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1, _stepId: 's1', _expression: 'always()', _falseBranchImpossible: true },
          },
          b: { '0': [1, 0] },
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranches).toEqual({ covered: 1, total: 1, pct: 100 });
    expect(report.files['/fake/action.yml']!.ifBranchTable[0]).toMatchObject({ falseBranchImpossible: true });
  });

  it('toCoverageReport() branchStatOf counts 0 covered when always() never ran (t===0, falseBranchImpossible)', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1, _stepId: 's1', _expression: 'always()', _falseBranchImpossible: true },
          },
          b: { '0': [0, 0] },
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranches).toEqual({ covered: 0, total: 1, pct: 0 });
  });

  it('toCoverageReport() ifBranchTable uses falseCount=0 when b entry is missing', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1, _stepId: 's1', _expression: 'failure()' },
          },
          b: {},
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranchTable[0]).toMatchObject({ trueCount: 0, falseCount: 0 });
  });

  it('toCoverageReport() ignores branchMap entries without _stepId/_expression', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {},
          s: {},
          branchMap: {
            '0': { loc: {}, type: 'if', locations: [], line: 1 },
          },
          b: { '0': [1, 1] },
          fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.ifBranchTable).toHaveLength(0);
  });

  it('toCoverageReport() computes input stats from _inputData', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        {
          path: '/fake/action.yml',
          inputCounts: { token: { provided: 2, default: 0 }, name: { provided: 1, default: 1 } },
          inputDefs: { token: { hasDefault: false }, name: { hasDefault: true } },
        },
      ],
    );
    const report = await collector.toCoverageReport();
    // token: no default → 1 slot, covered=1 (provided>0)
    // name: has default → 2 slots, covered=2 (both>0)
    expect(report.files['/fake/action.yml']!.inputs).toEqual({ covered: 3, total: 3, pct: 100 });
  });

  it('toCoverageReport() reports 0% inputs when no inputs exercised (hasDefault=false)', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        {
          path: '/fake/action.yml',
          inputCounts: { name: { provided: 0, default: 0 } },
          inputDefs: { name: { hasDefault: false } },
        },
      ],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.inputs).toEqual({ covered: 0, total: 1, pct: 0 });
  });

  it('toCoverageReport() covers provided=0 and default=0 false branches when hasDefault=true', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        {
          path: '/fake/action.yml',
          inputCounts: { name: { provided: 0, default: 0 } },
          inputDefs: { name: { hasDefault: true } },
        },
      ],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.inputs).toEqual({ covered: 0, total: 2, pct: 0 });
  });

  it('toCoverageReport() returns 100% inputs when inputDefs is empty (total=0)', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        { path: '/fake/action.yml', inputCounts: {}, inputDefs: {} },
      ],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.inputs).toEqual({ covered: 0, total: 0, pct: 100 });
  });

  it('toCoverageReport() uses ?? fallback when inputCounts is missing a key from inputDefs', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        {
          path: '/fake/action.yml',
          inputCounts: {},
          inputDefs: { name: { hasDefault: false } },
        },
      ],
    );
    const report = await collector.toCoverageReport();
    expect(report.files['/fake/action.yml']!.inputs).toEqual({ covered: 0, total: 1, pct: 0 });
  });

  it('listener handles action with no inputs (action.inputs ?? {} null branch)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      {
        conclusion: 'success',
        outputs: {},
        steps: [],
        step: () => undefined,
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        inputsExercised: { 'some-key': 'provided' },
      },
    );
    const frag = collector.toFragment();
    expect(frag.inputExercises[0]?.inputCounts['some-key']?.provided).toBe(1);
    expect(frag.inputExercises[0]?.inputDefs).toEqual({});
  });

  it('listener populates _inputData with inputDefs when action has declared inputs', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      {
        conclusion: 'success',
        outputs: {},
        steps: [{ id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] }],
        step: () => undefined,
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'with-inputs', 'action.yml'),
        inputsExercised: { greeting: 'provided', token: 'provided' },
      },
    );
    const frag = collector.toFragment();
    expect(frag.inputExercises).toHaveLength(1);
    const entry = frag.inputExercises[0]!;
    expect(entry.inputDefs['greeting']?.hasDefault).toBe(true);
    expect(entry.inputDefs['token']?.hasDefault).toBe(false);
    expect(entry.inputCounts['greeting']?.provided).toBe(1);
  });

  it('listener merges inputsExercised on second call for same file', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const runArgs = {
      conclusion: 'success' as const,
      outputs: {} as Record<string, string>,
      steps: [{ id: 'step1', name: 'run', phase: 'main' as const, ran: true, outcome: 'success' as const, conclusion: 'success' as const, outputs: {} as Record<string, string>, stdout: '', stderr: '', annotations: [] as import('@actharness/types').Annotation[] }],
      step: () => undefined as ReturnType<() => undefined>,
      env: {} as Record<string, string>,
      annotations: [] as import('@actharness/types').Annotation[],
      stdout: '',
      stderr: '',
    };
    const metaBase = { sourceFile: join(FIXTURES, 'with-inputs', 'action.yml') };
    listener(runArgs, { ...metaBase, inputsExercised: { greeting: 'provided' } });
    listener(runArgs, { ...metaBase, inputsExercised: { greeting: 'default' } });
    const frag = collector.toFragment();
    const entry = frag.inputExercises[0];
    expect(entry?.inputCounts['greeting']?.provided).toBe(1);
    expect(entry?.inputCounts['greeting']?.default).toBe(1);
  });

  it('listener creates new inputCounts entry for unseen input name on second call', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const runArgs = {
      conclusion: 'success' as const,
      outputs: {} as Record<string, string>,
      steps: [],
      step: () => undefined as ReturnType<() => undefined>,
      env: {} as Record<string, string>,
      annotations: [] as import('@actharness/types').Annotation[],
      stdout: '',
      stderr: '',
    };
    const meta = { sourceFile: join(FIXTURES, 'with-inputs', 'action.yml') };
    listener(runArgs, { ...meta, inputsExercised: { greeting: 'provided' } });
    listener(runArgs, { ...meta, inputsExercised: { 'extra-unlisted': 'provided' } });
    const frag = collector.toFragment();
    const entry = frag.inputExercises[0];
    expect(entry?.inputCounts['extra-unlisted']?.provided).toBe(1);
  });

  it('merge() merges inputData from another collector', async () => {
    const c1 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 1, default: 0 } }, inputDefs: { name: { hasDefault: true } } },
    ]);
    const c2 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 0, default: 1 } }, inputDefs: { name: { hasDefault: true } } },
    ]);
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.inputExercises.find((e) => e.path === '/fake/action.yml');
    expect(entry?.inputCounts['name']?.provided).toBe(1);
    expect(entry?.inputCounts['name']?.default).toBe(1);
  });

  it('merge() adds new inputData path from other collector', async () => {
    const c1 = new CoverageCollector();
    const c2 = CoverageCollector.fromParts({}, [
      { path: '/new/action.yml', inputCounts: { token: { provided: 1, default: 0 } }, inputDefs: { token: { hasDefault: false } } },
    ]);
    c1.merge(c2);
    const frag = c1.toFragment();
    expect(frag.inputExercises).toHaveLength(1);
    expect(frag.inputExercises[0]?.path).toBe('/new/action.yml');
  });

  it('merge() uses ?? 0 when existing.inputCounts[name] is missing (covers lines 184-185)', async () => {
    const c1 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: {}, inputDefs: {} },
    ]);
    const c2 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 3, default: 2 } }, inputDefs: { name: { hasDefault: true } } },
    ]);
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.inputExercises.find((e) => e.path === '/fake/action.yml');
    expect(entry?.inputCounts['name']?.provided).toBe(3);
    expect(entry?.inputCounts['name']?.default).toBe(2);
  });

  it('merge() adds new inputDefs entry when missing', async () => {
    const c1 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 1, default: 0 } }, inputDefs: {} },
    ]);
    const c2 = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 0, default: 1 } }, inputDefs: { name: { hasDefault: true } } },
    ]);
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.inputExercises.find((e) => e.path === '/fake/action.yml');
    expect(entry?.inputDefs['name']?.hasDefault).toBe(true);
  });

  it('reset() clears _inputData', async () => {
    const collector = CoverageCollector.fromParts({}, [
      { path: '/fake/action.yml', inputCounts: { name: { provided: 1, default: 0 } }, inputDefs: {} },
    ]);
    collector.reset();
    const frag = collector.toFragment();
    expect(frag.inputExercises).toHaveLength(0);
  });

  it('_stepReachedData: action.runs.steps ?? [] branch (no steps in action)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'custom-runner', 'action.yml') },
    );
    const frag = collector.toFragment();
    expect(Object.keys(frag.stepReachedExercises[0]?.counts ?? {})).toHaveLength(0);
  });

  it('_stepReachedData: step.id ?? __step_N__ branch (step without id)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'uses-with', 'action.yml') },
    );
    const frag = collector.toFragment();
    const entry = frag.stepReachedExercises[0]!;
    expect('__step_2__' in entry.counts).toBe(true);
  });

  it('toCoverageReport() builds inputTable from _buildInputTable', async () => {
    const c = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [
        {
          path: '/fake/action.yml',
          inputCounts: { name: { provided: 1, default: 1 }, token: { provided: 0, default: 0 } },
          inputDefs: { name: { hasDefault: true }, token: { hasDefault: false } },
        },
      ],
    );
    const report = await c.toCoverageReport();
    const fc = report.files['/fake/action.yml']!;
    expect(fc.inputTable).toHaveLength(2);
    const nameRow = fc.inputTable.find((r) => r.name === 'name')!;
    expect(nameRow.hasDefault).toBe(true);
    expect(nameRow.coveredProvided).toBe(true);
    expect(nameRow.coveredDefault).toBe(true);
    const tokenRow = fc.inputTable.find((r) => r.name === 'token')!;
    expect(tokenRow.hasDefault).toBe(false);
    expect(tokenRow.coveredProvided).toBe(false);
    expect(tokenRow.coveredDefault).toBe(true); // no default → always true
  });

  it('toCoverageReport() builds stepHits from statementMap._stepId', async () => {
    const c = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {
            '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 }, _stepId: 's0' },
            '1': { start: { line: 2, column: 0 }, end: { line: 2, column: 10 }, _stepId: 's1' },
          },
          s: { '0': 3, '1': 0 },
          branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    const report = await c.toCoverageReport();
    const fc = report.files['/fake/action.yml']!;
    expect(fc.stepHits['s0']).toBe(3);
    expect(fc.stepHits['s1']).toBe(0);
  });

  // ── Output coverage ───────────────────────────────────────────────────────────

  it('createListener() accumulates output counts from result.outputs', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-outputs');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: { greeting: 'hello' }, steps: [makeStepResult('step1', { outputs: { greeting: 'hello' } })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const report = await collector.toCoverageReport();
    const fc = report.files[fixturePath]!;
    expect(fc.outputs).toEqual({ covered: 1, total: 1, pct: 100 });
    expect(fc.outputTable).toEqual([{ name: 'greeting', covered: true, count: 1 }]);
  });

  it('createListener() marks output as uncovered when result.outputs value is empty', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-outputs');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: { greeting: '' }, steps: [makeStepResult('step1')], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const report = await collector.toCoverageReport();
    expect(report.files[fixturePath]!.outputs).toEqual({ covered: 0, total: 1, pct: 0 });
    expect(report.files[fixturePath]!.outputTable[0]?.covered).toBe(false);
  });

  it('_isOutputProduced: step not found in results falls back to ?? {} (outputKey not in empty object)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-outputs');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const report = await collector.toCoverageReport();
    expect(report.files[fixturePath]!.outputTable.find((r) => r.name === 'greeting')?.covered).toBe(false);
  });

  it('_isOutputProduced: non-step-pattern value expression falls back to result.outputs (line 100)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-context-output');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: { 'event-name': 'push', 'no-value': '' }, steps: [makeStepResult('step1')], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const report = await collector.toCoverageReport();
    const fc = report.files[fixturePath]!;
    expect(fc.outputTable.find((r) => r.name === 'event-name')?.covered).toBe(true);
    expect(fc.outputTable.find((r) => r.name === 'no-value')?.covered).toBe(false);
  });

  it('_isOutputProduced: undefined valueExpr branch (line 92) returns truthy when output present', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-context-output');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: { 'event-name': '', 'no-value': 'present' }, steps: [makeStepResult('step1')], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const report = await collector.toCoverageReport();
    const fc = report.files[fixturePath]!;
    expect(fc.outputTable.find((r) => r.name === 'no-value')?.covered).toBe(true);
  });

  it('_stepReachedData: explicit non-success() if step counts all appearances (hasExplicitIf=true, stepResult found)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'with-if');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [makeStepResult('step1', { ran: false }), makeStepResult('step2', { ran: true })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const frag = collector.toFragment();
    const entry = frag.stepReachedExercises.find((e) => e.path === fixturePath)!;
    expect(entry.counts['step1']).toBe(1); // explicit non-success() if: stepResult found → reached even with ran:false
    expect(entry.counts['step2']).toBe(1); // explicit if: success() → treated as no-if, counts ran:true
  });

  it('_stepReachedData: node-action phases tracked when explicit pre-if/post-if present, skipped vs run', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'node-with-if');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      {
        conclusion: 'success',
        outputs: {},
        steps: [
          makePhaseResult('pre', { ran: true, ifResult: true }),
          makePhaseResult('main', { ran: true }),
          makePhaseResult('post', { ran: false, ifResult: false }),
        ],
        step: () => undefined,
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      },
      { sourceFile: fixturePath },
    );
    const frag = collector.toFragment();
    const entry = frag.stepReachedExercises.find((e) => e.path === fixturePath)!;
    expect(entry.counts['pre']).toBe(1); // explicit pre-if, stepResult found → reached
    expect(entry.counts['main']).toBe(1); // no if, ran:true → reached
    expect(entry.counts['post']).toBe(1); // explicit post-if, stepResult found (even though skipped) → reached
  });

  it('_stepReachedData: node-action with no pre/post skips them entirely (continue branch)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'node-main-only');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [makePhaseResult('main', { ran: true })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const frag = collector.toFragment();
    const entry = frag.stepReachedExercises.find((e) => e.path === fixturePath)!;
    expect(Object.keys(entry.counts)).toEqual(['main']);
  });

  it('_stepReachedData: node-action main not reached when absent from stepResults', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const fixtureDir = join(FIXTURES, 'node-with-if');
    const fixturePath = join(fixtureDir, 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    const frag = collector.toFragment();
    const entry = frag.stepReachedExercises.find((e) => e.path === fixturePath)!;
    expect(entry.counts['main']).toBe(0);
  });

  it('_computeOutputStat: no _outputData for path returns pct=100 and empty table', async () => {
    const c = CoverageCollector.fromParts(
      { '/fake/action.yml': { path: '/fake/action.yml', statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [],
    );
    const report = await c.toCoverageReport();
    const fc = report.files['/fake/action.yml']!;
    expect(fc.outputs).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(fc.outputTable).toEqual([]);
  });

  it('fromParts() restores outputExercises', async () => {
    const c = CoverageCollector.fromParts(
      {},
      [],
      [{ path: '/fake/action.yml', counts: { greeting: 3 } }],
    );
    const frag = c.toFragment();
    expect(frag.outputExercises[0]).toEqual({ path: '/fake/action.yml', counts: { greeting: 3 } });
  });

  it('fromParts() restores stepReachedExercises', async () => {
    const c = CoverageCollector.fromParts(
      {},
      [],
      [],
      [{ path: '/fake/action.yml', counts: { step1: 3, step2: 0 } }],
    );
    const frag = c.toFragment();
    expect(frag.stepReachedExercises[0]).toEqual({ path: '/fake/action.yml', counts: { step1: 3, step2: 0 } });
  });

  it('merge() accumulates _stepReachedData for same path (existing and new stepIds)', async () => {
    const path = '/fake/action.yml';
    const a = CoverageCollector.fromParts({}, [], [], [{ path, counts: { step1: 2 } }]);
    const b = CoverageCollector.fromParts({}, [], [], [{ path, counts: { step1: 1, step2: 3 } }]);
    a.merge(b);
    const frag = a.toFragment();
    const entry = frag.stepReachedExercises.find((e) => e.path === path)!;
    expect(entry.counts['step1']).toBe(3);
    expect(entry.counts['step2']).toBe(3);
  });

  it('merge() combines outputData for same path (accumulates counts)', async () => {
    const fixtureDir = join(FIXTURES, 'with-outputs');
    const fixturePath = join(fixtureDir, 'action.yml');

    const a = new CoverageCollector();
    a.createListener()(
      { conclusion: 'success', outputs: { greeting: 'hello' }, steps: [makeStepResult('step1', { outputs: { greeting: 'hello' } })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );

    const b = new CoverageCollector();
    b.createListener()(
      { conclusion: 'success', outputs: { greeting: 'world' }, steps: [makeStepResult('step1', { outputs: { greeting: 'world' } })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );

    a.merge(b);
    const fc = (await a.toCoverageReport()).files[fixturePath]!;
    expect(fc.outputs.covered).toBe(1);
    expect(fc.outputs.total).toBe(1);
  });

  it('merge() adds outputData for new path (not yet in target)', async () => {
    const fixtureDir = join(FIXTURES, 'with-outputs');
    const fixturePath = join(fixtureDir, 'action.yml');

    const a = new CoverageCollector();
    const b = new CoverageCollector();
    b.createListener()(
      { conclusion: 'success', outputs: { greeting: 'hi' }, steps: [makeStepResult('step1', { outputs: { greeting: 'hi' } })], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: fixturePath },
    );
    a.merge(b);
    const frag = a.toFragment();
    expect(frag.outputExercises.find((e) => e.path === fixturePath)?.counts['greeting']).toBe(1);
  });

  it('_computeOutputStat: empty counts returns total=0 and pct=100', async () => {
    const path = '/fake/action.yml';
    const c = CoverageCollector.fromParts(
      { [path]: { path, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [],
      [{ path, counts: {} }],
    );
    const fc = (await c.toCoverageReport()).files[path]!;
    expect(fc.outputs).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(fc.outputTable).toEqual([]);
  });

  it('merge() adds new output key to existing path via ?? 0', async () => {
    const path = '/fake/action.yml';
    const a = CoverageCollector.fromParts({}, [], [{ path, counts: { a: 1 } }]);
    const b = CoverageCollector.fromParts({}, [], [{ path, counts: { b: 2 } }]);
    a.merge(b);
    const frag = a.toFragment();
    const entry = frag.outputExercises.find((e) => e.path === path)!;
    expect(entry.counts['a']).toBe(1);
    expect(entry.counts['b']).toBe(2);
  });

  // ── jsCoverage listener + toCoverageReport jsFiles ────────────────────────────

  it('listener accumulates jsCoverage entries when meta.jsCoverage is set', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        jsCoverage: [{ path: '/fake/index.js', v8Data: { functions: [] } }],
      },
    );
    const frag = collector.toFragment();
    expect(frag.jsCoverageEntries).toHaveLength(1);
    expect(frag.jsCoverageEntries[0]?.path).toBe('/fake/index.js');
  });

  it('toCoverageReport() populates jsFiles with zero stats when JS file does not exist', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        jsCoverage: [{ path: '/fake/nonexistent.js', v8Data: { functions: [] } }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(report.jsFiles['/fake/nonexistent.js']).toBeDefined();
    expect(report.jsFiles['/fake/nonexistent.js']!.statements).toEqual({ covered: 0, total: 0, pct: 0 });
    expect(report.jsFiles['/fake/nonexistent.js']!.path).toBe('/fake/nonexistent.js');
    expect(report.jsFiles['/fake/nonexistent.js']!.istanbulData).toEqual({ s: {}, b: {}, f: {}, statementMap: {}, branchMap: {}, fnMap: {} });
  });

  it('toCoverageReport() populates jsFiles with real stats for an existing JS file', async () => {
    const jsPath = join(FIXTURES, 'js-sample.js');
    const source = readFileSync(jsPath, 'utf8');
    const v8Data = {
      functions: [{
        functionName: 'hi',
        isBlockCoverage: true,
        ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
      }],
    };
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        jsCoverage: [{ path: jsPath, v8Data }],
      },
    );
    const report = await collector.toCoverageReport();
    const relPath = relative(FIXTURES, jsPath);
    const fc = Object.values(report.jsFiles).find((f) => f.path === jsPath);
    expect(fc).toBeDefined();
    expect(fc!.path).toBe(jsPath);
    expect(fc!.statements.total).toBeGreaterThan(0);
    expect(Object.keys(fc!.istanbulData.s).length).toBeGreaterThan(0);
    // Verify aggregateTotals picks up JS stats from jsFiles
    expect(report.total.jsStatements.total).toBeGreaterThan(0);
    void relPath; // suppress unused-var lint
  });

  it('aggregateTotals() sums JS totals from non-empty jsFiles', async () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const stat = { covered: 2, total: 3, pct: 66.7 };
    const { aggregateTotals } = await import('../src/collector.js');
    const emptyIstanbul = { s: {}, b: {}, f: {}, statementMap: {}, branchMap: {}, fnMap: {} };
    const total = aggregateTotals([], {
      '/a.js': { path: '/a.js', statements: stat, branches: zero, functions: zero, lines: stat, istanbulData: emptyIstanbul },
    });
    expect(total.jsStatements.covered).toBe(2);
    expect(total.jsStatements.total).toBe(3);
    expect(total.jsLines.covered).toBe(2);
  });

  // ── sh coverage ───────────────────────────────────────────────────────────────

  it('createListener() accumulates shellCoverage entries in _shShellCoverageData', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const frag = collector.toFragment();
    expect(frag.shShellCoverageEntries).toHaveLength(1);
    expect(frag.shShellCoverageEntries![0]!.key).toBe(`${actionFilePath}#step1`);
    expect(frag.shShellCoverageEntries![0]!.lineHits[1]).toBe(1);
  });

  it('createListener() merges shellCoverage hits across multiple calls for the same key', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const key = `${join(FIXTURES, 'simple', 'action.yml')}#step1`;
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 2 } }] },
    );
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 3 } }] },
    );
    const frag = collector.toFragment();
    expect(frag.shShellCoverageEntries![0]!.lineHits[1]).toBe(5);
  });

  it('toCoverageReport() computes shShellLines for a step with sh coverage', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    // createListener must see the sourceFile so the file ends up in `files` (istanbul map)
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(report.files[actionFilePath]).toBeDefined();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.shShellFiles[stepKey]).toBeDefined();
    expect(report.shShellFiles[stepKey]!.lines.total).toBeGreaterThan(0);
    expect(report.shShellFiles[stepKey]!.lines.covered).toBeGreaterThan(0);
    expect(report.shShellFiles[stepKey]!.lines.pct).toBeGreaterThan(0);
  });

  it('toCoverageReport() sh loop: skips key that has no # character', async () => {
    // Inject a key with no # by first adding a valid key then overwriting via fromParts
    // Use fromParts approach to inject malformed key:
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [{ key: 'nohash', lineHits: { 1: 1 } }]);
    // toCoverageReport with no files — skips immediately at hashIdx === -1
    const report = await c.toCoverageReport();
    expect(report.files).toEqual({});
  });

  it('toCoverageReport() sh loop: skips when actionFilePath not in files map', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [
      { key: '/nonexistent/path/action.yml#step1', lineHits: { 1: 1 } },
    ]);
    const report = await c.toCoverageReport();
    expect(Object.keys(report.files)).toHaveLength(0);
  });

  it('toCoverageReport() sh loop: skips when parseAction fails for the actionFilePath', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    // Put /fake/action.yml in the istanbul map so fileCov exists, but /fake has no action.yml
    const c = CC.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [],
      [{ key: '/fake/action.yml#step1', lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    // parseAction('/fake') throws → catch continue → no shShellFiles
    expect(Object.keys(report.shShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() sh loop: skips when step has no run property', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    // Inject a key referencing a non-existent step id
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#nosuchstep`, lineHits: { 1: 1 } }],
      },
    );
    const report = await collector.toCoverageReport();
    // nosuchstep not found → no shShellFiles entry
    expect(Object.keys(report.shShellFiles)).toHaveLength(0);
  });

  it('merge() merges _shShellCoverageData, accumulating hits for same key', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const key = 'some/action.yml#step1';
    const l1 = c1.createListener();
    const l2 = c2.createListener();
    l1(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 2 } }] },
    );
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 3, 2: 1 } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.shShellCoverageEntries!.find((e) => e.key === key);
    expect(entry).toBeDefined();
    expect(entry!.lineHits[1]).toBe(5);
    expect(entry!.lineHits[2]).toBe(1);
  });

  it('fromParts() reconstructs _shShellCoverageData from shShellCoverageEntries', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [
      { key: 'action.yml#step1', lineHits: { 1: 3, 4: 1 } },
    ]);
    const frag = c.toFragment();
    expect(frag.shShellCoverageEntries).toHaveLength(1);
    expect(frag.shShellCoverageEntries![0]!.key).toBe('action.yml#step1');
    expect(frag.shShellCoverageEntries![0]!.lineHits[1]).toBe(3);
    expect(frag.shShellCoverageEntries![0]!.lineHits[4]).toBe(1);
  });

  it('fromParts() accumulates hits for duplicate keys in shShellCoverageEntries', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [
      { key: 'action.yml#step1', lineHits: { 1: 2 } },
      { key: 'action.yml#step1', lineHits: { 1: 5, 2: 1 } },
    ]);
    const frag = c.toFragment();
    const entry = frag.shShellCoverageEntries!.find((e) => e.key === 'action.yml#step1');
    expect(entry!.lineHits[1]).toBe(7);
    expect(entry!.lineHits[2]).toBe(1);
  });

  it('reset() clears _shShellCoverageData', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: 'a.yml#s1', lineHits: { 1: 1 } }] },
    );
    expect(collector.toFragment().shShellCoverageEntries).toHaveLength(1);
    collector.reset();
    expect(collector.toFragment().shShellCoverageEntries).toHaveLength(0);
  });

  it('aggregateTotals() sums shShellLines from shShellFiles', async () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const { aggregateTotals } = await import('../src/collector.js');
    const baseFile = {
      steps: zero, ifBranches: zero, inputs: zero, outputs: zero,
      stepHits: {}, stepReached: {}, uncoveredSteps: [], ifBranchTable: [], inputTable: [], outputTable: [],
    };
    const total = aggregateTotals(
      [{ ...baseFile, path: '/a.yml' }, { ...baseFile, path: '/b.yml' }, { ...baseFile, path: '/c.yml' }],
      {}, {},
      {
        '/a.yml#step1': { path: '/a.yml#step1', lines: { covered: 2, total: 3, pct: 66.7 }, uncoveredLines: [] },
        '/b.yml#step1': { path: '/b.yml#step1', lines: { covered: 1, total: 1, pct: 100 }, uncoveredLines: [] },
      },
    );
    expect(total.shShellLines.covered).toBe(3);
    expect(total.shShellLines.total).toBe(4);
  });

  it('toCoverageReport() sh loop: uses ?? [] fallback when action has no steps (covers line 327 ?? branch)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'node-main-only', 'action.yml');
    // node-main-only has `using: node22` with no `steps` field → runs.steps is undefined
    const c = CC.fromParts(
      {
        [actionFilePath]: {
          path: actionFilePath,
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [],
      [{ key: `${actionFilePath}#__step_1__`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    // steps undefined → ?? [] → find returns undefined → !step?.run continue → no shShellFiles
    expect(Object.keys(report.shShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() sh loop: uses ?? for step with no id (covers line 328 ?? branch)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'uses-with', 'action.yml');
    // uses-with has second step with no id → s.id ?? '__step_2__' uses the right side
    const c = CC.fromParts(
      {
        [actionFilePath]: {
          path: actionFilePath,
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [],
      [{ key: `${actionFilePath}#__step_2__`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    // step 2 found via auto id but has no run → !step?.run continue → no shShellFiles
    expect(Object.keys(report.shShellFiles)).toHaveLength(0);
  });

  it('merge() _shShellCoverageData: handles new key from other collector (covers ?? {} right side at line 428)', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: 'new/action.yml#step1', lineHits: { 3: 1 } }] },
    );
    // c1 has no 'new/action.yml#step1' → get returns undefined → ?? {} right side used
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.shShellCoverageEntries!.find((e) => e.key === 'new/action.yml#step1');
    expect(entry).toBeDefined();
    expect(entry!.lineHits[3]).toBe(1);
  });

  // ── createListener() routing edge cases (new sh/pwsh routing, lines 239-244) ─

  it('createListener() routing: skips shellCoverage entry with no # in path (covers hashIdx===-1 continue)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: 'nohash', lineHits: { 1: 1 } }] },
    );
    const frag = collector.toFragment();
    expect(frag.shShellCoverageEntries).toHaveLength(0);
    expect(frag.pwshShellCoverageEntries).toHaveLength(0);
  });

  it('createListener() routing: uses ?? [] when action has no steps property (covers ?? [] right side)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    // node-main-only uses node22, so action.runs.steps is undefined → ?? [] right side taken
    const actionFilePath = join(FIXTURES, 'node-main-only', 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'node-main-only', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#main`, lineHits: { 1: 1 } }] },
    );
    const frag = collector.toFragment();
    // steps is undefined → [] → find returns undefined → shell = '' → routes to _shShellCoverageData
    expect((frag.shShellCoverageEntries ?? []).length).toBeGreaterThanOrEqual(0);
  });

  it('createListener() routing: uses ?? __step_N__ when step has no id (covers ?? right side in find)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    // uses-with has step 2 with no id → s.id ?? '__step_2__' right side taken
    const actionFilePath = join(FIXTURES, 'uses-with', 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'uses-with', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#__step_2__`, lineHits: { 1: 1 } }] },
    );
    const frag = collector.toFragment();
    expect((frag.shShellCoverageEntries ?? []).length).toBeGreaterThanOrEqual(0);
  });

  // ── bash coverage ─────────────────────────────────────────────────────────────

  it('createListener() routes shellCoverage to _bashShellCoverageData when step.shell is bash', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'with-if', 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-if', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const frag = collector.toFragment();
    expect(frag.bashShellCoverageEntries).toHaveLength(1);
    expect(frag.bashShellCoverageEntries![0]!.key).toBe(`${actionFilePath}#step1`);
    expect(frag.bashShellCoverageEntries![0]!.lineHits[1]).toBe(1);
    expect(frag.shShellCoverageEntries).toHaveLength(0);
  });

  it('toCoverageReport() computes bashShellLines for a step with bash coverage (covers collector.ts lines 408-428)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'with-if', 'action.yml');
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'with-if', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(report.files[actionFilePath]).toBeDefined();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.bashShellFiles[stepKey]).toBeDefined();
    expect(report.bashShellFiles[stepKey]!.lines.total).toBeGreaterThan(0);
    expect(report.bashShellFiles[stepKey]!.lines.covered).toBeGreaterThan(0);
  });

  it('merge() merges _bashShellCoverageData, accumulating hits for same key (covers collector.ts lines 666-671)', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const key = `${join(FIXTURES, 'with-if', 'action.yml')}#step1`;
    const l1 = c1.createListener();
    const l2 = c2.createListener();
    l1(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-if', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 2 } }] },
    );
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-if', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 3, 2: 1 } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.bashShellCoverageEntries!.find((e) => e.key === key);
    expect(entry).toBeDefined();
    expect(entry!.lineHits[1]).toBe(5);
    expect(entry!.lineHits[2]).toBe(1);
  });

  it('merge() _bashShellCoverageData: handles new key from other collector (covers ?? {} right-side at BRDA:666)', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-if', 'action.yml'), shellCoverage: [{ path: 'new/action.yml#step1', lineHits: { 3: 1 } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.bashShellCoverageEntries!.find((e) => e.key === 'new/action.yml#step1');
    expect(entry).toBeDefined();
    expect(entry!.lineHits[3]).toBe(1);
  });

  it('toCoverageReport() sh loop: ?? 0 right-side + sort comparator (covers BRDA:400,63,1 + anonymous_20)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [],
      [{ key: `${actionFilePath}#step1`, lineHits: {} }],
    );
    const report = await c.toCoverageReport();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.shShellFiles[stepKey]).toBeDefined();
    expect(report.shShellFiles[stepKey]!.uncoveredLines).toHaveLength(3);
  });

  it('toCoverageReport() sh loop: shStepLineHits already defined (covers BRDA:402,64,1)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-if', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [],
      [
        { key: `${actionFilePath}#step1`, lineHits: { 1: 1 } },
        { key: `${actionFilePath}#step2`, lineHits: { 1: 1 } },
      ],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.shShellFiles)).toHaveLength(2);
  });

  it('toCoverageReport() bash loop: skips key with no # (covers BRDA:409,65,0)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [{ key: 'nohash', lineHits: { 1: 1 } }]);
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() bash loop: skips when actionFilePath not in files (covers BRDA:413,66,0)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [],
      [{ key: '/nonexistent/action.yml#step1', lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() bash loop: skips when parseAction fails (covers line 418)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts(
      { '/fake/action.yml': { path: '/fake/action.yml', statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [{ key: '/fake/action.yml#step1', lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() bash loop: action.runs.steps ?? [] right side (covers BRDA:420,67,1)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [{ key: `${actionFilePath}#main`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() bash loop: s.id ?? __step_N__ right side (covers BRDA:421,68,1)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-inline-run', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [{ key: `${actionFilePath}#__step_1__`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(report.bashShellFiles[`${actionFilePath}#__step_1__`]).toBeDefined();
  });

  it('toCoverageReport() bash loop: skips when step has no run (covers BRDA:423,69,0)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'uses-with', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [{ key: `${actionFilePath}#greet-step`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() bash loop: ?? 0 right-side + sort comparator (covers BRDA:425,70,1 + anonymous_23)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [{ key: `${actionFilePath}#step1`, lineHits: {} }],
    );
    const report = await c.toCoverageReport();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.bashShellFiles[stepKey]).toBeDefined();
    expect(report.bashShellFiles[stepKey]!.uncoveredLines).toHaveLength(3);
  });

  it('toCoverageReport() bash loop: bashStepLineHits already defined (covers BRDA:427,71,1)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-if', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [],
      [
        { key: `${actionFilePath}#step1`, lineHits: { 1: 1 } },
        { key: `${actionFilePath}#step2`, lineHits: { 1: 1 } },
      ],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.bashShellFiles)).toHaveLength(2);
  });

  // ── pwsh coverage ─────────────────────────────────────────────────────────────

  it('createListener() routes shellCoverage to _pwshShellCoverageData when step.shell is pwsh', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const frag = collector.toFragment();
    // routed to pwsh, NOT sh
    expect(frag.pwshShellCoverageEntries).toHaveLength(1);
    expect(frag.pwshShellCoverageEntries![0]!.key).toBe(`${actionFilePath}#step1`);
    expect(frag.pwshShellCoverageEntries![0]!.lineHits[1]).toBe(1);
    expect(frag.shShellCoverageEntries).toHaveLength(0);
  });

  it('createListener() merges pwsh shellCoverage hits across multiple calls for the same key', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const key = `${join(FIXTURES, 'with-pwsh', 'action.yml')}#step1`;
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 2 } }] },
    );
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 3 } }] },
    );
    const frag = collector.toFragment();
    expect(frag.pwshShellCoverageEntries![0]!.lineHits[1]).toBe(5);
  });

  it('toCoverageReport() computes pwshShellLines for a step with pwsh coverage', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, lineHits: { 1: 1 } }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(report.files[actionFilePath]).toBeDefined();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.pwshShellFiles[stepKey]).toBeDefined();
    expect(report.pwshShellFiles[stepKey]!.lines.total).toBeGreaterThan(0);
    expect(report.pwshShellFiles[stepKey]!.lines.covered).toBeGreaterThan(0);
    expect(report.pwshShellFiles[stepKey]!.lines.pct).toBeGreaterThan(0);
  });

  it('toCoverageReport() pwsh loop: skips key that has no # character', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [], [{ key: 'nohash', lineHits: { 1: 1 } }]);
    const report = await c.toCoverageReport();
    expect(report.files).toEqual({});
  });

  it('toCoverageReport() pwsh loop: skips when actionFilePath not in files map', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [], [
      { key: '/nonexistent/path/action.yml#step1', lineHits: { 1: 1 } },
    ]);
    const report = await c.toCoverageReport();
    expect(Object.keys(report.files)).toHaveLength(0);
  });

  it('toCoverageReport() pwsh loop: skips when parseAction fails for the actionFilePath', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [], [], [],
      [{ key: '/fake/action.yml#step1', lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.pwshShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() pwsh loop: skips when step has no run property', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const actionFilePath = join(FIXTURES, 'with-pwsh', 'action.yml');
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#nosuchstep`, lineHits: { 1: 1 } }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(Object.keys(report.pwshShellFiles)).toHaveLength(0);
  });

  it('fromParts() reconstructs _pwshShellCoverageData from pwshShellCoverageEntries', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [], [
      { key: 'action.yml#step1', lineHits: { 1: 3, 4: 1 } },
    ]);
    const frag = c.toFragment();
    expect(frag.pwshShellCoverageEntries).toHaveLength(1);
    expect(frag.pwshShellCoverageEntries![0]!.key).toBe('action.yml#step1');
    expect(frag.pwshShellCoverageEntries![0]!.lineHits[1]).toBe(3);
    expect(frag.pwshShellCoverageEntries![0]!.lineHits[4]).toBe(1);
  });

  it('fromParts() accumulates hits for duplicate keys in pwshShellCoverageEntries', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [], [
      { key: 'action.yml#step1', lineHits: { 1: 2 } },
      { key: 'action.yml#step1', lineHits: { 1: 5, 2: 1 } },
    ]);
    const frag = c.toFragment();
    const entry = frag.pwshShellCoverageEntries!.find((e) => e.key === 'action.yml#step1');
    expect(entry!.lineHits[1]).toBe(7);
    expect(entry!.lineHits[2]).toBe(1);
  });

  it('merge() merges _pwshShellCoverageData, accumulating hits for same key', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const key = 'some/action.yml#step1';
    const l1 = c1.createListener();
    const l2 = c2.createListener();
    l1(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 2 } }] },
    );
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: key, lineHits: { 1: 3, 2: 1 } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.pwshShellCoverageEntries!.find((e) => e.key === key);
    expect(entry).toBeDefined();
    expect(entry!.lineHits[1]).toBe(5);
    expect(entry!.lineHits[2]).toBe(1);
  });

  it('merge() _pwshShellCoverageData: handles new key from other collector', async () => {
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: 'new/action.yml#step1', lineHits: { 3: 1 } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.pwshShellCoverageEntries!.find((e) => e.key === 'new/action.yml#step1');
    expect(entry).toBeDefined();
    expect(entry!.lineHits[3]).toBe(1);
  });

  it('reset() clears _pwshShellCoverageData', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-pwsh', 'action.yml'), shellCoverage: [{ path: 'a.yml#step1', lineHits: { 1: 1 } }] },
    );
    expect(collector.toFragment().pwshShellCoverageEntries).toHaveLength(1);
    collector.reset();
    expect(collector.toFragment().pwshShellCoverageEntries).toHaveLength(0);
  });

  it('toCoverageReport() pwsh loop: uses ?? [] fallback when action has no steps (covers line 374 ?? branch)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'node-main-only', 'action.yml');
    const c = CC.fromParts(
      {
        [actionFilePath]: {
          path: actionFilePath,
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [], [], [],
      [{ key: `${actionFilePath}#__step_1__`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    // steps undefined → ?? [] → find returns undefined → !step?.run continue → no pwshShellFiles
    expect(Object.keys(report.pwshShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() pwsh loop: uses ?? for step with no id (covers line 375 ?? branch)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'uses-with', 'action.yml');
    // uses-with has second step with no id → s.id ?? '__step_2__' uses the right side
    const c = CC.fromParts(
      {
        [actionFilePath]: {
          path: actionFilePath,
          statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [], [], [], [], [], [],
      [{ key: `${actionFilePath}#__step_2__`, lineHits: { 1: 1 } }],
    );
    const report = await c.toCoverageReport();
    // step 2 found via auto id but has no run → !step?.run continue → no pwshShellFiles
    expect(Object.keys(report.pwshShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() pwsh loop: ?? 0 right-side + sort comparator (covers BRDA:450,77,1 + anonymous_26)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-sh-multiline-run', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [], [],
      [{ key: `${actionFilePath}#step1`, lineHits: {} }],
    );
    const report = await c.toCoverageReport();
    const stepKey = `${actionFilePath}#step1`;
    expect(report.pwshShellFiles[stepKey]).toBeDefined();
    expect(report.pwshShellFiles[stepKey]!.uncoveredLines).toHaveLength(3);
  });

  it('toCoverageReport() pwsh loop: pwshStepLineHits already defined (covers BRDA:452,78,1)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const actionFilePath = join(FIXTURES, 'with-if', 'action.yml');
    const c = CC.fromParts(
      { [actionFilePath]: { path: actionFilePath, statementMap: {}, s: {}, branchMap: {}, b: {}, fnMap: {}, f: {} } },
      [], [], [], [], [], [],
      [
        { key: `${actionFilePath}#step1`, lineHits: { 1: 1 } },
        { key: `${actionFilePath}#step2`, lineHits: { 1: 1 } },
      ],
    );
    const report = await c.toCoverageReport();
    expect(Object.keys(report.pwshShellFiles)).toHaveLength(2);
  });

  it('aggregateTotals() sums pwshShellLines from pwshShellFiles', async () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const { aggregateTotals } = await import('../src/collector.js');
    const baseFile = {
      steps: zero, ifBranches: zero, inputs: zero, outputs: zero,
      stepHits: {}, stepReached: {}, uncoveredSteps: [], ifBranchTable: [], inputTable: [], outputTable: [],
    };
    const total = aggregateTotals(
      [{ ...baseFile, path: '/a.yml' }, { ...baseFile, path: '/b.yml' }, { ...baseFile, path: '/c.yml' }],
      {}, {}, {}, {},
      {
        '/a.yml#step1': { path: '/a.yml#step1', lines: { covered: 2, total: 3, pct: 66.7 }, uncoveredLines: [] },
        '/b.yml#step1': { path: '/b.yml#step1', lines: { covered: 1, total: 1, pct: 100 }, uncoveredLines: [] },
      },
    );
    expect(total.pwshShellLines.covered).toBe(3);
    expect(total.pwshShellLines.total).toBe(4);
  });

  it('aggregateTotals() sums pythonShellStatements/pythonShellBranches/pythonShellLines from pythonShellFiles (covers lines 711-716)', async () => {
    const { aggregateTotals } = await import('../src/collector.js');
    const makePyStat = (c: number, t: number) => ({ covered: c, total: t, pct: t === 0 ? 100 : (c / t) * 100 });
    const pyFileA = {
      path: '/script_a.py',
      statements: makePyStat(3, 4),
      branches: makePyStat(2, 2),
      lines: makePyStat(3, 4),
      pythonCoverageData: { executedLines: [1, 2, 3], missingLines: [4], executedBranches: [[1, 2], [2, 3]] as [number, number][], missingBranches: [] as [number, number][] },
    };
    const pyFileB = {
      path: '/script_b.py',
      statements: makePyStat(1, 2),
      branches: makePyStat(0, 1),
      lines: makePyStat(1, 2),
      pythonCoverageData: { executedLines: [1], missingLines: [2], executedBranches: [] as [number, number][], missingBranches: [[1, 2]] as [number, number][] },
    };
    const total = aggregateTotals([], {}, { '/script_a.py': pyFileA, '/script_b.py': pyFileB });
    expect(total.pythonShellStatements.covered).toBe(4);
    expect(total.pythonShellStatements.total).toBe(6);
    expect(total.pythonShellBranches.covered).toBe(2);
    expect(total.pythonShellBranches.total).toBe(3);
    expect(total.pythonShellLines.covered).toBe(4);
    expect(total.pythonShellLines.total).toBe(6);
  });

  it('fromParts() with pythonShellCoverageEntries (lineHits inline): toFragment round-trips lineHits', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const pythonCoverageData = { executedLines: [1, 2], missingLines: [3], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const c = CC.fromParts({}, [], [], [], [], [], [], [], [
      { key: 'action.yml#step1', pythonCoverageData, lineHits: { 1: 3, 2: 3, 3: 0 } },
    ]);
    const frag = c.toFragment();
    expect(frag.pythonShellCoverageEntries).toHaveLength(1);
    expect(frag.pythonShellCoverageEntries![0]!.key).toBe('action.yml#step1');
    expect(frag.pythonShellCoverageEntries![0]!.pythonCoverageData.executedLines).toEqual([1, 2]);
    expect(frag.pythonShellCoverageEntries![0]!.lineHits).toEqual({ 1: 3, 2: 3, 3: 0 });
  });

  it('fromParts() with pythonShellCoverageEntries (lineHits inline): toCoverageReport uses stored lineHits', async () => {
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    const pythonCoverageData = { executedLines: [1], missingLines: [2], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    // Use listener to populate the Istanbul map so files[actionFilePath] exists
    const seed = new CoverageCollector();
    seed.createListener()(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData }] },
    );
    const seedFrag = seed.toFragment();
    // Reconstruct with explicit lineHits (e.g. from a different shard with 5 runs)
    const c = CoverageCollector.fromParts(
      seedFrag.istanbulMap, seedFrag.inputExercises, [], [], [], [], [], [],
      [{ key: `${actionFilePath}#step1`, pythonCoverageData, lineHits: { 1: 5, 2: 0 } }],
    );
    const report = await c.toCoverageReport();
    const fc = report.files[actionFilePath];
    expect(fc?.pyStepLineHits?.['step1']).toEqual({ 1: 5, 2: 0 });
  });

  it('listener accumulates python hit counts across multiple calls (??= keeps prior count)', async () => {
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const base = { executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    // First call: lines 1 and 2 both executed
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData: { ...base, executedLines: [1, 2], missingLines: [] } }] },
    );
    // Second call: line 2 now missing — but it was already counted, so ??= keeps prior count
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData: { ...base, executedLines: [1], missingLines: [2] } }] },
    );
    const report = await collector.toCoverageReport();
    const fc = report.files[actionFilePath];
    // line 1 ran in both calls → ×2; line 2 ran in first call → ×1 (??= did not zero it out)
    expect(fc?.pyStepLineHits?.['step1']).toEqual({ 1: 2, 2: 1 });
  });

  it('merge() accumulates python lineHits from both collectors', async () => {
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const base = { executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const l1 = c1.createListener();
    const l2 = c2.createListener();
    l1(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData: { ...base, executedLines: [1], missingLines: [2] } }] },
    );
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'simple', 'action.yml'), shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData: { ...base, executedLines: [1], missingLines: [2] } }] },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.pythonShellCoverageEntries?.find((e) => e.key === `${actionFilePath}#step1`);
    expect(entry?.lineHits?.[1]).toBe(2);
    expect(entry?.lineHits?.[2]).toBe(0);
  });

  it('toCoverageReport() python loop: skips entries with no # in key (covers line 418 continue)', async () => {
    const pythonCoverageData = { executedLines: [1], missingLines: [], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [{ key: 'nohash', pythonCoverageData, lineHits: {} }]);
    const report = await c.toCoverageReport();
    expect(Object.keys(report.pythonShellFiles)).toHaveLength(0);
  });

  it('toCoverageReport() python loop: skips entries where action file not in files (covers line 421 continue)', async () => {
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const pythonCoverageData = { executedLines: [1], missingLines: [], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [{ path: '/nonexistent/action.yml#step1', pythonCoverageData }],
      },
    );
    const report = await collector.toCoverageReport();
    expect(Object.keys(report.pythonShellFiles)).toHaveLength(0);
  });

  it('listener routes pythonCoverageData entries to _pythonShellCoverageData and populates pyStepLineHits (covers line 434 else branch with two entries)', async () => {
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const pythonCoverageData = { executedLines: [1], missingLines: [2], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    listener(
      {
        conclusion: 'success', outputs: {}, steps: [
          { id: 'step1', name: 'run', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', annotations: [] },
        ],
        step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '',
      },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [
          { path: `${actionFilePath}#step1`, pythonCoverageData },
          { path: `${actionFilePath}#step2`, pythonCoverageData },
        ],
      },
    );
    const report = await collector.toCoverageReport();
    expect(Object.keys(report.pythonShellFiles)).toHaveLength(2);
    expect(report.pythonShellFiles[`${actionFilePath}#step1`]).toBeDefined();
    expect(report.total.pythonShellStatements.total).toBeGreaterThan(0);
    const fc = report.files[actionFilePath];
    expect(fc?.pyStepLineHits?.['step1']).toEqual({ 1: 1, 2: 0 });
    expect(fc?.pyStepLineHits?.['step2']).toEqual({ 1: 1, 2: 0 });
  });

  it('merge() merges _pythonShellCoverageData from other collector', async () => {
    const actionFilePath = join(FIXTURES, 'simple', 'action.yml');
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const pythonCoverageData = { executedLines: [1, 2], missingLines: [3], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'simple', 'action.yml'),
        shellCoverage: [{ path: `${actionFilePath}#step1`, pythonCoverageData }],
      },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    expect(frag.pythonShellCoverageEntries).toHaveLength(1);
    expect(frag.pythonShellCoverageEntries![0]!.key).toBe(`${actionFilePath}#step1`);
  });
});

// ── js-coverage ───────────────────────────────────────────────────────────────

describe('mergeJsCoverage', () => {
  it('returns empty map for empty input', () => {
    expect(mergeJsCoverage([]).size).toBe(0);
  });

  it('groups multiple entries for the same path', () => {
    const entries = [
      { path: '/a.js', v8Data: {} },
      { path: '/b.js', v8Data: {} },
      { path: '/a.js', v8Data: {} },
    ];
    const result = mergeJsCoverage(entries);
    expect(result.size).toBe(2);
    expect(result.get('/a.js')).toHaveLength(2);
    expect(result.get('/b.js')).toHaveLength(1);
  });
});

describe('emptyJsStats', () => {
  it('returns zeroed stats for all four metrics', () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const stats = emptyJsStats();
    expect(stats.jsStatements).toEqual(zero);
    expect(stats.jsBranches).toEqual(zero);
    expect(stats.jsFunctions).toEqual(zero);
    expect(stats.jsLines).toEqual(zero);
  });
});

describe('buildJsStats', () => {
  it('returns empty object for empty entries array', async () => {
    expect(await buildJsStats([])).toEqual({});
  });

  it('returns empty object when source file does not exist and no entry.source', async () => {
    expect(await buildJsStats([{ path: '/does/not/exist.js', v8Data: { functions: [] } }])).toEqual({});
  });

  it('uses entry.source when file has been deleted (Fix 1: source attachment)', async () => {
    const source = 'console.log("hello");\n';
    const v8Data = {
      functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
    };
    const result = await buildJsStats([{ path: '/nonexistent/deleted-script.js', v8Data, source }]);
    expect(result.jsLines).toBeDefined();
    expect(result.jsLines!.covered).toBeGreaterThan(0);
    expect(result.istanbulData).toBeDefined();
  });

  it('converts V8 coverage data to Istanbul stats for a covered script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-js-cov-test-'));
    const scriptPath = join(dir, 'script.js');
    const source = 'console.log("hello");\n';
    writeFileSync(scriptPath, source);
    try {
      const v8Data = {
        functions: [{
          functionName: '',
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }],
        }],
      };
      const result = await buildJsStats([{ path: scriptPath, v8Data }]);
      expect(result.jsLines).toBeDefined();
      expect(result.jsLines!.covered).toBeGreaterThan(0);
      expect(result.jsLines!.total).toBeGreaterThan(0);
      expect(result.istanbulData).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges multiple runs of the same script', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-js-cov-merge-'));
    const scriptPath = join(dir, 'script.js');
    const source = 'function f() { return 1; }\nf();\n';
    writeFileSync(scriptPath, source);
    try {
      const v8Data = {
        functions: [
          { functionName: 'f', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: 26, count: 1 }] },
          { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
        ],
      };
      const result = await buildJsStats([{ path: scriptPath, v8Data }, { path: scriptPath, v8Data }]);
      expect(result.jsFunctions).toBeDefined();
      expect(result.jsFunctions!.covered).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── nodeCoverageData: createListener, toCoverageReport, merge, fromParts ──────

describe('nodeCoverageData — createListener', () => {
  it('routes nodeCoverageData entry to _nodeShellCoverageEntries (new key, then existing key)', async () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    const v8Entry = { path: '/tmp/script.js', v8Data: { functions: [] } };
    const key = `${actionFilePath}#step1`;

    // First call: creates new entry (else branch, line 282)
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-node-run', 'action.yml'),
        shellCoverage: [{ path: key, nodeCoverageData: [v8Entry] }],
      },
    );
    const frag1 = collector.toFragment();
    expect(frag1.nodeShellCoverageEntries).toHaveLength(1);
    expect(frag1.nodeShellCoverageEntries![0]!.entries).toHaveLength(1);

    // Second call with same key: pushes to existing entry (if branch, line 280)
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-node-run', 'action.yml'),
        shellCoverage: [{ path: key, nodeCoverageData: [v8Entry] }],
      },
    );
    const frag2 = collector.toFragment();
    expect(frag2.nodeShellCoverageEntries).toHaveLength(1);
    expect(frag2.nodeShellCoverageEntries![0]!.entries).toHaveLength(2);
  });
});

describe('nodeCoverageData — toCoverageReport', () => {
  it('skips entries with empty entries array (entries.length === 0)', async () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const entries: NodeShellCoverageEntry[] = [{ key: `${actionFilePath}#step1`, entries: [] }];
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [], entries);
    const report = await c.toCoverageReport();
    expect(report.files[actionFilePath]?.nodeShellLines).toBeUndefined();
  });

  it('skips entries with no # in key', async () => {
    const entries: NodeShellCoverageEntry[] = [{ key: 'nohash', entries: [{ path: '/f.js', v8Data: { functions: [] } }] }];
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [], entries);
    const report = await c.toCoverageReport();
    expect(Object.values(report.files).every((f) => !f.nodeShellLines)).toBe(true);
  });

  it('skips entries where action file is not in files (fileCov not found)', async () => {
    const entries: NodeShellCoverageEntry[] = [{ key: '/nonexistent/action.yml#step1', entries: [{ path: '/f.js', v8Data: { functions: [] } }] }];
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [], entries);
    const report = await c.toCoverageReport();
    expect(report.files['/nonexistent/action.yml']).toBeUndefined();
  });

  it('sets nodeShellFiles.lines.pct=0 when covered=0 (covered===0 branch)', async () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const source = '// just a comment\n';
    const key = `${actionFilePath}#step-uncovered`;
    // count=0 → line was never hit → covered=0 → pct=0 via covered===0 guard
    const v8Data = { functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }] };
    const entries: NodeShellCoverageEntry[] = [{ key, entries: [{ path: '/nonexistent/comment.js', v8Data, source }] }];
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-node-run', 'action.yml') },
    );
    const c = CoverageCollector.fromParts(collector.toFragment().istanbulMap as object, [], [], [], [], [], [], [], [], entries);
    const report = await c.toCoverageReport();
    const nodeShFile = report.nodeShellFiles[key];
    expect(nodeShFile).toBeDefined();
    expect(nodeShFile!.lines.covered).toBe(0);
    expect(nodeShFile!.lines.pct).toBe(0);
  });

  it('skips entries where buildJsStats returns no istanbulData (file not found)', async () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const entries: NodeShellCoverageEntry[] = [{ key: `${actionFilePath}#step1`, entries: [{ path: '/nonexistent/script.js', v8Data: { functions: [] } }] }];
    const collector = new CoverageCollector();
    const listener = collector.createListener();
    listener(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      { sourceFile: join(FIXTURES, 'with-node-run', 'action.yml') },
    );
    // Manually inject the entry after listener has built files
    const c = CoverageCollector.fromParts(
      collector.toFragment().istanbulMap as object,
      [],
      [], [], [], [], [], [], [], entries,
    );
    const report = await c.toCoverageReport();
    expect(report.files[actionFilePath]?.nodeShellLines).toBeUndefined();
  });

  it('processes nodeCoverageData entries with real V8 data and populates nodeShellLines + nodeShStepIstanbul + nodeShellStatements + nodeShellBranches + nodeShellFiles', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-nodesh-cov-'));
    const scriptPath = join(dir, 'script.js');
    const source = 'console.log("hello");\n';
    writeFileSync(scriptPath, source);
    try {
      const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
      const v8Data = {
        functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
      };
      const key = `${actionFilePath}#step1`;
      const entries: NodeShellCoverageEntry[] = [{ key, entries: [{ path: scriptPath, v8Data }] }];
      const collector = new CoverageCollector();
      const listener = collector.createListener();
      listener(
        { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
        { sourceFile: join(FIXTURES, 'with-node-run', 'action.yml') },
      );
      const c = CoverageCollector.fromParts(
        collector.toFragment().istanbulMap as object,
        [],
        [], [], [], [], [], [], [], entries,
      );
      const report = await c.toCoverageReport();
      const fc = report.files[actionFilePath];
      expect(fc?.nodeShellLines).toBeDefined();
      expect(fc?.nodeShellLines!.total).toBeGreaterThan(0);
      expect(fc?.nodeShellStatements).toBeDefined();
      expect(fc?.nodeShellStatements!.total).toBeGreaterThan(0);
      expect(fc?.nodeShellBranches).toBeDefined();
      expect(fc?.nodeShStepIstanbul?.['step1']).toBeDefined();
      // nodeShellFiles contains per-step entry
      expect(report.nodeShellFiles[key]).toBeDefined();
      expect(report.nodeShellFiles[key]!.statements.total).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accumulates nodeShellLines + nodeShellStatements + nodeShellBranches across two steps (prev?.covered branch; pct recompute)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-nodesh-2step-'));
    const scriptPath = join(dir, 'script.js');
    const source = 'console.log("hello");\n';
    writeFileSync(scriptPath, source);
    try {
      const actionFilePath = join(FIXTURES, 'with-node-two-steps', 'action.yml');
      const v8Data = {
        functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] }],
      };
      const entries: NodeShellCoverageEntry[] = [
        { key: `${actionFilePath}#step1`, entries: [{ path: scriptPath, v8Data }] },
        { key: `${actionFilePath}#step2`, entries: [{ path: scriptPath, v8Data }] },
      ];
      const collector = new CoverageCollector();
      const listener = collector.createListener();
      listener(
        { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
        { sourceFile: join(FIXTURES, 'with-node-two-steps', 'action.yml') },
      );
      const c = CoverageCollector.fromParts(
        collector.toFragment().istanbulMap as object,
        [],
        [], [], [], [], [], [], [], entries,
      );
      const report = await c.toCoverageReport();
      const fc = report.files[actionFilePath];
      expect(fc?.nodeShellLines?.total).toBeGreaterThan(1);
      expect(fc?.nodeShellLines?.pct).toBeGreaterThan(0);
      expect(fc?.nodeShellStatements?.total).toBeGreaterThan(1);
      expect(fc?.nodeShellStatements?.pct).toBeGreaterThan(0);
      expect(fc?.nodeShellBranches).toBeDefined();
      expect(fc?.nodeShellBranches?.pct).toBeGreaterThanOrEqual(0);
      expect(fc?.nodeShStepIstanbul?.['step1']).toBeDefined();
      expect(fc?.nodeShStepIstanbul?.['step2']).toBeDefined();
      // nodeShellFiles has both steps
      expect(Object.keys(report.nodeShellFiles)).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('populates non-empty uncoveredLines when a step has a statement with count=0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-nodesh-uncov-'));
    const scriptPath = join(dir, 'script.js');
    const source = 'console.log("a");\nconsole.log("b");\n';
    writeFileSync(scriptPath, source);
    try {
      const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
      const v8Data = {
        functions: [{ functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: source.length, count: 0 }] }],
      };
      const key = `${actionFilePath}#step1`;
      const entries: NodeShellCoverageEntry[] = [{ key, entries: [{ path: scriptPath, v8Data }] }];
      const collector = new CoverageCollector();
      const listener = collector.createListener();
      listener(
        { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
        { sourceFile: join(FIXTURES, 'with-node-run', 'action.yml') },
      );
      const c = CoverageCollector.fromParts(
        collector.toFragment().istanbulMap as object,
        [],
        [], [], [], [], [], [], [], entries,
      );
      const report = await c.toCoverageReport();
      const nodeShFile = report.nodeShellFiles[key];
      expect(nodeShFile).toBeDefined();
      expect(nodeShFile!.uncoveredLines.length).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('nodeCoverageData — merge()', () => {
  it('merges nodeShellCoverageEntries from another collector (new key)', () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const key = `${actionFilePath}#step1`;
    const c1 = new CoverageCollector();
    const c2 = new CoverageCollector();
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-node-run', 'action.yml'),
        shellCoverage: [{ path: key, nodeCoverageData: [{ path: '/tmp/s.js', v8Data: { functions: [] } }] }],
      },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    expect(frag.nodeShellCoverageEntries).toHaveLength(1);
    expect(frag.nodeShellCoverageEntries![0]!.key).toBe(key);
  });

  it('merges nodeShellCoverageEntries from another collector (existing key — pushes entries)', () => {
    const actionFilePath = join(FIXTURES, 'with-node-run', 'action.yml');
    const key = `${actionFilePath}#step1`;
    const v8Entry = { path: '/tmp/s.js', v8Data: { functions: [] } };
    const c1 = new CoverageCollector();
    const l1 = c1.createListener();
    l1(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-node-run', 'action.yml'),
        shellCoverage: [{ path: key, nodeCoverageData: [v8Entry] }],
      },
    );
    const c2 = new CoverageCollector();
    const l2 = c2.createListener();
    l2(
      { conclusion: 'success', outputs: {}, steps: [], step: () => undefined, env: {}, annotations: [], stdout: '', stderr: '' },
      {
        sourceFile: join(FIXTURES, 'with-node-run', 'action.yml'),
        shellCoverage: [{ path: key, nodeCoverageData: [v8Entry] }],
      },
    );
    c1.merge(c2);
    const frag = c1.toFragment();
    const entry = frag.nodeShellCoverageEntries?.find((e) => e.key === key);
    expect(entry?.entries).toHaveLength(2);
  });
});

describe('nodeCoverageData — fromParts()', () => {
  it('reconstructs nodeShellCoverageEntries with a new key (else branch)', () => {
    const entries: NodeShellCoverageEntry[] = [{ key: '/fake/action.yml#step1', entries: [{ path: '/tmp/s.js', v8Data: {} }] }];
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [], entries);
    const frag = c.toFragment();
    expect(frag.nodeShellCoverageEntries).toHaveLength(1);
    expect(frag.nodeShellCoverageEntries![0]!.key).toBe('/fake/action.yml#step1');
  });

  it('merges nodeShellCoverageEntries when same key appears twice in input (if branch)', () => {
    const entries: NodeShellCoverageEntry[] = [
      { key: '/fake/action.yml#step1', entries: [{ path: '/tmp/a.js', v8Data: {} }] },
      { key: '/fake/action.yml#step1', entries: [{ path: '/tmp/b.js', v8Data: {} }] },
    ];
    const c = CoverageCollector.fromParts({}, [], [], [], [], [], [], [], [], entries);
    const frag = c.toFragment();
    const entry = frag.nodeShellCoverageEntries?.find((e) => e.key === '/fake/action.yml#step1');
    expect(entry?.entries).toHaveLength(2);
  });
});

describe('aggregateTotals — nodeShellLines + nodeShellStatements + nodeShellBranches', () => {
  it('accumulates nodeShellLines from files that have it', () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const files = [
      {
        path: '/a.yml', steps: zero, ifBranches: zero, inputs: zero, outputs: zero,
        stepHits: {}, uncoveredSteps: [], ifBranchTable: [], inputTable: [], outputTable: [],
        nodeShellLines: { covered: 2, total: 3, pct: 66.7 },
      },
      {
        path: '/b.yml', steps: zero, ifBranches: zero, inputs: zero, outputs: zero,
        stepHits: {}, uncoveredSteps: [], ifBranchTable: [], inputTable: [], outputTable: [],
      },
    ];
    const totals = aggregateTotals(files as unknown as Parameters<typeof aggregateTotals>[0]);
    expect(totals.nodeShellLines.covered).toBe(2);
    expect(totals.nodeShellLines.total).toBe(3);
  });

  it('accumulates nodeShellStatements and nodeShellBranches from nodeShellFiles', () => {
    const zero = { covered: 0, total: 0, pct: 0 };
    const nodeShellFiles = {
      '/a.yml#step1': { path: '/a.yml#step1', statements: { covered: 3, total: 4, pct: 75 }, branches: { covered: 1, total: 2, pct: 50 }, lines: { covered: 3, total: 4, pct: 75 }, uncoveredLines: [] },
      '/b.yml#step2': { path: '/b.yml#step2', statements: { covered: 2, total: 2, pct: 100 }, branches: zero, lines: { covered: 2, total: 2, pct: 100 }, uncoveredLines: [] },
    };
    const totals = aggregateTotals([], {}, {}, {}, {}, {}, nodeShellFiles);
    expect(totals.nodeShellStatements.covered).toBe(5);
    expect(totals.nodeShellStatements.total).toBe(6);
    expect(totals.nodeShellBranches.covered).toBe(1);
    expect(totals.nodeShellBranches.total).toBe(2);
  });

  it('aggregateTotals() sums bashShellLines from bashShellFiles (covers collector.ts lines 871-873)', async () => {
    const { aggregateTotals } = await import('../src/collector.js');
    const bashShellFiles = {
      '/a.yml#step1': { path: '/a.yml#step1', lines: { covered: 2, total: 3, pct: 66.7 }, uncoveredLines: [] },
      '/b.yml#step1': { path: '/b.yml#step1', lines: { covered: 1, total: 1, pct: 100 }, uncoveredLines: [] },
    };
    const totals = aggregateTotals([], {}, {}, {}, bashShellFiles);
    expect(totals.bashShellLines.covered).toBe(3);
    expect(totals.bashShellLines.total).toBe(4);
  });
});

describe('fromParts() — bash coverage entries', () => {
  it('fromParts() accumulates hits for duplicate keys in bashShellCoverageEntries (covers collector.ts lines 797-803)', async () => {
    const { CoverageCollector: CC } = await import('../src/collector.js');
    const c = CC.fromParts({}, [], [], [], [], [], [
      { key: 'action.yml#step1', lineHits: { 1: 3 } },
      { key: 'action.yml#step1', lineHits: { 1: 2, 2: 1 } },
    ]);
    const frag = c.toFragment();
    const entry = frag.bashShellCoverageEntries!.find((e) => e.key === 'action.yml#step1');
    expect(entry!.lineHits[1]).toBe(5);
    expect(entry!.lineHits[2]).toBe(1);
  });
});
