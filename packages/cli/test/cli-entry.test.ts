// Tests for the side-effectful entry points:
//   cli.ts      — argv dispatch + process.exit
//   register.ts — worker bootstrap + optional coverage collector
// Both use vi.resetModules() + dynamic import so each test gets a fresh module.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MockInstance } from 'vitest';

// ── Mocks for cli.ts commands ─────────────────────────────────────────────────

const mockTestCommand = vi.fn();
const mockRunCommand = vi.fn();
const mockInitCommand = vi.fn();

vi.mock('../src/commands/test.js', () => ({ testCommand: mockTestCommand }));
vi.mock('../src/commands/run.js', () => ({ runCommand: mockRunCommand }));
vi.mock('../src/commands/init.js', () => ({ initCommand: mockInitCommand }));

// ── Mocks for register.ts ─────────────────────────────────────────────────────

vi.mock('node:test', () => ({
  describe: vi.fn(), it: vi.fn(), test: vi.fn(),
  before: vi.fn(), after: vi.fn(), beforeEach: vi.fn(), afterEach: vi.fn(),
}));

vi.mock('@actharness/matchers', () => ({ expect: vi.fn() }));

vi.mock('@actharness/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actharness/core')>();
  return { ...actual, registerRunListener: vi.fn() };
});

vi.mock('@actharness/composite', () => ({}));

vi.mock('@actharness/node', () => ({
  mockGitHubApi: vi.fn(),
  mockGitHubApiOnce: vi.fn(),
  mockNetwork: vi.fn(),
  mockNetworkOnce: vi.fn(),
  resetNetworkMocks: vi.fn(),
}));

vi.mock('@actharness/coverage', () => ({
  CoverageCollector: vi.fn(function() {
    return {
      createListener: vi.fn(() => vi.fn()),
      coverageMap: { toJSON: vi.fn(() => ({})) },
      toFragment: vi.fn(() => ({ istanbulMap: {}, inputExercises: [] })),
    };
  }),
}));

const mockMkdirSync = vi.fn();
const mockWriteFileSync = vi.fn();
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, mkdirSync: mockMkdirSync, writeFileSync: mockWriteFileSync };
});

// ── register.ts resetMocks — stable first-evaluation coverage ────────────────
// Must appear before any describe that calls vi.resetModules(), so this import
// is the canonical V8 script instance and its coverage is properly attributed.

describe('register.ts resetMocks coverage', () => {
  it('resetMocks() covered on first import', async () => {
    await import('../src/register.js');
    const { resetNetworkMocks } = await import('@actharness/node');
    const g = globalThis as Record<string, unknown>;

    // Cover the resetMocks arrow function body.
    const acth = g['actharness'] as { resetMocks: () => void };
    acth.resetMocks();

    expect(vi.mocked(resetNetworkMocks)).toHaveBeenCalledTimes(1);
  });
});

// ── cli.ts dispatch tests ─────────────────────────────────────────────────────

describe('cli.ts dispatch', () => {
  let exitSpy: MockInstance<typeof process.exit>;
  const savedArgv = process.argv;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    mockTestCommand.mockResolvedValue(0);
    mockRunCommand.mockResolvedValue(0);
    mockInitCommand.mockResolvedValue(0);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
      throw new Error('process.exit called');
    });
  });

  afterEach(() => {
    process.argv = savedArgv;
    exitSpy.mockRestore();
  });

  it('dispatches to testCommand for "test"', async () => {
    process.argv = ['node', 'actharness', 'test', 'foo.ts'];
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(mockTestCommand).toHaveBeenCalledWith(['foo.ts']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches to runCommand for "run"', async () => {
    process.argv = ['node', 'actharness', 'run', '--dir', '/tmp'];
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(mockRunCommand).toHaveBeenCalledWith(['--dir', '/tmp']);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('dispatches to initCommand for "init"', async () => {
    process.argv = ['node', 'actharness', 'init'];
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(mockInitCommand).toHaveBeenCalledWith([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('prints usage and exits 1 when command is undefined (no command)', async () => {
    process.argv = ['node', 'actharness'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("''"));
    errSpy.mockRestore();
  });

  it('prints usage and exits 1 for unknown command (command ?? "" FALSE branch)', async () => {
    process.argv = ['node', 'actharness', 'badcmd'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("'badcmd'"));
    errSpy.mockRestore();
  });

  it('prints deferred message and exits 1 for "types"', async () => {
    process.argv = ['node', 'actharness', 'types'];
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(import('../src/cli.js')).rejects.toThrow();
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('deferred'));
    errSpy.mockRestore();
  });
});

// ── register.ts bootstrap tests ───────────────────────────────────────────────

describe('register.ts worker bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMkdirSync.mockImplementation(() => {});
    mockWriteFileSync.mockImplementation(() => {});
    vi.resetModules();
    delete process.env['ACTHARNESS_COVERAGE_TMP'];
  });

  afterEach(() => {
    delete process.env['ACTHARNESS_COVERAGE_TMP'];
  });

  it('injects lifecycle + actharness + expect into globalThis (no coverage env var)', async () => {
    await import('../src/register.js');
    const g = globalThis as Record<string, unknown>;
    expect(typeof g['describe']).toBe('function');
    expect(typeof g['actharness']).toBe('function');
    expect(typeof g['expect']).toBe('function');
    const acth = g['actharness'] as { resetMocks: () => void; mockGitHubApi: unknown; mockNetwork: unknown };
    expect(typeof acth.mockGitHubApi).toBe('function');
    expect(typeof acth.mockNetwork).toBe('function');
    // Verify resetMocks wrapper runs without error (covers line 33 function body).
    expect(() => acth.resetMocks()).not.toThrow();
  });

  it('registers coverage collector when ACTHARNESS_COVERAGE_TMP is set (try path)', async () => {
    process.env['ACTHARNESS_COVERAGE_TMP'] = '/tmp/actharness-cov-test';

    const exitCallbacks: Array<() => void> = [];
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') exitCallbacks.push(cb as () => void);
      return process;
    });

    await import('../src/register.js');

    const { registerRunListener } = await import('@actharness/core');
    expect(vi.mocked(registerRunListener)).toHaveBeenCalledOnce();

    exitCallbacks[0]?.();
    expect(mockMkdirSync).toHaveBeenCalledWith('/tmp/actharness-cov-test', { recursive: true });
    expect(mockWriteFileSync).toHaveBeenCalled();

    onSpy.mockRestore();
  });

  it('exit handler suppresses write errors (catch path)', async () => {
    process.env['ACTHARNESS_COVERAGE_TMP'] = '/tmp/actharness-cov-test';
    mockWriteFileSync.mockImplementation(() => { throw new Error('disk full'); });

    const exitCallbacks: Array<() => void> = [];
    const onSpy = vi.spyOn(process, 'on').mockImplementation((event: string | symbol, cb: (...args: unknown[]) => void) => {
      if (event === 'exit') exitCallbacks.push(cb as () => void);
      return process;
    });

    await import('../src/register.js');
    expect(() => exitCallbacks[0]?.()).not.toThrow();

    onSpy.mockRestore();
  });

});
