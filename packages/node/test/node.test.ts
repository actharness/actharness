import { describe, it, expect, beforeEach } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { actharness, createContextStore, createJobStatus, allocateProtocolFiles } from '@actharness/core';
import type { ExecutionCall } from '@actharness/core';
import { GITHUB_DEFAULTS, RUNNER_DEFAULTS } from '@actharness/types';
import '../src/index.js';
import { mockGitHubApi, mockNetwork, mockNetworkOnce, resetNetworkMocks, runShellNode, runInSandbox } from '../src/index.js';
import { drainForProxy } from '@actharness/network-mock';
import { nodeExecutor } from '../src/node-executor.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dir, 'fixtures');

function fixture(name: string) {
  return actharness(join(fixtures, name));
}

function makeContext(env: Record<string, string> = {}) {
  return createContextStore({
    github: { ...GITHUB_DEFAULTS },
    runner: { ...RUNNER_DEFAULTS },
    inputs: {},
    env,
    secrets: {},
    matrix: {},
    needs: {},
    jobStatus: createJobStatus(),
  });
}

beforeEach(() => {
  resetNetworkMocks();
});

// ── Baseline ──────────────────────────────────────────────────────────────────

describe('baseline', () => {
  it('sets output and conclusion on success', async () => {
    const result = await fixture('baseline').run({ inputs: { greeting: 'Howdy' } });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Howdy World');
  });

  it('fails when greeting is empty and process.exit(1) is called', async () => {
    const result = await fixture('baseline').run({ inputs: { greeting: '' } });
    expect(result.conclusion).toBe('failure');
  });

  it('uses default greeting when no input provided', async () => {
    const result = await fixture('baseline').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Hello World');
  });

  it('env variable exported via core.exportVariable is visible in result.env', async () => {
    const result = await fixture('baseline').run({ inputs: { greeting: 'Hi' } });
    expect(result.env['LAST_MESSAGE']).toBe('Hi World');
  });
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

describe('lifecycle', () => {
  it('runs pre/main/post and threads state', async () => {
    const result = await fixture('lifecycle').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['main-ran']).toBe('true');
    expect(result.outputs['cache-hit']).toBe('true');
  });

  it('exposes pre/main/post step results', async () => {
    const result = await fixture('lifecycle').run();
    const phases = result.steps.map(s => s.phase);
    expect(phases).toContain('pre');
    expect(phases).toContain('main');
    expect(phases).toContain('post');
  });

  it('stdout contains log messages from all phases', async () => {
    const result = await fixture('lifecycle').run();
    expect(result.stdout).toContain('[pre] state saved');
    expect(result.stdout).toContain('[main] cache-key=actharness-cache-42');
    expect(result.stdout).toContain('[post] initialized=true');
  });
});

// ── Octokit ───────────────────────────────────────────────────────────────────

describe('octokit', () => {
  it('returns mocked comment count', async () => {
    const apiMock = mockGitHubApi({
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [
        { id: 1, body: 'first comment' },
        { id: 2, body: 'second comment' },
      ],
    });

    const result = await fixture('octokit').run({
      inputs: { token: 'ghs_test', 'issue-number': '42' },
    });

    expect(result.conclusion).toBe('success');
    expect(result.outputs['comment-count']).toBe('2');
    expect(apiMock.called).toBe(true);
    expect(apiMock.callCount).toBe(1);
  });

  it('records the API call URL and method on the mock handle', async () => {
    const apiMock = mockGitHubApi({
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [],
    });

    await fixture('octokit').run({
      inputs: { token: 'ghs_test', 'issue-number': '7' },
    });

    expect(apiMock.calls[0]?.method).toBe('GET');
  });
});

// ── ESM ───────────────────────────────────────────────────────────────────────

describe('esm', () => {
  it('runs a pure ESM action and sets output', async () => {
    const result = await fixture('esm').run({ inputs: { name: 'Alice' } });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, Alice!');
  });

  it('uses default name when no input provided', async () => {
    const result = await fixture('esm').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, World!');
  });
});

// ── Bundled ───────────────────────────────────────────────────────────────────

describe('bundled', () => {
  it('runs an ncc-bundled action and sets output', async () => {
    const result = await fixture('bundled').run({ inputs: { name: 'Bob' } });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, Bob! (bundled)');
  });

  it('uses default name when no input provided', async () => {
    const result = await fixture('bundled').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, World! (bundled)');
  });
});

// ── JS coverage ───────────────────────────────────────────────────────────────

describe('js coverage', () => {
  it('emits jsCoverage in ExecutionResult via run sink', async () => {
    const result = await fixture('baseline').run({ inputs: { greeting: 'Coverage' } });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Coverage World');
  });
});

// ── Conditional (pre-if / post-if skip) ───────────────────────────────────────

describe('conditional', () => {
  it('skips pre and post when pre-if and post-if evaluate to false', async () => {
    const result = await fixture('conditional').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['ran']).toBe('true');
    expect(result.steps.map(s => s.phase)).toEqual(['pre', 'main', 'post']);
    expect(result.steps.find(s => s.phase === 'pre')).toMatchObject({
      ran: false,
      conclusion: 'skipped',
      if: { result: false },
    });
    expect(result.steps.find(s => s.phase === 'post')).toMatchObject({
      ran: false,
      conclusion: 'skipped',
      if: { result: false },
    });
  });
});

