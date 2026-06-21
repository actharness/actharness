// Unit tests for ShellSandbox — real shell processes (sh, python3, node, {0}, timeout).
// No mocking: all processes run for real on this machine.

import { describe, it, expect, beforeEach } from 'vitest';
import { ShellSandbox } from '../src/shell-sandbox.js';
import { mockNetwork, resetNetworkMocks } from '@actharness/network-mock';

describe('ShellSandbox — shell types (real processes)', () => {
  it('sh shell runs a script', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'echo hello', shell: 'sh', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.timedOut).toBe(false);
  });

  it('bash shell runs a script', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'echo hello-bash', shell: 'bash', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-bash');
  });

  it('python3 shell runs a .py script', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'print("hello from python")',
      shell: 'python3',
      env: {},
      cwd: '/',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from python');
  });

  it('node shell runs a .js script', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'console.log("hello from node")',
      shell: 'node',
      env: {},
      cwd: '/',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello from node');
  });

  it('custom {0} shell expands the script path placeholder', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'echo from-custom',
      shell: 'bash {0}',
      env: {},
      cwd: '/',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('from-custom');
  });

  it('fallthrough: unrecognised shell name is used as-is', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'echo fallthrough',
      shell: '/bin/sh',
      env: {},
      cwd: '/',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('fallthrough');
  });

  it('sends SIGKILL when process survives SIGTERM (covers SIGKILL fallback)', async () => {
    const sandbox = new ShellSandbox();
    // trap ignores SIGTERM; sleep redirects its stdio so it doesn't hold the pipe
    // open after sh is SIGKILL'd — pipe closes when sh dies, triggering close event
    const result = await sandbox.shell({
      script: 'trap "" TERM; sleep 10 >/dev/null 2>&1',
      shell: 'sh',
      env: {},
      cwd: '/',
      timeout: 100,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  }, 10_000);

  it('captures stderr output from real shell', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'echo errtext >&2', shell: 'sh', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stderr.trim()).toBe('errtext');
  });

  it('timeout: timedOut=true and exitCode=124 when script exceeds timeout', async () => {
    const sandbox = new ShellSandbox();
    // exec replaces sh with sleep directly so SIGTERM reaches the sleep process and
    // the pipe closes immediately — avoids orphaned grandchild holding the pipe open.
    const result = await sandbox.shell({
      script: 'exec sleep 100',
      shell: 'sh',
      env: {},
      cwd: '/',
      timeout: 50,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBe(124);
  }, 10_000);

  it('coverage: true + sh — prepends header and returns shellCoverage with line hits', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'echo hello',
      shell: 'sh',
      env: {},
      cwd: '/',
      coverage: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.shellCoverage).toBeDefined();
    expect('lineHits' in result.shellCoverage!).toBe(true);
    const cov = result.shellCoverage as { lineHits: Record<number, number> };
    expect(cov.lineHits[1]).toBe(1);
  });

  it('coverage: true + bash — prepends header and returns shellCoverage', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'echo hello-bash',
      shell: 'bash',
      env: {},
      cwd: '/',
      coverage: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.shellCoverage).toBeDefined();
  });

  it('coverage: true + python3 — runs with coverage.py and returns pythonCoverageData', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'print("hello")',
      shell: 'python3',
      env: {},
      cwd: '/',
      coverage: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.shellCoverage).toBeDefined();
    expect('pythonCoverageData' in result.shellCoverage!).toBe(true);
  });

  it('coverage: true + node — returns shellCoverage with nodeCoverageData via V8', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'console.log("hello")',
      shell: 'node',
      env: {},
      cwd: '/',
      coverage: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.shellCoverage).toBeDefined();
    expect('nodeCoverageData' in result.shellCoverage!).toBe(true);
    const cov = result.shellCoverage as { nodeCoverageData: { path: string; v8Data: unknown }[] };
    expect(cov.nodeCoverageData.length).toBeGreaterThan(0);
  });

  it('node shell with protocol files in env — uses existing protocol (hasProtocol branch)', async () => {
    const { allocateProtocolFiles } = await import('@actharness/core');
    const protocol = allocateProtocolFiles();
    const { rmSync } = await import('node:fs');
    try {
      const sandbox = new ShellSandbox();
      const result = await sandbox.shell({
        script: 'console.log("proto")',
        shell: 'node',
        env: {
          GITHUB_OUTPUT: protocol.output,
          GITHUB_ENV: protocol.env,
          GITHUB_STATE: protocol.state,
          // GITHUB_PATH and GITHUB_STEP_SUMMARY intentionally absent → hits ?? '' branches
        },
        cwd: '/',
        coverage: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('proto');
    } finally {
      rmSync(protocol.dir, { recursive: true, force: true });
    }
  });

  it('coverage: false — no shellCoverage in result', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'echo hi',
      shell: 'sh',
      env: {},
      cwd: '/',
      coverage: false,
    });
    expect(result.shellCoverage).toBeUndefined();
  });
});

// ── Network mock (proxy path) ─────────────────────────────────────────────────

describe('ShellSandbox — network mock (proxy)', () => {
  beforeEach(() => {
    resetNetworkMocks();
  });

  it('sh with active network mock: CA cert and proxy env set (lines 142-143)', async () => {
    mockNetwork('https://api.example.com/data', 200, { ok: true });
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'echo proxied', shell: 'sh', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('proxied');
  });

  it('pwsh with active network mock: PowerShell TLS-skip prefix prepended (line 150)', async () => {
    mockNetwork('https://api.example.com/data', 200, { ok: true });
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'Write-Output "proxied"', shell: 'pwsh', env: { PATH: process.env['PATH'] ?? '' }, cwd: '/' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('proxied');
  });
});
