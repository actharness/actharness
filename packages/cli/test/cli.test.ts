import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedAction, RunResult } from '@actharness/types';
import { loadConfig } from '../src/config.js';

// ── hoisted mock vars (must come before vi.mock calls) ────────────────────────

const hoisted = vi.hoisted(() => {
  const mockRun = vi.fn();
  const mockMock = vi.fn();
  const mockGlob = vi.fn();
  const mockTestRun = vi.fn();
  const mockParseAction = vi.fn();

  const mockActionHandle = {
    mock: mockMock,
    unmock: vi.fn().mockReturnThis(),
    resetMocks: vi.fn().mockReturnThis(),
    run: mockRun,
    manifest: {} as ParsedAction,
    type: 'composite' as const,
  };
  const mockActharness = vi.fn().mockReturnValue(mockActionHandle);

  return { mockRun, mockMock, mockGlob, mockTestRun, mockParseAction, mockActharness, mockActionHandle };
});

// ── module mocks ──────────────────────────────────────────────────────────────

vi.mock('@actharness/composite', () => ({}));

vi.mock('@actharness/core', () => ({
  actharness: hoisted.mockActharness,
  parseAction: hoisted.mockParseAction,
  globalMock: hoisted.mockMock,
}));

vi.mock('glob', () => ({ glob: hoisted.mockGlob }));

let mockTestEvents: Array<{ type: string; data: unknown }> = [];
vi.mock('node:test', () => ({
  run: hoisted.mockTestRun.mockImplementation(() => {
    const events = [...mockTestEvents];
    return (async function* () { for (const e of events) yield e; })();
  }),
}));

// ── imports after mocks ───────────────────────────────────────────────────────

import {
  parseTestArgs,
  runTests,
  testCommand,
  checkThresholds,
  mergeCoverageData,
  defaultRegisterUrl,
  type TestOptions,
} from '../src/commands/test.js';
import {
  parseRunArgs,
  parseMockFile,
  printHumanResult,
  runCommand,
} from '../src/commands/run.js';
import {
  generateTestScaffold,
  parseInitArgs,
  initCommand,
} from '../src/commands/init.js';
import { CoverageCollector } from '@actharness/coverage';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  return {
    conclusion: 'success',
    outputs: {},
    steps: [],
    env: {},
    annotations: [],
    stdout: '',
    stderr: '',
    step: () => undefined,
    ...overrides,
  };
}

function makeAction(overrides: Partial<ParsedAction> = {}): ParsedAction {
  return {
    name: 'Test Action',
    runs: { using: 'composite', steps: [] },
    _dir: '/fake',
    ...overrides,
  };
}

// ── parseTestArgs ─────────────────────────────────────────────────────────────

describe('parseTestArgs', () => {
  it('defaults to wildcard pattern when no args given', () => {
    const opts = parseTestArgs([]);
    expect(opts.patterns).toEqual(['**/*.{actharness,test}.ts']);
    expect(opts.coverage).toBe(false);
    expect(opts.reporters).toEqual([]);
  });

  it('parses explicit pattern', () => {
    expect(parseTestArgs(['src/**/*.test.ts']).patterns).toEqual(['src/**/*.test.ts']);
  });

  it('parses --coverage flag and sets default reporters', () => {
    const opts = parseTestArgs(['--coverage']);
    expect(opts.coverage).toBe(true);
    expect(opts.reporters).toEqual(['lcov', 'html', 'text']);
  });

  it('--coverage with explicit --reporter does not add defaults', () => {
    const opts = parseTestArgs(['--coverage', '--reporter', 'lcov']);
    expect(opts.reporters).toEqual(['lcov']);
  });

  it('--reporter accepts comma-separated values', () => {
    const opts = parseTestArgs(['--reporter', 'html,lcov']);
    expect(opts.reporters).toEqual(['html', 'lcov']);
  });

  it('--reporter comma-separated and repeated flags both work', () => {
    const opts = parseTestArgs(['--reporter', 'html,lcov', '--reporter', 'text']);
    expect(opts.reporters).toEqual(['html', 'lcov', 'text']);
  });

  it('parses --threshold', () => {
    expect(parseTestArgs(['--threshold', 'statements=90']).thresholds['statements']).toBe(90);
  });

  it('parses --coverage-dir', () => {
    expect(parseTestArgs(['--coverage-dir', '/tmp/cov']).coverageDir).toBe('/tmp/cov');
  });

  it('parses multiple patterns', () => {
    expect(parseTestArgs(['a.test.ts', 'b.test.ts']).patterns).toEqual(['a.test.ts', 'b.test.ts']);
  });

  it('ignores unknown flags', () => {
    expect(parseTestArgs(['--unknown-flag', 'file.test.ts']).patterns).toEqual(['file.test.ts']);
  });

  it('ignores --threshold pair with no = sign', () => {
    const opts = parseTestArgs(['--threshold', 'noequals']);
    expect(Object.keys(opts.thresholds)).toHaveLength(0);
  });

  it('parses --workers flag', () => {
    expect(parseTestArgs(['--workers', '4']).workers).toBe(4);
  });

  it('clamps --workers to 1 when value parses to zero', () => {
    expect(parseTestArgs(['--workers', '0']).workers).toBe(1);
  });
});