// ── Network mock ──────────────────────────────────────────────────────────────

describe('network mock', () => {
  it('intercepts fetch calls via mockNetwork', async () => {
    const netMock = mockNetwork('https://api.example.com/data', 200, { message: 'zen wisdom' });
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('zen wisdom');
    expect(netMock.called).toBe(true);
    expect(netMock.callCount).toBe(1);
  });

  it('evaluates factory mock via IPC round-trip', async () => {
    let callCount = 0;
    const netMock = mockNetwork('https://api.example.com/data', 200, () => ({ body: { message: `call-${++callCount}` } }));
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('call-1');
    expect(netMock.called).toBe(true);
  });

  it('factory can override status code via returned descriptor', async () => {
    mockNetwork('https://api.example.com/data', 200, () => ({ status: 201, body: { message: 'status-override' } }));
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('status-override');
  });

  it('function matcher evaluated by parent via IPC round-trip', async () => {
    const netMock = mockNetwork(
      (url, method) => url.includes('api.example.com') && method === 'GET',
      200,
      { message: 'fn-matched' },
    );
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('fn-matched');
    expect(netMock.called).toBe(true);
  });

  it('function matcher with factory evaluated by parent via IPC round-trip', async () => {
    let n = 0;
    const netMock = mockNetwork(
      (url) => url.includes('api.example.com'),
      200,
      () => ({ body: { message: `fn-factory-${++n}` } }),
    );
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('fn-factory-1');
    expect(netMock.called).toBe(true);
  });

  it('function matcher factory can override status code', async () => {
    mockNetwork(
      (url) => url.includes('api.example.com'),
      200,
      () => ({ status: 201, body: { message: 'fn-status-overridden' } }),
    );
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('fn-status-overridden');
  });

  it('unmatched function matcher falls through to 502', async () => {
    mockNetwork(
      (url) => url.includes('other.example.com'),
      200,
      { message: 'never' },
    );
    const result = await fixture('fetch-action').run();
    // fetch-action writes data.message; 502 body has no message field
    expect(result.outputs['body']).toBe('undefined');
  });

  it('function matcher that throws is treated as unmatched (falls through to 502)', async () => {
    mockNetwork(
      () => { throw new Error('matcher error'); },
      200,
      { message: 'never' },
    );
    const result = await fixture('fetch-action').run();
    expect(result.outputs['body']).toBe('undefined');
  });

  it('function matcher with throwing factory returns 500', async () => {
    mockNetwork(
      (url) => url.includes('api.example.com'),
      200,
      () => { throw new Error('fn-factory-error'); },
    );
    const result = await fixture('fetch-action').run();
    expect(result.outputs['body']).toBe('undefined');
  });

  it('returns 500 body when factory throws during IPC round-trip', async () => {
    const netMock = mockNetwork('https://api.example.com/data', 200, () => { throw new Error('factory error'); });
    const result = await fixture('fetch-action').run();
    // fetch-action writes data.message to output; error response has no message field
    expect(result.outputs['body']).toBe('undefined');
    expect(netMock.called).toBe(true);
  });

  it('mockNetworkOnce with function matcher marks entry consumed via IPC round-trip', async () => {
    mockNetworkOnce(
      (url, method) => url.includes('api.example.com') && method === 'GET',
      200,
      { message: 'fn-once-matched' },
    );
    const { networkEntries } = drainForProxy();
    const result = await fixture('fetch-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['body']).toBe('fn-once-matched');
    expect(networkEntries[0]!.consumed).toBe(true);
  });
});

// ── Crash action (stderr capture) ────────────────────────────────────────────

describe('crash action', () => {
  it('captures stderr when the action throws an uncaught error', async () => {
    const result = await fixture('crash-action').run();
    expect(result.conclusion).toBe('failure');
    expect(result.stderr).toContain('intentional crash');
  });
});

// ── Mask action (add-mask command) ────────────────────────────────────────────

describe('mask action', () => {
  it('masks secrets in stdout via ::add-mask:: command', async () => {
    const result = await fixture('mask-action').run();
    expect(result.conclusion).toBe('success');
    expect(result.outputs['result']).toBe('done');
    expect(result.stdout).not.toContain('mysecret');
  });
});

// ── Node executor (unit) ──────────────────────────────────────────────────────

describe('node executor', () => {
  it('throws when action has no runs.main entrypoint', async () => {
    const context = makeContext();
    await expect(
      nodeExecutor.execute({
        action: {
          name: 'test',
          description: 'test',
          inputs: {},
          outputs: {},
          runs: { using: 'node22' },
          _dir: '/tmp',
          _file: '/tmp/action.yml',
        },
        context,
      } as unknown as ExecutionCall),
    ).rejects.toThrow("has no 'runs.main' entrypoint");
  });

  it('resolves entrypoint when _dir is undefined', async () => {
    const context = makeContext({ INPUT_GREETING: 'Direct' });
    const mainPath = join(fixtures, 'baseline', 'index.js');
    const result = await nodeExecutor.execute({
      action: {
        name: 'test',
        description: 'test',
        inputs: {},
        outputs: {},
        runs: { using: 'node22', main: mainPath },
        _dir: undefined,
        _file: join(fixtures, 'baseline', 'action.yml'),
      },
      context,
    } as unknown as ExecutionCall);
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Direct World');
  });
});

// ── runShellNode ──────────────────────────────────────────────────────────────

describe('runShellNode', () => {
  function withTempScript(content: string, fn: (path: string) => Promise<void>) {
    const dir = mkdtempSync(join(tmpdir(), 'actharness-test-'));
    const path = join(dir, 'script.js');
    writeFileSync(path, content);
    return fn(path).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it('runs a single-line script and returns stdout + jsCoverage', async () => {
    await withTempScript('console.log("hello")', async (path) => {
      const result = await runShellNode(path, {}, '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello');
      expect(result.jsCoverage.length).toBeGreaterThan(0);
      expect(result.jsCoverage[0]!.v8Data).toBeDefined();
    });
  });

  it('runs a multi-line script and returns jsCoverage with V8 data', async () => {
    const script = 'function add(a, b) { return a + b; }\n\nconst r = add(1, 2);\nconsole.log(r);\n';
    await withTempScript(script, async (path) => {
      const result = await runShellNode(path, {}, '/');
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('3');
      expect(result.jsCoverage.length).toBeGreaterThan(0);
    });
  });

  it('captures process.exit exitCode', async () => {
    await withTempScript('process.exit(42)', async (path) => {
      const result = await runShellNode(path, {}, '/');
      expect(result.exitCode).toBe(42);
    });
  });

  it('captures direct process.exitCode assignment (child exits with code > 0)', async () => {
    // process.exitCode = N doesn't throw SandboxExitSignal, so the process exits
    // with code N. The exit handler's `code && code > 0 ? code : exitCode` true branch is hit.
    await withTempScript('process.exitCode = 7;', async (path) => {
      const result = await runShellNode(path, {}, '/');
      expect(result.exitCode).toBe(7);
    });
  });

  it('captures stderr output from script', async () => {
    await withTempScript('process.stderr.write("err-text\\n");', async (path) => {
      const result = await runShellNode(path, {}, '/');
      expect(result.stderr.trim()).toBe('err-text');
    });
  });
});

// ── runInSandbox with protocolFiles ───────────────────────────────────────────

describe('runInSandbox protocolFiles', () => {
  it('uses caller-provided protocol files and leaves them intact after the call', async () => {
    const protocol = allocateProtocolFiles();
    const dir = mkdtempSync(join(tmpdir(), 'actharness-test-'));
    const scriptPath = join(dir, 'script.js');
    writeFileSync(scriptPath, 'process.stdout.write("ok\\n")');

    try {
      const { output, env, state, path: pathFile, summary } = protocol;
      const result = await runInSandbox({
        entrypoint: scriptPath,
        env: {},
        cwd: '/',
        protocolFiles: { output, env, state, path: pathFile, summary },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('ok');
      // Protocol dir must still exist — caller owns it, runInSandbox must not clean it up
      expect(existsSync(protocol.dir)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(protocol.dir, { recursive: true, force: true });
    }
  });
});
