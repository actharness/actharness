import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParsedStep } from '@actharness/types';
import { runSteps } from '../src/step-runner.js';
import type { StepRunnerOptions } from '../src/step-runner.js';
import { createContextStore, buildContexts } from '../src/context.js';
import { createJobStatus, FROZEN_EPOCH } from '../src/determinism.js';
import { MockRegistry } from '../src/mock-resolver.js';
import { ScopeRegistry, scopeALS } from '../src/mock-scope.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MINIMAL_ACTION = { name: 'T', runs: { using: 'composite', steps: [] as ParsedStep[] } };

function makeStore(overrides: { os?: string; env?: Record<string, string>; secrets?: Record<string, string> } = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
  const jobStatus = createJobStatus();
  const { github, runner, inputs, env, secrets, matrix, needs } = buildContexts(
    MINIMAL_ACTION,
    {},
    ws,
    '1',
    FROZEN_EPOCH,
    jobStatus,
  );
  return createContextStore({
    github,
    runner: overrides.os ? { ...runner, os: overrides.os } : runner,
    inputs,
    env: { ...env, ...overrides.env },
    secrets: { ...secrets, ...overrides.secrets },
    matrix,
    needs,
    jobStatus,
  });
}

function makeSandbox(exitCode = 0, stdout = '', stderr = '') {
  return {
    shell: vi.fn().mockResolvedValue({ exitCode, stdout, stderr, timedOut: false }),
  };
}

function makeOpts(overrides: Partial<StepRunnerOptions> = {}): StepRunnerOptions {
  return {
    workspace: mkdtempSync(join(tmpdir(), 'actharness-ws-')),
    actionDir: '/fake',
    sandbox: makeSandbox(),
    mocks: new MockRegistry(),
    actharnessOptions: {},
    dispatch: vi.fn().mockResolvedValue({ conclusion: 'success', outputs: {}, env: {}, steps: [], stdout: '', stderr: '' }),
    cycleGuard: ['/fake'],
    depth: 0,
    ...overrides,
  };
}

function step(overrides: Partial<ParsedStep>): ParsedStep {
  return { ...overrides } as ParsedStep;
}

// ── runSteps() ────────────────────────────────────────────────────────────────

describe('runSteps — empty steps', () => {
  it('returns empty result for no steps', async () => {
    const result = await runSteps([], makeStore(), makeOpts());
    expect(result.steps).toHaveLength(0);
    expect(result.annotations).toHaveLength(0);
  });

  it('step with neither run nor uses is a no-op and succeeds', async () => {
    const result = await runSteps([step({ id: 's1' })], makeStore(), makeOpts());
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.conclusion).toBe('success');
  });
});

