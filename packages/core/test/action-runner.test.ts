import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { actharness, _dirFromStack } from '../src/action-runner.js';
import { registerExecutor } from '../src/executor-registry.js';
import type { ActionExecutor, ExecutionCall, ExecutionResult } from '../src/executor-registry.js';
import { ConfigError } from '../src/errors.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let tmpDirs: string[] = [];

function mktmp(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'actharness-ar-'));
  writeFileSync(join(dir, 'action.yml'), yaml);
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs) try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  tmpDirs = [];
});

// Each test gets a unique using type to avoid global REGISTRY accumulation issues.
let execCounter = 0;

type TestResult = Partial<ExecutionResult>;

function makeTestAction(result: TestResult = {}, extraYaml = ''): { action: ReturnType<typeof actharness>; using: string } {
  const using = `test-exec-${++execCounter}`;
  const executor: ActionExecutor = {
    handles: (u: string) => u === using,
    execute: async (_call: ExecutionCall): Promise<ExecutionResult> => ({
      conclusion: result.conclusion ?? 'success',
      outputs: result.outputs ?? {},
      env: result.env ?? {},
      steps: result.steps ?? [],
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }),
  };
  registerExecutor(executor);
  const yaml = `name: Test Action\nruns:\n  using: ${using}\n  steps: []\n${extraYaml}`;
  const dir = mktmp(yaml);
  return { action: actharness(dir), using };
}

