// Unit test for composite-executor covering edge cases not exercisable via integration tests.

import { describe, it, expect, vi } from 'vitest';
import type { ParsedAction } from '@actharness/types';

// Mock @actharness/core before importing composite-executor
vi.mock('@actharness/core', async (importOriginal) => {
  const original = await importOriginal<typeof import('@actharness/core')>();
  return {
    ...original,
    runSteps: vi.fn(),
    evalTemplate: vi.fn((template: string) => template),
  };
});

// Mock @actharness/shell to avoid real bash processes
vi.mock('@actharness/shell', () => ({
  ShellSandbox: class {
    shell = vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false });
    endRun = vi.fn();
  },
}));

describe('compositeExecutor — pythonCoverageData shellCoverage branch', () => {
  it('routes step.shellCoverage with pythonCoverageData to the else branch (covers line 39)', async () => {
    const { runSteps } = await import('@actharness/core');
    const { compositeExecutor } = await import('../src/composite-executor.js');

    const pythonCoverageData = { executedLines: [1], missingLines: [], executedBranches: [] as [number, number][], missingBranches: [] as [number, number][] };
    const mockStep = {
      id: 'step1', name: 'run', phase: 'main' as const,
      ran: true, outcome: 'success' as const, conclusion: 'success' as const,
      outputs: {}, annotations: [], stdout: '', stderr: '',
      shellCoverage: { pythonCoverageData },
    };

    vi.mocked(runSteps).mockResolvedValue({
      steps: [mockStep],
      finalEnv: {},
      annotations: [],
      stdout: '',
      stderr: '',
    });

    const fakeAction: ParsedAction = {
      name: 'Fake',
      _file: '/fake/action/action.yml',
      _dir: '/fake/action',
      runs: { using: 'composite', steps: [] },
    };

    const result = await compositeExecutor.execute({
      action: fakeAction,
      inputs: {},
      context: { github: { workspace: '/tmp/fake-ws' } } as never,
      protocol: {} as never,
      options: {},
      mocks: {} as never,
      sandbox: {} as never,
      dispatch: vi.fn(),
      cycleGuard: [],
      depth: 0,
    });

    expect(result.shellCoverage).toBeDefined();
    const entry = result.shellCoverage![0]!;
    expect('pythonCoverageData' in entry).toBe(true);
  });
});

describe('compositeExecutor — nodeCoverageData shellCoverage branch', () => {
  it('routes step.shellCoverage with nodeCoverageData to the else-if branch (covers line 39)', async () => {
    const { runSteps } = await import('@actharness/core');
    const { compositeExecutor } = await import('../src/composite-executor.js');

    const nodeCoverageData = [{ path: '/tmp/script.js', v8Data: { functions: [] } }];
    const mockStep = {
      id: 'step1', name: 'run', phase: 'main' as const,
      ran: true, outcome: 'success' as const, conclusion: 'success' as const,
      outputs: {}, stdout: '', stderr: '',
      shellCoverage: { nodeCoverageData },
      annotations: [],
    };

    vi.mocked(runSteps).mockResolvedValue({
      steps: [mockStep],
      finalEnv: {},
      annotations: [],
      stdout: '',
      stderr: '',
    });

    const fakeAction: ParsedAction = {
      name: 'Fake',
      _file: '/fake/action/action.yml',
      _dir: '/fake/action',
      runs: { using: 'composite', steps: [] },
    };

    const result = await compositeExecutor.execute({
      action: fakeAction,
      inputs: {},
      context: { github: { workspace: '/tmp/fake-ws' } } as never,
      protocol: {} as never,
      options: {},
      mocks: {} as never,
      sandbox: {} as never,
      dispatch: vi.fn(),
      cycleGuard: [],
      depth: 0,
    });

    expect(result.shellCoverage).toBeDefined();
    const entry = result.shellCoverage![0]!;
    expect('nodeCoverageData' in entry).toBe(true);
  });
});

describe('compositeExecutor — _file ?? _dir fallback', () => {
  it('uses _dir when _file is undefined in shellCoverage path key', async () => {
    const { runSteps } = await import('@actharness/core');
    const { compositeExecutor } = await import('../src/composite-executor.js');

    const mockStep = {
      id: 'step1', name: 'run', phase: 'main' as const,
      ran: true, outcome: 'success' as const, conclusion: 'success' as const,
      outputs: {}, annotations: [], stdout: '', stderr: '',
      shellCoverage: { lineHits: { 1: 1 } },
    };

    vi.mocked(runSteps).mockResolvedValue({
      steps: [mockStep],
      finalEnv: {},
      annotations: [],
      stdout: '',
      stderr: '',
    });

    const fakeAction: ParsedAction = {
      name: 'Fake',
      _file: undefined,
      _dir: '/fake/action/dir',
      runs: { using: 'composite', steps: [] },
    };

    const result = await compositeExecutor.execute({
      action: fakeAction,
      inputs: {},
      context: { github: { workspace: '/tmp/fake-ws' } } as never,
      protocol: {} as never,
      options: {},
      mocks: {} as never,
      sandbox: {} as never,
      dispatch: vi.fn(),
      cycleGuard: [],
      depth: 0,
    });

    expect(result.shellCoverage).toBeDefined();
    expect(result.shellCoverage![0]!.path).toBe('/fake/action/dir#step1');
  });
});