// ── defaultRegisterUrl ────────────────────────────────────────────────────────

describe('defaultRegisterUrl', () => {
  it('returns a file:// URL string containing register', () => {
    const url = defaultRegisterUrl();
    expect(url).toMatch(/^file:\/\//);
    expect(url).toContain('register');
  });
});

// ── checkThresholds ───────────────────────────────────────────────────────────

describe('checkThresholds', () => {
  it('returns false when thresholds object is empty', async () => {
    expect(await checkThresholds(new CoverageCollector(), {}, '/tmp/cov')).toBe(false);
  });

  it('returns false when all thresholds are met', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
          s: { '0': 1 }, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    expect(await checkThresholds(collector, { steps: 90 }, '/tmp/cov')).toBe(false);
  });

  it('returns true and logs error when threshold not met', async () => {
    const collector = CoverageCollector.fromParts(
      {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
          s: { '0': 0 }, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      [],
    );
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await checkThresholds(collector, { steps: 80 }, '/tmp/cov')).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('uses 0 for unknown threshold key', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await checkThresholds(new CoverageCollector(), { unknownMetric: 50 }, '/tmp/cov')).toBe(true);
    spy.mockRestore();
  });
});

// ── mergeCoverageData ─────────────────────────────────────────────────────────

describe('mergeCoverageData', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'actharness-merge-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns empty collector when dir has no JSON files', () => {
    const collector = mergeCoverageData(tmpDir);
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('merges valid coverage JSON files (extended format)', () => {
    const fragment = {
      istanbulMap: {
        '/fake/action.yml': {
          path: '/fake/action.yml',
          statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
          s: { '0': 1 }, branchMap: {}, b: {}, fnMap: {}, f: {},
        },
      },
      inputExercises: [],
    };
    writeFileSync(join(tmpDir, 'frag.json'), JSON.stringify(fragment));
    const collector = mergeCoverageData(tmpDir);
    expect(collector.coverageMap.toJSON()['/fake/action.yml']).toBeDefined();
  });

  it('merges valid coverage JSON files (legacy plain Istanbul format)', () => {
    const fragment = {
      '/fake/action.yml': {
        path: '/fake/action.yml',
        statementMap: { '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } } },
        s: { '0': 1 }, branchMap: {}, b: {}, fnMap: {}, f: {},
      },
    };
    writeFileSync(join(tmpDir, 'frag.json'), JSON.stringify(fragment));
    const collector = mergeCoverageData(tmpDir);
    expect(collector.coverageMap.toJSON()['/fake/action.yml']).toBeDefined();
  });

  it('skips non-JSON files', () => {
    writeFileSync(join(tmpDir, 'readme.txt'), 'not json');
    const collector = mergeCoverageData(tmpDir);
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('skips malformed JSON files', () => {
    writeFileSync(join(tmpDir, 'bad.json'), 'not valid json {{{');
    const collector = mergeCoverageData(tmpDir);
    expect(Object.keys(collector.coverageMap.toJSON())).toHaveLength(0);
  });

  it('merges pwshShellCoverageEntries from fragment', () => {
    const fragment = {
      istanbulMap: {},
      pwshShellCoverageEntries: [{ key: 'a.yml#step1', lineHits: { 1: 2 } }],
    };
    writeFileSync(join(tmpDir, 'frag.json'), JSON.stringify(fragment));
    const collector = mergeCoverageData(tmpDir);
    const frag = collector.toFragment();
    expect(frag.pwshShellCoverageEntries).toHaveLength(1);
    expect(frag.pwshShellCoverageEntries![0]!.key).toBe('a.yml#step1');
  });
});

// ── runTests ──────────────────────────────────────────────────────────────────

describe('runTests', () => {
  beforeEach(() => {
    hoisted.mockGlob.mockReset();
    mockTestEvents = [];
    hoisted.mockTestRun.mockImplementation(() => {
      const events = [...mockTestEvents];
      return (async function* () { for (const e of events) yield e; })();
    });
  });

  const REG = 'file:///fake/register.js';
  const TSX = 'file:///fake/tsx.js';

  it('returns failed=1 when no test files found', async () => {
    hoisted.mockGlob.mockResolvedValue([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);
    spy.mockRestore();
  });

  it('counts pass events at leaf nesting', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 't', nesting: 0, file: '/fake/test.ts' } },
      { type: 'test:pass', data: { name: 't', nesting: 0, file: '/fake/test.ts', details: { duration_ms: 1 } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(1);
    spy.mockRestore();
  });

  it('does not count orphaned pass when no matching test:start', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [{ type: 'test:pass', data: { name: 'nested', nesting: 1, details: { duration_ms: 1 } } }];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    spy.mockRestore();
  });

  it('counts fail events at leaf nesting', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 'bad', nesting: 0, file: '/fake/test.ts' } },
      { type: 'test:fail', data: { name: 'bad', nesting: 0, file: '/fake/test.ts', details: { duration_ms: 1, error: new Error('x') } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.failed).toBe(1);
    spy.mockRestore();
  });

  it('uses String(err) when error has no message', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 'bad', nesting: 0, file: '/fake/test.ts' } },
      { type: 'test:fail', data: { name: 'bad', nesting: 0, file: '/fake/test.ts', details: { duration_ms: 1, error: null } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('null'))).toBe(true);
    spy.mockRestore();
  });

  it('does not count orphaned fail when no matching test:start', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [{ type: 'test:fail', data: { name: 'nested', nesting: 2, details: { duration_ms: 1, error: new Error('x') } } }];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.failed).toBe(0);
    spy.mockRestore();
  });

  it('renders describe+test hierarchy: describe as header, test with icon', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: '/fake/test.ts', nesting: 0 } },               // file-suite wrapper (no d.file) → skipped
      { type: 'test:start', data: { name: 'Suite', nesting: 0, file: '/fake/test.ts' } }, // describe A at nesting=0
      { type: 'test:start', data: { name: 'Suite', nesting: 0, file: '/fake/test.ts' } }, // describe B at nesting=0 (covers !has false branch)
      { type: 'test:start', data: { name: 'a test', nesting: 1, file: '/fake/test.ts' } },
      { type: 'test:pass', data: { name: 'a test', nesting: 1, file: '/fake/test.ts', details: { duration_ms: 1 } } },
      { type: 'test:pass', data: { name: 'Suite', nesting: 0, file: '/fake/test.ts', details: { duration_ms: 1 } } },
      { type: 'test:pass', data: { name: '/fake/test.ts', nesting: 0, details: { duration_ms: 1 } } }, // file-suite wrapper → skipped
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(1);
    const calls = spy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes('Suite') && !c.includes('✓') && !c.includes('✗'))).toBe(true);
    expect(calls.some((c) => c.includes('✓') && c.includes('a test'))).toBe(true);
    spy.mockRestore();
  });

  it('handles test:start at nesting > 0 with no parent in stack', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 'orphan', nesting: 1, file: '/fake/test.ts' } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    spy.mockRestore();
  });

  it('does not print file section when no test lines are collected', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:pass', data: { name: '/fake/test.ts', nesting: 0, details: { duration_ms: 1 } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    spy.mockRestore();
  });

  it('does not count pass when no matching test:start exists for that nesting', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:pass', data: { name: 't', nesting: 1, file: '/fake/test.ts', details: { duration_ms: 1 } } },
      { type: 'test:pass', data: { name: '/fake/test.ts', nesting: 0, details: { duration_ms: 1 } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    spy.mockRestore();
  });

  it('handles test:fail without details object', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 't', nesting: 0, file: '/fake/test.ts' } },
      { type: 'test:fail', data: { name: 't', nesting: 0, file: '/fake/test.ts' } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.failed).toBe(1);
    spy.mockRestore();
  });

  it('ignores unknown event types', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [{ type: 'test:diagnostic', data: { message: 'hi' } }];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    spy.mockRestore();
  });

  it('skips nesting=0 events without d.file regardless of event type', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [{ type: 'test:plan', data: { nesting: 0, name: '/fake/test.ts', count: 1 } }];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {} }, REG, TSX);
    expect(result.passed).toBe(0);
    expect(result.failed).toBe(0);
    spy.mockRestore();
  });

  it('uses workers from opts when explicitly set', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 't', nesting: 0, file: '/fake/test.ts' } },
      { type: 'test:pass', data: { name: 't', nesting: 0, file: '/fake/test.ts', details: { duration_ms: 1 } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const result = await runTests({ patterns: ['*.test.ts'], coverage: false, reporters: [], coverageDir: '/tmp', thresholds: {}, workers: 1 }, REG, TSX);
    expect(result.passed).toBe(1);
    spy.mockRestore();
  });

  it('runs coverage and writes coverage-final.json', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'actharness-cov-out-'));
    try {
      hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
      mockTestEvents = [{ type: 'test:pass', data: { name: 't', nesting: 0, details: { duration_ms: 1 } } }];
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const opts: TestOptions = { patterns: ['*.test.ts'], coverage: true, reporters: ['text'], coverageDir: outDir, thresholds: {} };
      const result = await runTests(opts, REG, TSX);
      expect(result.thresholdFailed).toBe(false);
      expect(existsSync(join(outDir, 'coverage-final.json'))).toBe(true);
      spy.mockRestore();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('routes html reporter to actharness handler (writes index.html)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'actharness-cov-html-'));
    try {
      hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
      mockTestEvents = [{ type: 'test:pass', data: { name: 't', nesting: 0, details: { duration_ms: 1 } } }];
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const opts: TestOptions = { patterns: ['*.test.ts'], coverage: true, reporters: ['html'], coverageDir: outDir, thresholds: {} };
      const result = await runTests(opts, REG, TSX);
      expect(result.thresholdFailed).toBe(false);
      expect(existsSync(join(outDir, 'index.html'))).toBe(true);
      spy.mockRestore();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('runs coverage with Istanbul-only reporter (no actharness reporters)', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'actharness-cov-istanbul-'));
    try {
      hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
      mockTestEvents = [{ type: 'test:pass', data: { name: 't', nesting: 0, details: { duration_ms: 1 } } }];
      const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const opts: TestOptions = { patterns: ['*.test.ts'], coverage: true, reporters: ['lcov'], coverageDir: outDir, thresholds: {} };
      const result = await runTests(opts, REG, TSX);
      expect(result.thresholdFailed).toBe(false);
      expect(existsSync(join(outDir, 'coverage-final.json'))).toBe(true);
      spy.mockRestore();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('returns thresholdFailed=true when coverage thresholds not met', async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'actharness-cov-out-'));
    try {
      hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
      mockTestEvents = [];
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const opts: TestOptions = { patterns: ['*.test.ts'], coverage: true, reporters: ['text'], coverageDir: outDir, thresholds: { steps: 1 } };
      const result = await runTests(opts, REG, TSX);
      expect(result.thresholdFailed).toBe(true);
      logSpy.mockRestore();
      errSpy.mockRestore();
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});

// ── testCommand ───────────────────────────────────────────────────────────────

describe('testCommand', () => {
  beforeEach(() => {
    hoisted.mockGlob.mockReset();
    mockTestEvents = [];
    hoisted.mockTestRun.mockImplementation(() => {
      const events = [...mockTestEvents];
      return (async function* () { for (const e of events) yield e; })();
    });
  });

  const REG = 'file:///fake/register.js';
  const TSX = 'file:///fake/tsx.js';

  it('returns 0 when all tests pass', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [{ type: 'test:pass', data: { name: 'ok', nesting: 0, details: { duration_ms: 1 } } }];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await testCommand(['src/**/*.test.ts'], REG, TSX)).toBe(0);
    spy.mockRestore();
  });

  it('returns 1 when a test fails', async () => {
    hoisted.mockGlob.mockResolvedValue(['/fake/test.ts']);
    mockTestEvents = [
      { type: 'test:start', data: { name: 'bad', nesting: 1, file: '/fake/test.ts' } },
      { type: 'test:fail', data: { name: 'bad', nesting: 1, file: '/fake/test.ts', details: { duration_ms: 1, error: new Error('x') } } },
      { type: 'test:fail', data: { name: '/fake/test.ts', nesting: 0, details: { duration_ms: 1, error: new Error('suite failed') } } },
    ];
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await testCommand([], REG, TSX)).toBe(1);
    spy.mockRestore();
  });

  it('returns 1 when no test files found', async () => {
    hoisted.mockGlob.mockResolvedValue([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await testCommand([], REG, TSX)).toBe(1);
    spy.mockRestore();
  });
});

