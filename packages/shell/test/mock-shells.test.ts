// Mock-based tests for ShellSandbox — covers shell types not available on this machine
// (pwsh, powershell, python, cmd) and the code=null signal-exit edge case.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
import { ShellSandbox } from '../src/shell-sandbox.js';

function makeChild(exitCode: number | null, stdoutData = '') {
  const child = new EventEmitter() as ReturnType<typeof spawn>;
  const stdout = new EventEmitter() as NonNullable<ReturnType<typeof spawn>['stdout']>;
  const stderr = new EventEmitter() as NonNullable<ReturnType<typeof spawn>['stderr']>;
  (stdout as unknown as { setEncoding: unknown }).setEncoding = vi.fn();
  (stderr as unknown as { setEncoding: unknown }).setEncoding = vi.fn();
  (child as unknown as { stdout: unknown; stderr: unknown; kill: unknown }).stdout = stdout;
  (child as unknown as { stdout: unknown; stderr: unknown; kill: unknown }).stderr = stderr;
  (child as unknown as { stdout: unknown; stderr: unknown; kill: unknown }).kill = vi.fn();
  setTimeout(() => {
    if (stdoutData) stdout.emit('data', stdoutData);
    child.emit('close', exitCode, null);
  }, 0);
  return child;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(spawn).mockImplementation(() => makeChild(0));
});

describe('ShellSandbox — mocked shell types', () => {
  it('pwsh shell: spawn called with pwsh bin and -NonInteractive', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'Write-Host hi', shell: 'pwsh', env: {}, cwd: '/' });
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['-NonInteractive']),
      expect.any(Object),
    );
    expect(result.exitCode).toBe(0);
  });

  it('powershell shell: normalised to pwsh bin', async () => {
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'Write-Host hi', shell: 'powershell', env: {}, cwd: '/' });
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'pwsh',
      expect.arrayContaining(['-NonInteractive']),
      expect.any(Object),
    );
    expect(result.exitCode).toBe(0);
  });

  it('python shell: spawn called with python bin and .py extension', async () => {
    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'print("hi")', shell: 'python', env: {}, cwd: '/' });
    const [bin, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('python');
    expect(String(args[0])).toMatch(/\.py$/);
  });

  it('cmd shell: spawn called with cmd bin, /C flags, and .cmd extension', async () => {
    const sandbox = new ShellSandbox();
    await sandbox.shell({ script: 'echo hi', shell: 'cmd', env: {}, cwd: '/' });
    const [bin, args] = vi.mocked(spawn).mock.calls[0]!;
    expect(bin).toBe('cmd');
    expect(args).toEqual(expect.arrayContaining(['/D', '/E:ON', '/V:OFF', '/S', '/C']));
    const callArg = (args as string[]).find((a) => a.startsWith('CALL '));
    expect(callArg).toMatch(/\.cmd"$/);
  });

  it('code=null: exitCode falls back to 1 when process dies by signal (timedOut=false)', async () => {
    vi.mocked(spawn).mockImplementationOnce(() => makeChild(null));
    const sandbox = new ShellSandbox();
    const result = await sandbox.shell({ script: 'echo hi', shell: 'sh', env: {}, cwd: '/' });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });
});
