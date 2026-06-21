// Unit tests for the pwsh persistent session feature.
// Mocks child_process.spawn; exercises PwshSession, PwshSessionPool, and the
// ShellSandbox session path (runId present) end-to-end.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { ShellSandbox } from '../src/shell-sandbox.js';
import { PwshSession } from '../src/pwsh-session.js';
import { PwshSessionPool } from '../src/pwsh-session-pool.js';
import { mockNetwork, resetNetworkMocks } from '@actharness/network-mock';

// ── Mock process factory ───────────────────────────────────────────────────────

interface MockProc {
  proc: EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
    stdin: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    exitCode: number | null;
  };
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: PassThrough;
}

function makeMockProc(): MockProc {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const proc = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    kill: vi.fn(),
    exitCode: null as number | null,
  });
  return { proc: proc as MockProc['proc'], stdout, stderr, stdin };
}

// Queue of mock processes; spawn() returns the next one in order.
let mockQueue: MockProc[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  mockQueue = [];
  vi.mocked(spawn).mockImplementation(() => {
    const m = mockQueue.shift()!;
    return m.proc as ReturnType<typeof spawn>;
  });
});

// Helper: set up a mock process that responds synchronously to each stdin write.
// "Synchronous" here means the sentinel is written to stdout in the same tick as
// the stdin write, so the line ends up in PwshSession's lineBuffer (buffer path).
function makeSyncResponder(exitCode = 0, coverageJson = '{}', addTypeDetected?: boolean): MockProc {
  const m = makeMockProc();
  let buf = '';
  m.stdin.on('data', (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop()!;
    for (const line of lines) {
      if (line.trim()) {
        const third = addTypeDetected !== undefined ? ` ${addTypeDetected}` : '';
        m.stdout.write(`__ACTHARNESS_DONE__${exitCode} ${coverageJson}${third}\n`);
      }
    }
  });
  return m;
}

// Helper: set up a mock process that does NOT respond until explicitly told to.
function makeSilentProc(): MockProc {
  return makeMockProc();
}

// ── PwshSession unit tests ────────────────────────────────────────────────────