// ── parseRunArgs ──────────────────────────────────────────────────────────────

describe('parseRunArgs', () => {
  it('returns error string when no action path given', () => {
    expect(typeof parseRunArgs([])).toBe('string');
  });

  it('parses action path and defaults', () => {
    const r = parseRunArgs(['./action.yml']);
    if (typeof r === 'object') {
      expect(r.actionPath).toContain('action.yml');
      expect(r.json).toBe(false);
      expect(r.mocks).toHaveLength(0);
    }
  });

  it('parses --input k=v', () => {
    const r = parseRunArgs(['./action.yml', '--input', 'name=World']);
    if (typeof r === 'object') expect(r.inputs['name']).toBe('World');
  });

  it('parses --mock ref=json', () => {
    const r = parseRunArgs(['./action.yml', '--mock', 'checkout@v4={"outputs":{"ref":"abc"}}']);
    if (typeof r === 'object') {
      expect(r.mocks[0]?.ref).toBe('checkout@v4');
      expect(r.mocks[0]?.def.outputs?.['ref']).toBe('abc');
    }
  });

  it('returns error for invalid --mock JSON', () => {
    expect(typeof parseRunArgs(['./action.yml', '--mock', 'ref=bad json'])).toBe('string');
  });

  it('parses --mock-file', () => {
    const r = parseRunArgs(['./action.yml', '--mock-file', './mocks.yml']);
    if (typeof r === 'object') expect(r.mockFile).toContain('mocks.yml');
  });

  it('parses --setup', () => {
    const r = parseRunArgs(['./action.yml', '--setup', './setup.ts']);
    if (typeof r === 'object') expect(r.setupFile).toContain('setup.ts');
  });

  it('parses --event', () => {
    const r = parseRunArgs(['./action.yml', '--event', 'push']);
    if (typeof r === 'object') expect(r.eventName).toBe('push');
  });

  it('parses --json flag', () => {
    const r = parseRunArgs(['./action.yml', '--json']);
    if (typeof r === 'object') expect(r.json).toBe(true);
  });

  it('ignores --input pair with no = sign', () => {
    const r = parseRunArgs(['./action.yml', '--input', 'noequals']);
    if (typeof r === 'object') expect(Object.keys(r.inputs)).toHaveLength(0);
  });

  it('ignores --mock pair with no = sign', () => {
    const r = parseRunArgs(['./action.yml', '--mock', 'noequals']);
    if (typeof r === 'object') expect(r.mocks).toHaveLength(0);
  });

  it('silently ignores unrecognised -- flags', () => {
    const r = parseRunArgs(['./action.yml', '--unknown-flag']);
    if (typeof r === 'object') expect(r.actionPath).toContain('action.yml');
  });
});