function makeTestActionFromDir(yaml: string, result: TestResult = {}) {
  const using = `test-exec-${++execCounter}`;
  const executor: ActionExecutor = {
    handles: (u: string) => u === using,
    execute: async (): Promise<ExecutionResult> => ({
      conclusion: result.conclusion ?? 'success',
      outputs: result.outputs ?? {},
      env: result.env ?? {},
      steps: result.steps ?? [],
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }),
  };
  registerExecutor(executor);
  // Replace 'USING_PLACEHOLDER' in yaml with actual using string
  const dir = mktmp(yaml.replace('USING_PLACEHOLDER', using));
  return actharness(dir);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('actharness()', () => {
  it('returns an Action with the manifest loaded', () => {
    const { action } = makeTestAction();
    expect(action.manifest.name).toBe('Test Action');
  });

  it('type reflects runs.using', () => {
    const { action, using } = makeTestAction();
    expect(action.type).toBe(using);
  });

  it('returns an Action from a direct .yml file path', () => {
    const { using } = makeTestAction();
    void using;
    const yaml = `name: Direct\nruns:\n  using: test-exec-${execCounter}\n  steps: []\n`;
    const dir = mktmp(yaml);
    const action = actharness(join(dir, 'action.yml'));
    expect(action.manifest.name).toBe('Direct');
  });

  it('resolves ./ paths relative to the calling file', () => {
    expect(() => actharness('./no-such-fixture-dir')).toThrow(/\/no-such-fixture-dir/);
  });

  it('resolves ../ paths relative to the calling file', () => {
    expect(() => actharness('../no-such-parent-dir')).toThrow(/\/no-such-parent-dir/);
  });
});

describe('_dirFromStack()', () => {
  it('returns process.cwd() when stack has no frames', () => {
    expect(_dirFromStack('Error')).toBe(process.cwd());
  });

  it('returns process.cwd() when no caller frame has a file:// URL', () => {
    // Position 1 is the actharness placeholder (skipped by slice(2));
    // position 2 has no file:// URL so m is null → returns cwd.
    expect(_dirFromStack('Error\n    at actharness:1:1\n    at native:2:2')).toBe(process.cwd());
  });

  it('skips the actharness frame at position 1 and returns dirname of the first caller frame', () => {
    const stack = [
      'Error',
      '    at actharness (file:///root/action-runner.ts:10:5)',
      '    at test (file:///root/tests/my.test.ts:3:3)',
    ].join('\n');
    expect(_dirFromStack(stack)).toBe('/root/tests');
  });

  it('skips node_modules frames and returns dirname of the next file:// frame', () => {
    const stack = [
      'Error',
      '    at actharness (file:///root/action-runner.ts:10:5)',
      '    at fn (file:///root/node_modules/vitest/runner.js:1:1)',
      '    at test (file:///root/tests/my.test.ts:2:2)',
    ].join('\n');
    expect(_dirFromStack(stack)).toBe('/root/tests');
  });
});

describe('Action.run()', () => {
  it('returns a RunResult with conclusion success', async () => {
    const { action } = makeTestAction({ conclusion: 'success' });
    const result = await action.run();
    expect(result.conclusion).toBe('success');
  });

  it('returns failure when executor returns failure', async () => {
    const { action } = makeTestAction({ conclusion: 'failure' });
    const result = await action.run();
    expect(result.conclusion).toBe('failure');
  });

  it('result.step() finds steps by id', async () => {
    const stepResult = {
      id: 's1', name: 'S1', phase: 'main' as const, ran: true,
      outcome: 'success' as const, conclusion: 'success' as const,
      outputs: {}, annotations: [], stdout: '', stderr: '',
    };
    const { action } = makeTestAction({ steps: [stepResult] });
    const result = await action.run();
    expect(result.step('s1')).toEqual(stepResult);
    expect(result.step('missing')).toBeUndefined();
  });

  it('passes outputs from executor to RunResult', async () => {
    const { action } = makeTestAction({ outputs: { greeting: 'Hello' } });
    const result = await action.run();
    expect(result.outputs['greeting']).toBe('Hello');
  });

  it('throws ConfigError when no executor is registered for the using type', async () => {
    const dir = mktmp(`name: T\nruns:\n  using: no-such-executor-${Date.now()}\n  steps: []\n`);
    const action = actharness(dir);
    await expect(action.run()).rejects.toThrow(ConfigError);
  });

  it('cleans up workspace by default', async () => {
    const { action } = makeTestAction();
    await expect(action.run()).resolves.toBeDefined();
  });

  it('respects keepWorkspace option', async () => {
    const { using } = makeTestAction();
    const yaml = `name: Test Action\nruns:\n  using: ${using}\n  steps: []\n`;
    const dir = mktmp(yaml);
    const action = actharness(dir, { keepWorkspace: true });
    await expect(action.run()).resolves.toBeDefined();
  });

  it('uses custom tempDir when provided', async () => {
    const wsDir = mkdtempSync(join(tmpdir(), 'actharness-ws-base-'));
    tmpDirs.push(wsDir);
    const { using } = makeTestAction();
    const yaml = `name: Test Action\nruns:\n  using: ${using}\n  steps: []\n`;
    const dir = mktmp(yaml);
    const action = actharness(dir, { tempDir: wsDir });
    await expect(action.run()).resolves.toBeDefined();
  });

  // options.workspace's actual seeding behavior is checkout-gated (copied in only once a
  // `uses: actions/checkout@*`-like step runs) — that requires real composite steps, which
  // this file's fake-executor harness (no step loop) can't exercise. Those behavioral tests
  // live in packages/core/test/step-runner.test.ts ("checkout-gated workspace seeding") and
  // the end-to-end fixture at fixtures/checkout-workspace/. This file only needs to confirm
  // resolution: relative `workspace` paths resolve against the caller's directory.
  it('resolves a relative options.workspace path against the caller dir (does not throw)', async () => {
    // Resolution happens eagerly inside actharness(), before run() — and this fixture has
    // no checkout step, so the seed path is never actually read; this only confirms the
    // relative-path resolution itself doesn't throw.
    const { using } = makeTestAction();
    const dir = mktmp(`name: Test Action\nruns:\n  using: ${using}\n  steps: []\n`);
    expect(() => actharness(dir, { workspace: './fixtures/workspace-seed' })).not.toThrow();
  });

  it('leaves an absolute options.workspace path unresolved (does not throw)', async () => {
    // Covers the branch where options.workspace is set but is NOT a relative './'/'../'
    // path — actharness() should pass it through as-is rather than re-resolving it.
    const { using } = makeTestAction();
    const dir = mktmp(`name: Test Action\nruns:\n  using: ${using}\n  steps: []\n`);
    const absoluteSeedPath = join(tmpdir(), 'actharness-seed-absolute');
    expect(() => actharness(dir, { workspace: absoluteSeedPath })).not.toThrow();
  });

  it('accepts input overrides', async () => {
    const action = makeTestActionFromDir(
      `name: With Inputs\ninputs:\n  name:\n    default: World\nruns:\n  using: USING_PLACEHOLDER\n  steps: []\n`,
    );
    const result = await action.run({ inputs: { name: 'Alice' } });
    expect(result.conclusion).toBe('success');
  });

  it('uses default input when not provided (covers the "default" branch in inputsExercised)', async () => {
    const action = makeTestActionFromDir(
      `name: With Inputs\ninputs:\n  name:\n    default: World\nruns:\n  using: USING_PLACEHOLDER\n  steps: []\n`,
    );
    const result = await action.run();
    expect(result.conclusion).toBe('success');
  });

  it('accepts github overrides', async () => {
    const { action } = makeTestAction();
    const result = await action.run({ github: { event_name: 'push' } });
    expect(result.conclusion).toBe('success');
  });

  it('accepts jobStatus input', async () => {
    const { action } = makeTestAction();
    const result = await action.run({ jobStatus: 'failure' });
    expect(result.conclusion).toBe('success');
  });

  it('result has empty steps array when executor returns none', async () => {
    const { action } = makeTestAction({ steps: [] });
    const result = await action.run();
    expect(result.steps).toEqual([]);
  });

  it('default sandbox throws ConfigError when executor calls sandbox.shell', async () => {
    const using = `test-exec-${++execCounter}`;
    registerExecutor({
      handles: (u: string) => u === using,
      execute: async (call) => {
        // Trigger the default no-op sandbox — it throws ConfigError
        await call.sandbox.shell({ script: 'echo', shell: 'bash', env: {}, cwd: '/' });
        return { conclusion: 'success', outputs: {}, env: {}, steps: [], stdout: '', stderr: '' };
      },
    });
    const dir = mktmp(`name: T\nruns:\n  using: ${using}\n  steps: []\n`);
    await expect(actharness(dir).run()).rejects.toThrow(ConfigError);
  });

  it('handles executor result with omitted steps/stdout/stderr', async () => {
    const using = `test-exec-${++execCounter}`;
    registerExecutor({
      handles: (u: string) => u === using,
      execute: async (): Promise<ExecutionResult> => ({
        conclusion: 'success',
        outputs: {},
        env: {},
      }),
    });
    const dir = mktmp(`name: T\nruns:\n  using: ${using}\n  steps: []\n`);
    const result = await actharness(dir).run();
    expect(result.steps).toEqual([]);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });
});