describe('PwshSession', () => {
  it('spawn() starts pwsh with host script and -NonInteractive', () => {
    const m = makeSyncResponder();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['-NonInteractive', '-File']),
      expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
    );
    expect(session.isAlive()).toBe(true);
  });

  it('run() — buffer path: returns sentinel when line arrives before nextLine()', async () => {
    // Sync responder causes the sentinel to enter lineBuffer before nextLine() waits.
    const m = makeSyncResponder(7, '{}');
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: { A: '1' },
      coverage: false,
    });

    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
    expect(result.coverage).toEqual({});
    expect(session.isAlive()).toBe(true);
  });

  it('run() — pending-resolve path: returns sentinel when line arrives after nextLine() waits', async () => {
    const m = makeSilentProc();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const runPromise = session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    // Emit the sentinel after run() is suspended at its await
    m.stdout.write('__ACTHARNESS_DONE__3 {}\n');

    const result = await runPromise;
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  it('run() — close path (pending): fires pendingResolve when close arrives while nextLine() is blocked', async () => {
    // nextLine()'s Promise constructor runs synchronously, so pendingResolve IS set
    // by the time session.run() suspends at its await. Emitting close right after
    // session.run() starts covers the `if (this.pendingResolve)` true branch.
    const m = makeSilentProc();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const runPromise = session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    // pendingResolve is now set (synchronous executor in nextLine's Promise)
    m.proc.exitCode = 42;
    m.proc.emit('close', 42, null);

    const result = await runPromise;
    expect(result.exitCode).toBe(42);
    expect(result.timedOut).toBe(false);
    expect(result.coverage).toEqual({});
    expect(session.isAlive()).toBe(false);
  });

  it('run() — close path (already closed): returns close exit code when process closed before run()', async () => {
    const m = makeSilentProc();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    // Close the process BEFORE calling run()
    m.proc.exitCode = 99;
    m.proc.emit('close', 99, null);

    // nextLine() hits the this.closed branch immediately
    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.exitCode).toBe(99);
    expect(result.timedOut).toBe(false);
  });

  it('run() — timeout path: kills session and returns timedOut=true, exitCode=124', async () => {
    const m = makeSilentProc();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
      timeout: 10,
    });

    expect(result.exitCode).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.coverage).toEqual({});
    expect(session.isAlive()).toBe(false);
    expect(m.proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('run() — addTypeDetected: true when sentinel third field is "true"', async () => {
    const m = makeSyncResponder(0, '{}', true);
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.addTypeDetected).toBe(true);
  });

  it('run() — addTypeDetected: false when sentinel third field is "false"', async () => {
    const m = makeSyncResponder(0, '{}', false);
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.addTypeDetected).toBe(false);
  });

  it('run() — addTypeDetected: false when sentinel has no third field (backward compat)', async () => {
    const m = makeSyncResponder(0, '{}');
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.addTypeDetected).toBe(false);
  });

  it('run() — coverage: returns parsed hit counts from sentinel JSON', async () => {
    const m = makeSyncResponder(0, '{"1":2,"3":1}');
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: true,
    });

    expect(result.exitCode).toBe(0);
    expect(result.coverage).toEqual({ '1': 2, '3': 1 });
  });

  it('run() — close path with host stderr: hostError is populated when host writes to stderr before closing', async () => {
    const m = makeSilentProc();
    m.stdin.on('data', () => {
      m.stderr.write('OOM: pwsh ran out of memory\n');
      m.proc.exitCode = 1;
      m.proc.emit('close', 1, null);
    });
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.hostError).toContain('OOM: pwsh ran out of memory');
  });

  it('run() — null exit code: closeExitCode ?? 1 returns 1 when killed by signal', async () => {
    // When a process is killed by signal, the 'close' event code is null.
    // closeExitCode ?? 1 should fall back to 1 (covers the ?? branch).
    const m = makeSilentProc();
    m.stdin.on('data', () => {
      m.proc.exitCode = null;
      m.proc.emit('close', null, 'SIGKILL');
    });
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const result = await session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
    });

    expect(result.exitCode).toBe(1);
  });

  it('run() — clearTimeout when line arrives before timeout fires', async () => {
    // When run() has a timeout but a line arrives first, pendingResolve is called
    // with the timer still set, triggering clearTimeout (covers line 114 branch).
    const m = makeSilentProc();
    mockQueue.push(m);

    const session = new PwshSession();
    session.spawn();

    const runPromise = session.run({
      scriptPath: '/tmp/s.ps1',
      stdoutPath: '/tmp/out',
      stderrPath: '/tmp/err',
      cwd: '/tmp',
      env: {},
      coverage: false,
      timeout: 5_000,
    });

    // Line arrives while pendingResolve is set and timer is running → clearTimeout
    m.stdout.write('__ACTHARNESS_DONE__0 {}\n');

    const result = await runPromise;
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('kill() sets isAlive() false, sends SIGTERM immediately and SIGKILL after 2s', () => {
    vi.useFakeTimers();
    try {
      const m = makeSyncResponder();
      mockQueue.push(m);

      const session = new PwshSession();
      session.spawn();
      expect(session.isAlive()).toBe(true);

      session.kill();
      expect(session.isAlive()).toBe(false);
      expect(m.proc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(m.proc.kill).not.toHaveBeenCalledWith('SIGKILL');

      vi.advanceTimersByTime(2_000);
      expect(m.proc.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('kill() cancels the SIGKILL timer if the process closes within 2s', () => {
    vi.useFakeTimers();
    try {
      const m = makeSyncResponder();
      mockQueue.push(m);

      const session = new PwshSession();
      session.spawn();

      session.kill();
      expect(m.proc.kill).toHaveBeenCalledWith('SIGTERM');

      m.proc.emit('close', 0);
      vi.advanceTimersByTime(2_000);
      expect(m.proc.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });
});

// ── PwshSessionPool unit tests ────────────────────────────────────────────────

describe('PwshSessionPool', () => {
  it('getOrCreate: returns the same session for the same runId (reuse)', () => {
    const m = makeSyncResponder();
    mockQueue.push(m);

    const pool = new PwshSessionPool();
    const s1 = pool.getOrCreate('run-a');
    const s2 = pool.getOrCreate('run-a');

    expect(s1).toBe(s2);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('getOrCreate: creates a new session when existing one is dead', () => {
    const m1 = makeSyncResponder();
    const m2 = makeSyncResponder();
    mockQueue.push(m1, m2);

    const pool = new PwshSessionPool();
    const s1 = pool.getOrCreate('run-b');

    // Kill the session so isAlive() returns false
    s1.kill();
    expect(s1.isAlive()).toBe(false);

    const s2 = pool.getOrCreate('run-b');
    expect(s2).not.toBe(s1);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('invalidate: causes next getOrCreate to spawn a new session', () => {
    const m1 = makeSyncResponder();
    const m2 = makeSyncResponder();
    mockQueue.push(m1, m2);

    const pool = new PwshSessionPool();
    pool.getOrCreate('run-c');
    pool.invalidate('run-c');
    pool.getOrCreate('run-c');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('endRun: kills the session and removes it from the pool', () => {
    const m = makeSyncResponder();
    mockQueue.push(m);

    const pool = new PwshSessionPool();
    pool.getOrCreate('run-d');
    pool.endRun('run-d');

    expect(m.proc.kill).toHaveBeenCalledWith('SIGTERM');
    // After endRun, next getOrCreate spawns fresh
    const m2 = makeSyncResponder();
    mockQueue.push(m2);
    pool.getOrCreate('run-d');
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('endRun: no-op when runId has no session', () => {
    const pool = new PwshSessionPool();
    expect(() => pool.endRun('nonexistent')).not.toThrow();
  });

  it('roll: kills the current session and removes it; next getOrCreate spawns fresh', () => {
    const m1 = makeSyncResponder();
    const m2 = makeSyncResponder();
    mockQueue.push(m1, m2);

    const pool = new PwshSessionPool();
    pool.getOrCreate('run-roll');
    pool.roll('run-roll');

    expect(m1.proc.kill).toHaveBeenCalledWith('SIGTERM');

    pool.getOrCreate('run-roll');
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('roll: no-op when runId has no session', () => {
    const pool = new PwshSessionPool();
    expect(() => pool.roll('nonexistent')).not.toThrow();
  });
});

// ── ShellSandbox session path tests ──────────────────────────────────────────

describe('ShellSandbox — pwsh session path (runId present)', () => {
  it('1. session reuse: spawn called once for three pwsh steps with same runId', async () => {
    const m = makeSyncResponder(0);
    mockQueue.push(m);

    const sandbox = new ShellSandbox();

    await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-1' });
    await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-1' });
    await sandbox.shell({ script: 'echo 3', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-1' });

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('2. exit survives session: exit 42 reply arrives normally; step 3 runs on same session', async () => {
    let callCount = 0;
    const m = makeMockProc();
    let buf = '';
    const exitCodes = [0, 42, 0];
    m.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          m.stdout.write(`__ACTHARNESS_DONE__${exitCodes[callCount++]} {}\n`);
        }
      }
    });
    mockQueue.push(m);

    const sandbox = new ShellSandbox();
    const r1 = await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-2' });
    const r2 = await sandbox.shell({ script: 'exit 42', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-2' });
    const r3 = await sandbox.shell({ script: 'echo 3', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-2' });

    expect(r1.exitCode).toBe(0);
    expect(r2.exitCode).toBe(42);
    expect(r3.exitCode).toBe(0);
    // All three steps ran on the same session (spawn called once)
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  });

  it('3. premature close with host stderr: step stderr contains [pwsh host error] prefix', async () => {
    const m1 = makeSilentProc();
    m1.stdin.on('data', () => {
      m1.stderr.write('Unexpected token in pwsh host\n');
      m1.proc.exitCode = 1;
      m1.proc.emit('close', 1, null);
    });
    const m2 = makeSyncResponder(0);
    mockQueue.push(m1, m2);

    const sandbox = new ShellSandbox();
    const r1 = await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-3b' });

    expect(r1.exitCode).toBe(1);
    expect(r1.stderr).toContain('[pwsh host error]');
    expect(r1.stderr).toContain('Unexpected token in pwsh host');
  });

  it('3. premature close: pool.invalidate called; step 2 gets a new session', async () => {
    // Emit close synchronously when stdin receives data (simulating host crash mid-step).
    // This fires AFTER spawn() registers the close listener but BEFORE nextLine() waits,
    // so session.run() sees this.closed===true immediately (the already-closed branch).
    const m1 = makeSilentProc();
    m1.stdin.on('data', () => {
      m1.proc.exitCode = 1;
      m1.proc.emit('close', 1, null);
    });
    const m2 = makeSyncResponder(0);
    mockQueue.push(m1, m2);

    const sandbox = new ShellSandbox();

    // Step 1: host crashes synchronously on stdin write
    const r1 = await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-3' });

    expect(r1.exitCode).toBe(1);
    expect(r1.timedOut).toBe(false);

    // Step 2: pool invalidated m1; fresh session m2 is spawned
    const r2 = await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-3' });
    expect(r2.exitCode).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('4. env replacement: each step sends its own full env dict', async () => {
    const sentMessages: unknown[] = [];
    const m = makeMockProc();
    let buf = '';
    m.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          sentMessages.push(JSON.parse(line));
          m.stdout.write('__ACTHARNESS_DONE__0 {}\n');
        }
      }
    });
    mockQueue.push(m);

    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: { TEST_ENV: 'a' }, cwd: '/', runId: 'run-4' });
    await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: { TEST_ENV: 'b' }, cwd: '/', runId: 'run-4' });

    expect(sentMessages).toHaveLength(2);
    expect((sentMessages[0] as { env: Record<string, string> }).env['TEST_ENV']).toBe('a');
    expect((sentMessages[1] as { env: Record<string, string> }).env['TEST_ENV']).toBe('b');
  });

  it('5. CWD per step: each step sends its own cwd', async () => {
    const sentMessages: unknown[] = [];
    const m = makeMockProc();
    let buf = '';
    m.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          sentMessages.push(JSON.parse(line));
          m.stdout.write('__ACTHARNESS_DONE__0 {}\n');
        }
      }
    });
    mockQueue.push(m);

    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/dir/a', runId: 'run-5' });
    await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: {}, cwd: '/dir/b', runId: 'run-5' });

    expect((sentMessages[0] as { cwd: string }).cwd).toBe('/dir/a');
    expect((sentMessages[1] as { cwd: string }).cwd).toBe('/dir/b');
  });

  it('6. coverage: script is unmodified; session receives coverage:true; hits returned as lineHits', async () => {
    const sentMessages: unknown[] = [];
    const m = makeMockProc();
    let buf = '';
    m.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          sentMessages.push(JSON.parse(line));
          m.stdout.write('__ACTHARNESS_DONE__0 {"1":1,"2":1}\n');
        }
      }
    });
    mockQueue.push(m);

    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'Write-Output "hello"',
      shell: 'pwsh',
      env: {},
      cwd: '/',
      coverage: true,
      runId: 'run-6',
    });

    expect((sentMessages[0] as { coverage: boolean }).coverage).toBe(true);
    expect(result.shellCoverage).toBeDefined();
    expect('lineHits' in result.shellCoverage!).toBe(true);
    const cov = result.shellCoverage as { lineHits: Record<number, number> };
    expect(cov.lineHits[1]).toBe(1);
    expect(cov.lineHits[2]).toBe(1);
  });

  it('7. timeout: kill() called; result has timedOut=true, exitCode=124; next step gets fresh session', async () => {
    const m1 = makeSilentProc();
    const m2 = makeSyncResponder(0);
    mockQueue.push(m1, m2);

    const sandbox = new ShellSandbox();

    // Step 1 times out
    const r1 = await sandbox.shell({
      script: 'echo 1',
      shell: 'pwsh',
      env: {},
      cwd: '/',
      runId: 'run-7',
      timeout: 10,
    });

    expect(r1.timedOut).toBe(true);
    expect(r1.exitCode).toBe(124);
    expect(m1.proc.kill).toHaveBeenCalledWith('SIGTERM');

    // Step 2: pool creates a fresh session after the timeout-killed one
    const r2 = await sandbox.shell({
      script: 'echo 2',
      shell: 'pwsh',
      env: {},
      cwd: '/',
      runId: 'run-7',
    });

    expect(r2.exitCode).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });

  it('8. no runId: falls through to per-step spawn path; no PwshSessionPool involved', async () => {
    // Per-step path uses spawnAndCapture (EventEmitter-based mock, not readline)
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      setTimeout(() => child.emit('close', 0, null), 0);
      return child as ReturnType<typeof spawn>;
    });

    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'Write-Output hi', shell: 'pwsh', env: {}, cwd: '/' });

    expect(result.exitCode).toBe(0);
    // spawn called once for the per-step path
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
    // Called with per-step args (not the session host script)
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['-NonInteractive']),
      expect.any(Object),
    );
  });

  it('session path: proxy env vars injected into session env when network mock is active', async () => {
    mockNetwork('https://example.com/', 200, {});

    const sentMessages: unknown[] = [];
    const m = makeMockProc();
    let buf = '';
    m.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          sentMessages.push(JSON.parse(line));
          m.stdout.write('__ACTHARNESS_DONE__0 {}\n');
        }
      }
    });
    mockQueue.push(m);

    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-net' });

    resetNetworkMocks();

    const env = (sentMessages[0] as { env: Record<string, string> }).env;
    expect(env['HTTPS_PROXY']).toBeDefined();
    expect(env['SSL_CERT_FILE']).toBeDefined();
  });

  it('addTypeDetected: roll triggered; next step gets new session', async () => {
    const m1 = makeSyncResponder(0, '{}', true);
    const m2 = makeSyncResponder(0, '{}', false);
    mockQueue.push(m1, m2);

    const sandbox = new ShellSandbox();

    const r1 = await sandbox.shell({ script: 'Add-Type -TypeDefinition "class T{}"', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-roll' });
    expect(r1.exitCode).toBe(0);

    // m1 is dead (killed by roll); step 2 gets m2
    const r2 = await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-roll' });
    expect(r2.exitCode).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
    expect(m1.proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('pwshIsolation: process — falls through to spawnAndCapture even when runId is present', async () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      kill: vi.fn(),
    });
    vi.mocked(spawn).mockImplementationOnce(() => {
      setTimeout(() => child.emit('close', 0, null), 0);
      return child as ReturnType<typeof spawn>;
    });

    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({
      script: 'Write-Output hi',
      shell: 'pwsh',
      env: {},
      cwd: '/',
      runId: 'run-process-iso',
      pwshIsolation: 'process',
    });

    expect(result.exitCode).toBe(0);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['-NonInteractive']),
      expect.any(Object),
    );
  });

  it('endRun: kills the session and frees pool entry', async () => {
    const m = makeSyncResponder(0);
    const m2 = makeSyncResponder(0);
    mockQueue.push(m, m2);

    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'echo 1', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-end' });

    sandbox.endRun('run-end');
    expect(m.proc.kill).toHaveBeenCalledWith('SIGTERM');

    // After endRun, next call spawns a fresh session
    await sandbox.shell({ script: 'echo 2', shell: 'pwsh', env: {}, cwd: '/', runId: 'run-end' });
    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(2);
  });
});