// ── parseMockFile ─────────────────────────────────────────────────────────────

describe('parseMockFile', () => {
  it('parses uses: block', () => {
    const mocks = parseMockFile(`uses:\n  checkout@v4:\n    outputs:\n      ref: abc\n`);
    expect(mocks[0]?.ref).toBe('checkout@v4');
    expect(mocks[0]?.def.outputs?.['ref']).toBe('abc');
  });

  it('returns empty array when no uses: block', () => {
    expect(parseMockFile('{}')).toHaveLength(0);
  });

  it('returns empty array for null YAML', () => {
    expect(parseMockFile('null')).toHaveLength(0);
  });

  it('returns empty array when uses: is falsy', () => {
    expect(parseMockFile('uses: null')).toHaveLength(0);
  });
});

// ── printHumanResult ──────────────────────────────────────────────────────────

describe('printHumanResult', () => {
  it('prints ✓ for success', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({ conclusion: 'success' }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('✓'))).toBe(true);
    spy.mockRestore();
  });

  it('prints ✗ for failure', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({ conclusion: 'failure' }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('✗'))).toBe(true);
    spy.mockRestore();
  });

  it('prints outputs section when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({ outputs: { greeting: 'Hello' } }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('greeting'))).toBe(true);
    spy.mockRestore();
  });

  it('prints steps section when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({
      steps: [{ id: 's1', name: 'Step One', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, annotations: [], stdout: '', stderr: '' }],
    }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('Step One'))).toBe(true);
    spy.mockRestore();
  });

  it('falls back to step id when name is empty', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({
      steps: [{ id: 'step-id-1', name: '', phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, annotations: [], stdout: '', stderr: '' }],
    }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('step-id-1'))).toBe(true);
    spy.mockRestore();
  });

  it('uses - icon for skipped steps', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({
      steps: [{ id: 's', name: 'Skip', phase: 'main', ran: false, outcome: 'skipped', conclusion: 'skipped', outputs: {}, annotations: [], stdout: '', stderr: '' }],
    }));
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('-');
    spy.mockRestore();
  });

  it('uses ✗ icon for failed steps', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({
      conclusion: 'failure',
      steps: [{ id: 's', name: 'Fail', phase: 'main', ran: true, outcome: 'failure', conclusion: 'failure', outputs: {}, annotations: [], stdout: '', stderr: '' }],
    }));
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output.split('\n').filter((l) => l.includes('✗'))).toHaveLength(2); // header + step
    spy.mockRestore();
  });

  it('prints annotations section when present', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    printHumanResult(makeRunResult({ annotations: [{ level: 'warning', message: 'watch out' }] }));
    expect(spy.mock.calls.some((c) => String(c[0]).includes('watch out'))).toBe(true);
    spy.mockRestore();
  });
});