describe('runSteps — skipped steps', () => {
  it('skips step when if: evaluates to false', async () => {
    const result = await runSteps([step({ id: 's1', if: 'false' })], makeStore(), makeOpts());
    expect(result.steps[0]?.conclusion).toBe('skipped');
    expect(result.steps[0]?.ran).toBe(false);
  });

  it('skips step when if: expression throws', async () => {
    // '(' causes parse error → evalExpression throws → shouldRun=false
    const result = await runSteps([step({ id: 's1', if: '(' })], makeStore(), makeOpts());
    expect(result.steps[0]?.conclusion).toBe('skipped');
  });

  it('updates steps context on skip when id is set', async () => {
    const store = makeStore();
    await runSteps([step({ id: 's1', if: 'false' })], store, makeOpts());
    expect(store.steps['s1']?.conclusion).toBe('skipped');
  });

  it('uses auto-generated id when step has no id', async () => {
    const result = await runSteps([step({ if: 'false' })], makeStore(), makeOpts());
    expect(result.steps[0]?.id).toBe('__step_1__');
  });

  it('runs step when if: is absent (defaults to success())', async () => {
    const sandbox = makeSandbox();
    const result = await runSteps([step({ id: 's1', run: 'echo hi', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.steps[0]?.conclusion).toBe('success');
    expect(result.steps[0]?.ran).toBe(true);
  });
});

describe('runSteps — run: steps', () => {
  it('runs a shell step and returns success', async () => {
    const sandbox = makeSandbox(0, 'hello\n', '');
    const result = await runSteps([step({ id: 's1', run: 'echo hello', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.steps[0]?.conclusion).toBe('success');
    expect(result.steps[0]?.ran).toBe(true);
  });

  it('marks step as failure when shell returns non-zero exit code', async () => {
    const result = await runSteps([step({ id: 's1', run: 'false', shell: 'bash' })], makeStore(), makeOpts({ sandbox: makeSandbox(1) }));
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('uses default shell (bash) on non-Windows when no shell specified', async () => {
    const sandbox = makeSandbox();
    await runSteps([step({ id: 's1', run: 'echo hi' })], makeStore({ os: 'Linux' }), makeOpts({ sandbox }));
    expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({ shell: 'bash' }));
  });

  it('uses pwsh on Windows when no shell specified', async () => {
    const sandbox = makeSandbox();
    await runSteps([step({ id: 's1', run: 'Write-Host hi' })], makeStore({ os: 'Windows' }), makeOpts({ sandbox }));
    expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({ shell: 'pwsh' }));
  });

  it('uses default shell from actharnessOptions when set', async () => {
    const sandbox = makeSandbox();
    await runSteps([step({ id: 's1', run: 'echo hi' })], makeStore(), makeOpts({ sandbox, actharnessOptions: { shell: { default: 'sh' } } }));
    expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({ shell: 'sh' }));
  });

  it('evaluates step env vars as templates', async () => {
    const sandbox = makeSandbox();
    await runSteps(
      [step({ id: 's1', run: 'echo hi', shell: 'bash', env: { STEP_VAR: '${{ env.MY_VAR }}' } })],
      makeStore({ env: { MY_VAR: 'hi' } }),
      makeOpts({ sandbox }),
    );
    expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({
      env: expect.objectContaining({ STEP_VAR: 'hi' }),
    }));
  });

  it('resolves working-directory relative to workspace', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const subdir = join(workspace, 'sub');
    mkdirSync(subdir, { recursive: true });
    const sandbox = makeSandbox();
    try {
      await runSteps(
        [step({ id: 's1', run: 'echo hi', shell: 'bash', 'working-directory': 'sub' })],
        makeStore(),
        makeOpts({ workspace, sandbox }),
      );
      expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({ cwd: subdir }));
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it('sets timeout in ms from timeout-minutes', async () => {
    const sandbox = makeSandbox();
    const result = await runSteps(
      [step({ id: 's1', run: 'echo hi', shell: 'bash', 'timeout-minutes': 1 })],
      makeStore(),
      makeOpts({ sandbox }),
    );
    expect(sandbox.shell).toHaveBeenCalledWith(expect.objectContaining({ timeout: 60000 }));
    expect(result.steps[0]?.timeout).toEqual({ minutes: 1, timedOut: false });
  });

  it('marks timedOut=true when sandbox returns timedOut', async () => {
    const sandbox = { shell: vi.fn().mockResolvedValue({ exitCode: 124, stdout: '', stderr: '', timedOut: true }) };
    const result = await runSteps(
      [step({ id: 's1', run: 'sleep 100', shell: 'bash', 'timeout-minutes': 0.001 })],
      makeStore(),
      makeOpts({ sandbox }),
    );
    expect(result.steps[0]?.timeout?.timedOut).toBe(true);
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('captures legacy ::set-output:: stdout command', async () => {
    const sandbox = makeSandbox(0, '::set-output name=greeting::hello\n');
    const result = await runSteps([step({ id: 's1', run: 'echo', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.steps[0]?.outputs['greeting']).toBe('hello');
  });

  it('continue-on-error: true makes conclusion success even on failure', async () => {
    const result = await runSteps(
      [step({ id: 's1', run: 'false', shell: 'bash', 'continue-on-error': true })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox(1) }),
    );
    expect(result.steps[0]?.outcome).toBe('failure');
    expect(result.steps[0]?.conclusion).toBe('success');
  });

  it('continue-on-error as truthy expression string', async () => {
    const result = await runSteps(
      [step({ id: 's1', run: 'false', shell: 'bash', 'continue-on-error': 'true' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox(1) }),
    );
    expect(result.steps[0]?.conclusion).toBe('success');
  });

  it('continue-on-error as falsy expression string', async () => {
    const result = await runSteps(
      [step({ id: 's1', run: 'false', shell: 'bash', 'continue-on-error': 'false' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox(1) }),
    );
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('continue-on-error expression that throws falls back to false', async () => {
    // '(' causes parse error → evalExpression throws → continueOnError=false
    const result = await runSteps(
      [step({ id: 's1', run: 'false', shell: 'bash', 'continue-on-error': '(' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox(1) }),
    );
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('includes render info in step result', async () => {
    const result = await runSteps(
      [step({ id: 's1', run: 'echo hi', shell: 'bash' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox() }),
    );
    expect(result.steps[0]?.render).toBeDefined();
    expect(result.steps[0]?.render?.script).toContain('echo hi');
  });

  it('catches sandbox throw and marks step as failure', async () => {
    const sandbox = { shell: vi.fn().mockRejectedValue(new Error('sandbox crashed')) };
    const result = await runSteps([step({ id: 's1', run: 'echo hi', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('uses step name when provided', async () => {
    const result = await runSteps(
      [step({ id: 's1', name: 'My Step', run: 'echo hi', shell: 'bash' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox() }),
    );
    expect(result.steps[0]?.name).toBe('My Step');
  });

  it('derives step name from run content when no name', async () => {
    const result = await runSteps(
      [step({ run: 'echo hello world', shell: 'bash' })],
      makeStore(),
      makeOpts({ sandbox: makeSandbox() }),
    );
    expect(result.steps[0]?.name).toContain('echo hello world');
  });

  it('accumulates stdout across multiple steps', async () => {
    const sandbox = makeSandbox(0, 'line\n');
    const result = await runSteps([
      step({ id: 's1', run: 'echo', shell: 'bash' }),
      step({ id: 's2', run: 'echo', shell: 'bash' }),
    ], makeStore(), makeOpts({ sandbox }));
    expect(result.stdout).toBe('line\nline\n');
  });

  it('updates steps context in store when id is set', async () => {
    const store = makeStore();
    await runSteps([step({ id: 's1', run: 'echo hi', shell: 'bash' })], store, makeOpts({ sandbox: makeSandbox() }));
    expect(store.steps['s1']?.conclusion).toBe('success');
    expect(store.steps['s1']?.outputs).toBeDefined();
  });

  it('does not add step entry to store when id is absent', async () => {
    const store = makeStore();
    await runSteps([step({ run: 'echo hi', shell: 'bash' })], store, makeOpts({ sandbox: makeSandbox() }));
    expect(Object.keys(store.steps)).toHaveLength(0);
  });
});

describe('runSteps — uses: steps', () => {
  it('uses mocked action and records call', async () => {
    const scope = new ScopeRegistry();
    const mockHandle = scope.mock('actions/checkout@v4', { outputs: { sha: 'abc123' } });
    const result = await scopeALS.run([scope], () =>
      runSteps(
        [step({ id: 's1', uses: 'actions/checkout@v4', with: { depth: '1' } })],
        makeStore(),
        makeOpts(),
      ),
    );
    expect(result.steps[0]?.conclusion).toBe('success');
    expect(result.steps[0]?.uses?.mocked).toBe(true);
    expect(mockHandle.callCount).toBe(1);
  });

  it('mock with conclusion failure sets step as failure', async () => {
    const scope = new ScopeRegistry();
    scope.mock('actions/checkout@v4', { conclusion: 'failure' });
    const result = await scopeALS.run([scope], () =>
      runSteps([step({ id: 's1', uses: 'actions/checkout@v4' })], makeStore(), makeOpts()),
    );
    expect(result.steps[0]?.conclusion).toBe('failure');
  });

  it('noop action emits warning annotation and returns success', async () => {
    const result = await runSteps(
      [step({ id: 's1', uses: 'actions/checkout@v4' })],
      makeStore(),
      makeOpts(),
    );
    expect(result.steps[0]?.conclusion).toBe('success');
    expect(result.annotations.some((a) => a.level === 'warning')).toBe(true);
  });

  it('evaluates step env for uses: step', async () => {
    const scope = new ScopeRegistry();
    const handle = scope.mock('actions/test@v1', {});
    const store = makeStore({ env: { BASE: 'myval' } });
    await scopeALS.run([scope], () =>
      runSteps([step({ id: 's1', uses: 'actions/test@v1', env: { STEP_ENV: '${{ env.BASE }}' } })], store, makeOpts()),
    );
    expect(handle.calls[0]?.env).toMatchObject({ STEP_ENV: 'myval' });
  });

  it('evaluates with: inputs as templates', async () => {
    const scope = new ScopeRegistry();
    const handle = scope.mock('actions/test@v1', {});
    const store = makeStore({ env: { BRANCH: 'main' } });
    await scopeALS.run([scope], () =>
      runSteps([step({ id: 's1', uses: 'actions/test@v1', with: { ref: '${{ env.BRANCH }}' } })], store, makeOpts()),
    );
    expect(handle.calls[0]?.with).toMatchObject({ ref: 'main' });
  });

  it('records uses ref on step result', async () => {
    const scope = new ScopeRegistry();
    scope.mock('actions/checkout@v4', {});
    const result = await scopeALS.run([scope], () =>
      runSteps([step({ id: 's1', uses: 'actions/checkout@v4' })], makeStore(), makeOpts()),
    );
    expect(result.steps[0]?.uses?.ref).toBe('actions/checkout@v4');
  });

  it('derives step name from uses ref when no name set', async () => {
    const scope = new ScopeRegistry();
    scope.mock('actions/checkout@v4', {});
    const result = await scopeALS.run([scope], () =>
      runSteps([step({ uses: 'actions/checkout@v4' })], makeStore(), makeOpts()),
    );
    expect(result.steps[0]?.name).toBe('actions/checkout@v4');
  });

  it('uses: mock propagates outputs to step outputs', async () => {
    const scope = new ScopeRegistry();
    scope.mock('actions/checkout@v4', { outputs: { sha: 'deadbeef' } });
    const result = await scopeALS.run([scope], () =>
      runSteps([step({ id: 's1', uses: 'actions/checkout@v4' })], makeStore(), makeOpts()),
    );
    expect(result.steps[0]?.outputs['sha']).toBe('deadbeef');
  });
});

describe('runSteps — checkout-gated workspace seeding (options.workspace)', () => {
  it('does not seed the workspace before a checkout-like step runs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'actharness-seed-'));
    writeFileSync(join(seedDir, 'seeded.txt'), 'hello');

    let entriesBeforeCheckout: string[] = [];
    const sandbox = {
      shell: vi.fn().mockImplementation(async () => {
        const { readdirSync } = await import('node:fs');
        entriesBeforeCheckout = readdirSync(workspace);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    };

    await runSteps(
      [
        step({ id: 'before', run: 'echo pre-checkout', shell: 'bash' }),
        step({ id: 'checkout', uses: 'actions/checkout@v4' }),
      ],
      makeStore(),
      makeOpts({ workspace, sandbox, actharnessOptions: { workspace: seedDir } }),
    );

    expect(entriesBeforeCheckout).toEqual([]);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  });

  it('seeds the workspace once the checkout-like step runs', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'actharness-seed-'));
    writeFileSync(join(seedDir, 'seeded.txt'), 'hello-from-seed');

    let seededContentAfterCheckout = '';
    const sandbox = {
      shell: vi.fn().mockImplementation(async () => {
        const { readFileSync } = await import('node:fs');
        seededContentAfterCheckout = readFileSync(join(workspace, 'seeded.txt'), 'utf8');
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    };

    await runSteps(
      [
        step({ id: 'checkout', uses: 'actions/checkout@v4' }),
        step({ id: 'after', run: 'cat seeded.txt', shell: 'bash' }),
      ],
      makeStore(),
      makeOpts({ workspace, sandbox, actharnessOptions: { workspace: seedDir } }),
    );

    expect(seededContentAfterCheckout).toBe('hello-from-seed');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  });

  it('does not seed when the action has no checkout-like step at all', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'actharness-seed-'));
    writeFileSync(join(seedDir, 'seeded.txt'), 'hello');

    await runSteps(
      [step({ id: 's1', run: 'echo no-checkout-here', shell: 'bash' })],
      makeStore(),
      makeOpts({ workspace, actharnessOptions: { workspace: seedDir } }),
    );

    const { readdirSync } = await import('node:fs');
    expect(readdirSync(workspace)).toEqual([]);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  });

  it('fails the checkout step with a ConfigError when options.workspace does not exist', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const missing = join(tmpdir(), `actharness-missing-${Date.now()}`);

    // The step loop catches errors per-step (consistent with how any other step error is
    // handled) rather than rejecting runSteps() itself — so a bad seed path fails just the
    // checkout step, with the ConfigError message surfaced in that step's stderr.
    const result = await runSteps(
      [step({ id: 'checkout', uses: 'actions/checkout@v4' })],
      makeStore(),
      makeOpts({ workspace, actharnessOptions: { workspace: missing } }),
    );
    expect(result.steps[0]?.conclusion).toBe('failure');
    expect(result.steps[0]?.stderr).toMatch(/does not exist/);
    rmSync(workspace, { recursive: true, force: true });
  });

  it('fails the checkout step with a ConfigError when options.workspace is a file, not a directory', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const seedParent = mkdtempSync(join(tmpdir(), 'actharness-seed-'));
    const filePath = join(seedParent, 'not-a-dir.txt');
    writeFileSync(filePath, 'x');

    const result = await runSteps(
      [step({ id: 'checkout', uses: 'actions/checkout@v4' })],
      makeStore(),
      makeOpts({ workspace, actharnessOptions: { workspace: filePath } }),
    );
    expect(result.steps[0]?.conclusion).toBe('failure');
    expect(result.steps[0]?.stderr).toMatch(/must be a directory/);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(seedParent, { recursive: true, force: true });
  });

  it('leaves the seed-source directory untouched after seeding', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const seedDir = mkdtempSync(join(tmpdir(), 'actharness-seed-'));
    writeFileSync(join(seedDir, 'seeded.txt'), 'hello');

    await runSteps(
      [step({ id: 'checkout', uses: 'actions/checkout@v4' })],
      makeStore(),
      makeOpts({ workspace, actharnessOptions: { workspace: seedDir } }),
    );

    const { readFileSync, existsSync } = await import('node:fs');
    expect(existsSync(join(seedDir, 'seeded.txt'))).toBe(true);
    expect(readFileSync(join(seedDir, 'seeded.txt'), 'utf8')).toBe('hello');
    rmSync(workspace, { recursive: true, force: true });
    rmSync(seedDir, { recursive: true, force: true });
  });
});

describe('runSteps — protocol / env propagation', () => {
  it('propagates env from GITHUB_ENV file to subsequent steps', async () => {
    let callCount = 0;
    const sandbox = {
      shell: vi.fn().mockImplementation(async (opts: { env: Record<string, string> }) => {
        callCount++;
        if (callCount === 1) {
          writeFileSync(opts.env['GITHUB_ENV']!, 'MY_KEY=from-step-1\n');
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    };
    await runSteps([
      step({ id: 's1', run: 'echo MY_KEY=from-step-1 >> $GITHUB_ENV', shell: 'bash' }),
      step({ id: 's2', run: 'echo $MY_KEY', shell: 'bash' }),
    ], makeStore(), makeOpts({ sandbox }));
    const secondCall = sandbox.shell.mock.calls[1]?.[0] as { env: Record<string, string> };
    expect(secondCall?.env?.['MY_KEY']).toBe('from-step-1');
  });

  it('collects annotations from ::error:: commands', async () => {
    const sandbox = makeSandbox(0, '::error file=src/foo.ts,line=10::Something broke\n');
    const result = await runSteps([step({ id: 's1', run: 'echo', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.annotations.some((a) => a.level === 'error')).toBe(true);
  });

  it('collects ::warning:: annotations', async () => {
    const sandbox = makeSandbox(0, '::warning::Watch out\n');
    const result = await runSteps([step({ id: 's1', run: 'echo', shell: 'bash' })], makeStore(), makeOpts({ sandbox }));
    expect(result.annotations.some((a) => a.level === 'warning')).toBe(true);
  });

  it('collects add-mask commands', async () => {
    const sandbox = makeSandbox(0, '::add-mask::secretvalue\n');
    const store = makeStore();
    await runSteps([step({ id: 's1', run: 'echo', shell: 'bash' })], store, makeOpts({ sandbox }));
    expect(store.masks.has('secretvalue')).toBe(true);
  });

  it('masks provided secret values in captured stdout and stderr', async () => {
    const sandbox = makeSandbox(0, 'token: myplaintexttoken\n', 'error: myplaintexttoken\n');
    const store = makeStore({ secrets: { API_TOKEN: 'myplaintexttoken' } });
    const result = await runSteps([step({ id: 's1', run: 'echo', shell: 'bash' })], store, makeOpts({ sandbox }));
    expect(result.steps[0]!.stdout).toBe('token: ***\n');
    expect(result.steps[0]!.stderr).toBe('error: ***\n');
  });

  it('does not mask secret values in the script passed to the sandbox', async () => {
    const sandbox = makeSandbox();
    const store = makeStore({ secrets: { API_TOKEN: 'myplaintexttoken' } });
    await runSteps([step({ id: 's1', run: 'curl -H "Authorization: Bearer myplaintexttoken"', shell: 'bash' })], store, makeOpts({ sandbox }));
    const calledScript = (sandbox.shell.mock.calls[0]?.[0] as { script: string }).script;
    expect(calledScript).toContain('myplaintexttoken');
  });

  it('prepends ::add-path:: entries to PATH for subsequent steps', async () => {
    let callCount = 0;
    const sandbox = {
      shell: vi.fn().mockImplementation(async () => {
        callCount++;
        const stdout = callCount === 1 ? '::add-path::/custom/bin\n' : '';
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      }),
    };
    await runSteps([
      step({ id: 's1', run: 'echo', shell: 'bash' }),
      step({ id: 's2', run: 'echo', shell: 'bash' }),
    ], makeStore(), makeOpts({ sandbox }));
    const secondCall = sandbox.shell.mock.calls[1]?.[0] as { env: Record<string, string> };
    expect(secondCall?.env?.['PATH']).toContain('/custom/bin');
  });

  it('prepends ::add-path:: with empty existing PATH omits trailing separator', async () => {
    let callCount = 0;
    const sandbox = {
      shell: vi.fn().mockImplementation(async () => {
        callCount++;
        const stdout = callCount === 1 ? '::add-path::/injected\n' : '';
        return { exitCode: 0, stdout, stderr: '', timedOut: false };
      }),
    };
    // store.env.PATH = '' → currentPath is '' → ternary takes [] branch → no separator
    await runSteps([
      step({ id: 's1', run: 'echo', shell: 'bash' }),
      step({ id: 's2', run: 'echo', shell: 'bash' }),
    ], makeStore({ env: { PATH: '' } }), makeOpts({ sandbox }));
    const secondCall = sandbox.shell.mock.calls[1]?.[0] as { env: Record<string, string> };
    expect(secondCall?.env?.['PATH']).toBe('/injected');
  });

  it('prepends ::add-path:: falls back to empty string when PATH absent everywhere', async () => {
    const savedPath = process.env['PATH'];
    delete process.env['PATH'];
    try {
      let callCount = 0;
      const sandbox = {
        shell: vi.fn().mockImplementation(async () => {
          callCount++;
          const stdout = callCount === 1 ? '::add-path::/injected\n' : '';
          return { exitCode: 0, stdout, stderr: '', timedOut: false };
        }),
      };
      // store.env.PATH undefined, process.env.PATH undefined → currentPath = '' → [] branch
      await runSteps([
        step({ id: 's1', run: 'echo', shell: 'bash' }),
        step({ id: 's2', run: 'echo', shell: 'bash' }),
      ], makeStore(), makeOpts({ sandbox }));
      const secondCall = sandbox.shell.mock.calls[1]?.[0] as { env: Record<string, string> };
      expect(secondCall?.env?.['PATH']).toBe('/injected');
    } finally {
      if (savedPath !== undefined) process.env['PATH'] = savedPath;
    }
  });

  it('reads GITHUB_OUTPUT protocol file for step outputs', async () => {
    const sandbox = {
      shell: vi.fn().mockImplementation(async (opts: { env: Record<string, string> }) => {
        writeFileSync(opts.env['GITHUB_OUTPUT']!, 'greeting=hello\n');
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    };
    const result = await runSteps(
      [step({ id: 's1', run: 'echo greeting=hello >> $GITHUB_OUTPUT', shell: 'bash' })],
      makeStore(),
      makeOpts({ sandbox }),
    );
    expect(result.steps[0]?.outputs['greeting']).toBe('hello');
  });
});

describe('runSteps — real local uses: dispatch', () => {
  it('dispatches real local action via dispatch callback', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const childDir = join(workspace, 'child');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, 'action.yml'),
      'name: Child\nruns:\n  using: composite\n  steps: []\n',
    );
    const dispatch = vi.fn().mockResolvedValue({
      conclusion: 'success',
      outputs: { result: 'ok' },
      env: { NEW_VAR: 'yes' },
      steps: [],
      stdout: '',
      stderr: '',
    });
    const opts = makeOpts({ workspace, actionDir: workspace, dispatch, mocks: new MockRegistry() });
    const result = await runSteps([step({ id: 's1', uses: './child' })], makeStore(), opts);
    expect(result.steps[0]?.conclusion).toBe('success');
    expect(result.steps[0]?.uses?.mocked).toBe(false);
    expect(dispatch).toHaveBeenCalled();
    rmSync(workspace, { recursive: true, force: true });
  });

  it('marks step failure when real local dispatch returns failure', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'actharness-ws-'));
    const childDir = join(workspace, 'child');
    mkdirSync(childDir, { recursive: true });
    writeFileSync(
      join(childDir, 'action.yml'),
      'name: Child\nruns:\n  using: composite\n  steps: []\n',
    );
    const dispatch = vi.fn().mockResolvedValue({
      conclusion: 'failure',
      outputs: {},
      env: {},
      steps: [],
      stdout: '',
      stderr: '',
    });
    const opts = makeOpts({ workspace, actionDir: workspace, dispatch, mocks: new MockRegistry() });
    const result = await runSteps([step({ id: 's1', uses: './child' })], makeStore(), opts);
    expect(result.steps[0]?.conclusion).toBe('failure');
    rmSync(workspace, { recursive: true, force: true });
  });
});

describe('runSteps — shell coverage', () => {
  it('captures shellCoverage from sandbox result and sets it on the step result', async () => {
    const shellCoverage = { lineHits: { 1: 1 } };
    const sandbox = {
      shell: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '', timedOut: false, shellCoverage }),
    };
    const result = await runSteps(
      [step({ id: 's1', run: 'echo hi', shell: 'sh' })],
      makeStore(),
      makeOpts({ sandbox }),
    );
    expect(result.steps[0]?.shellCoverage).toEqual(shellCoverage);
  });
});

describe('runSteps — job status', () => {
  it('marks job as failed when step fails without continue-on-error', async () => {
    const store = makeStore();
    await runSteps([step({ id: 's1', run: 'false', shell: 'bash' })], store, makeOpts({ sandbox: makeSandbox(1) }));
    expect(store.jobStatus.failure).toBe(true);
    expect(store.jobStatus.success).toBe(false);
  });

  it('does not mark job as failed when continue-on-error is true', async () => {
    const store = makeStore();
    await runSteps(
      [step({ id: 's1', run: 'false', shell: 'bash', 'continue-on-error': true })],
      store,
      makeOpts({ sandbox: makeSandbox(1) }),
    );
    expect(store.jobStatus.failure).toBe(false);
  });

  it('step with if: always() runs after previous failure', async () => {
    let secondCallMade = false;
    const sandbox = {
      shell: vi.fn().mockImplementation(async () => {
        if (!secondCallMade) {
          secondCallMade = true;
          return { exitCode: 1, stdout: '', stderr: '', timedOut: false };
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false };
      }),
    };
    const result = await runSteps([
      step({ id: 's1', run: 'false', shell: 'bash' }),
      step({ id: 's2', run: 'echo hi', shell: 'bash', if: 'always()' }),
    ], makeStore(), makeOpts({ sandbox }));
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.conclusion).toBe('success');
  });

  it('step with if: success() is skipped after previous failure', async () => {
    const sandbox = {
      shell: vi.fn()
        .mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '', timedOut: false })
        .mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', timedOut: false }),
    };
    const result = await runSteps([
      step({ id: 's1', run: 'false', shell: 'bash' }),
      step({ id: 's2', run: 'echo hi', shell: 'bash' }),
    ], makeStore(), makeOpts({ sandbox }));
    expect(result.steps[1]?.conclusion).toBe('skipped');
  });
});