// ── runCommand ────────────────────────────────────────────────────────────────

describe('runCommand', () => {
  beforeEach(() => {
    hoisted.mockActharness.mockReturnValue(hoisted.mockActionHandle);
    hoisted.mockMock.mockReset();
    hoisted.mockRun.mockReset();
  });

  it('returns 1 when no action path given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCommand([])).toBe(1);
    spy.mockRestore();
  });

  it('returns 0 on success, prints human result', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult({ conclusion: 'success' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml'])).toBe(0);
    spy.mockRestore();
  });

  it('returns 1 on action failure', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult({ conclusion: 'failure' }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml'])).toBe(1);
    spy.mockRestore();
  });

  it('prints JSON when --json is set', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult({ outputs: { greeting: 'hi' } }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCommand(['./action.yml', '--json']);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('"conclusion"'))).toBe(true);
    spy.mockRestore();
  });

  it('applies --mock to action', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCommand(['./action.yml', '--mock', 'checkout@v4={"outputs":{"ref":"abc"}}']);
    expect(hoisted.mockMock).toHaveBeenCalledWith('checkout@v4', expect.objectContaining({ outputs: { ref: 'abc' } }));
    spy.mockRestore();
  });

  it('loads --mock-file and applies mocks', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const tmp = mkdtempSync(join(tmpdir(), 'actharness-run-'));
    const mockFilePath = join(tmp, 'mocks.yml');
    writeFileSync(mockFilePath, `uses:\n  checkout@v4:\n    outputs:\n      ref: xyz\n`);
    await runCommand(['./action.yml', '--mock-file', mockFilePath]);
    expect(hoisted.mockMock).toHaveBeenCalledWith('checkout@v4', expect.objectContaining({ outputs: { ref: 'xyz' } }));
    rmSync(tmp, { recursive: true, force: true });
    spy.mockRestore();
  });

  it('returns 1 when --mock-file does not exist', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml', '--mock-file', '/nonexistent/mocks.yml'])).toBe(1);
    spy.mockRestore();
  });

  it('sets inputs from --input flags', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCommand(['./action.yml', '--input', 'name=World']);
    expect(hoisted.mockRun).toHaveBeenCalledWith(expect.objectContaining({ inputs: { name: 'World' } }));
    spy.mockRestore();
  });

  it('sets github.event_name from --event', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await runCommand(['./action.yml', '--event', 'push']);
    expect(hoisted.mockRun).toHaveBeenCalledWith(expect.objectContaining({ github: { event_name: 'push' } }));
    spy.mockRestore();
  });

  it('returns 1 when action.run() throws', async () => {
    hoisted.mockRun.mockRejectedValue(new Error('boom'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml'])).toBe(1);
    spy.mockRestore();
  });

  it('returns 1 when --setup file fails to load', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml', '--setup', '/nonexistent/setup.ts'])).toBe(1);
    spy.mockRestore();
  });

  it('calls default export of --setup file when it is a function', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const setupPath = join(tmpdir(), `actharness-setup-${Date.now()}.mjs`);
    writeFileSync(setupPath, 'export default function setup() { /* registers mocks via actharness.* */ }\n');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml', '--setup', setupPath])).toBe(0);
    spy.mockRestore();
    rmSync(setupPath, { force: true });
  });

  it('skips calling setup when neither default nor setup export is a function', async () => {
    hoisted.mockRun.mockResolvedValue(makeRunResult());
    const setupPath = join(tmpdir(), `actharness-setup-empty-${Date.now()}.mjs`);
    writeFileSync(setupPath, '// no exports\n');
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await runCommand(['./action.yml', '--setup', setupPath])).toBe(0);
    spy.mockRestore();
    rmSync(setupPath, { force: true });
  });
});

// ── generateTestScaffold ──────────────────────────────────────────────────────

describe('generateTestScaffold', () => {
  it('generates describe with action name', () => {
    expect(generateTestScaffold(makeAction({ name: 'My Action' }), '/fake/action.yml')).toContain('describe("My Action"');
  });

  it('includes input defaults', () => {
    expect(generateTestScaffold(makeAction({ inputs: { name: { default: 'World' } } }), '/fake/action.yml')).toContain('name: "World"');
  });

  it('uses empty string for input with no default', () => {
    expect(generateTestScaffold(makeAction({ inputs: { token: {} } }), '/fake/action.yml')).toContain('token: ""');
  });

  it('includes toHaveOutput for each output', () => {
    expect(generateTestScaffold(makeAction({ outputs: { greeting: {} } }), '/fake/action.yml')).toContain('toHaveOutput("greeting")');
  });

  it('has no import statements', () => {
    expect(generateTestScaffold(makeAction(), '/fake/action.yml')).not.toContain('import ');
  });

  it('falls back to directory name when action name is empty', () => {
    const action = makeAction();
    (action as { name: string }).name = '';
    expect(generateTestScaffold(action, '/projects/my-action/action.yml')).toContain('my-action');
  });
});

// ── parseTestArgs with config ─────────────────────────────────────────────────

describe('parseTestArgs with config', () => {
  it('config.coverage enables coverage when no --coverage flag', () => {
    expect(parseTestArgs([], { coverage: true }).coverage).toBe(true);
  });

  it('config.coverage true with no reporters uses default reporters', () => {
    expect(parseTestArgs([], { coverage: true }).reporters).toEqual(['lcov', 'html', 'text']);
  });

  it('config.reporters used when coverage and no CLI --reporter', () => {
    expect(parseTestArgs([], { coverage: true, reporters: ['html'] }).reporters).toEqual(['html']);
  });

  it('CLI --reporter overrides config.reporters', () => {
    expect(parseTestArgs(['--coverage', '--reporter', 'lcov'], { reporters: ['html'] }).reporters).toEqual(['lcov']);
  });

  it('config.patterns used when no positional args', () => {
    expect(parseTestArgs([], { patterns: ['src/**/*.test.ts'] }).patterns).toEqual(['src/**/*.test.ts']);
  });

  it('CLI positional arg overrides config.patterns', () => {
    expect(parseTestArgs(['my.test.ts'], { patterns: ['src/**/*.test.ts'] }).patterns).toEqual(['my.test.ts']);
  });

  it('config.thresholds seeded into thresholds', () => {
    expect(parseTestArgs([], { thresholds: { steps: 80 } }).thresholds['steps']).toBe(80);
  });

  it('CLI --threshold overrides config.thresholds for same key', () => {
    expect(parseTestArgs(['--threshold', 'steps=90'], { thresholds: { steps: 80 } }).thresholds['steps']).toBe(90);
  });

  it('config.coverageDir used as fallback', () => {
    const opts = parseTestArgs([], { coverageDir: 'reports' });
    expect(opts.coverageDir).toContain('reports');
  });

  it('CLI --coverage-dir overrides config.coverageDir', () => {
    const opts = parseTestArgs(['--coverage-dir', '/tmp/out'], { coverageDir: 'reports' });
    expect(opts.coverageDir).toBe('/tmp/out');
  });

  it('config.workers used as default workers', () => {
    expect(parseTestArgs([], { workers: 3 }).workers).toBe(3);
  });
});

// ── parseRunArgs --record reservation ────────────────────────────────────────

describe('parseRunArgs --record', () => {
  it('returns error string when --record flag is used', () => {
    const result = parseRunArgs(['./action.yml', '--record']);
    expect(typeof result).toBe('string');
    expect(result as string).toContain('deferred');
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'actharness-cfg-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns {} when no config file exists', async () => {
    expect(await loadConfig(tmpDir)).toEqual({});
  });

  it('parses actharness.config.json', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.json'), JSON.stringify({ coverage: true, reporters: ['html'] }));
    expect(await loadConfig(tmpDir)).toEqual({ coverage: true, reporters: ['html'] });
  });

  it('returns {} for malformed actharness.config.json', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.json'), 'not json {{{');
    expect(await loadConfig(tmpDir)).toEqual({});
  });

  it('loads actharness.config.js via native import()', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.js'), 'export default { coverage: true, reporters: ["lcov"] };\n');
    const result = await loadConfig(tmpDir);
    expect(result).toEqual({ coverage: true, reporters: ['lcov'] });
  });

  it('falls back to module itself when .js config has no default export', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.js'), 'export const coverage = false;\n');
    const result = await loadConfig(tmpDir);
    expect(result).toBeDefined();
  });

  it('returns {} when actharness.config.js throws on load', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.js'), 'throw new Error("bad config");\n');
    expect(await loadConfig(tmpDir)).toEqual({});
  });

  it('loads actharness.config.ts via tsImport', async () => {
    writeFileSync(join(tmpDir, 'actharness.config.ts'), 'module.exports = { coverage: false, patterns: ["src/**/*.test.ts"] };\n');
    const result = await loadConfig(tmpDir);
    expect(result).toMatchObject({ patterns: ['src/**/*.test.ts'] });
  });
});

// ── parseInitArgs ─────────────────────────────────────────────────────────────

describe('parseInitArgs', () => {
  it('returns first non-flag arg', () => { expect(parseInitArgs(['./action.yml'])).toBe('./action.yml'); });
  it('returns undefined when no args', () => { expect(parseInitArgs([])).toBeUndefined(); });
  it('skips flag args', () => { expect(parseInitArgs(['--force', './action.yml'])).toBe('./action.yml'); });
});

// ── initCommand ───────────────────────────────────────────────────────────────

describe('initCommand', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'actharness-init-'));
    hoisted.mockParseAction.mockReturnValue(makeAction({ name: 'Greet' }));
  });

  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('generates action.test.ts and returns 0', async () => {
    writeFileSync(join(tmpDir, 'action.yml'), 'name: Greet\nruns:\n  using: composite\n  steps: []\n');
    expect(await initCommand([join(tmpDir, 'action.yml')])).toBe(0);
    expect(existsSync(join(tmpDir, 'action.test.ts'))).toBe(true);
  });

  it('returns 1 when no path given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await initCommand([])).toBe(1);
    spy.mockRestore();
  });

  it('returns 1 when parseAction throws', async () => {
    hoisted.mockParseAction.mockImplementation(() => { throw new Error('bad yml'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await initCommand(['/nonexistent/action.yml'])).toBe(1);
    spy.mockRestore();
  });

  it('returns 1 when action.test.ts already exists', async () => {
    writeFileSync(join(tmpDir, 'action.yml'), 'name: T\nruns:\n  using: composite\n  steps: []\n');
    writeFileSync(join(tmpDir, 'action.test.ts'), '// existing');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await initCommand([join(tmpDir, 'action.yml')])).toBe(1);
    spy.mockRestore();
  });
});
