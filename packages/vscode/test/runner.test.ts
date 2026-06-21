/// <reference types="node" />

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Uri, workspace } from 'vscode';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn() };
});

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:module', () => ({
  createRequire: vi.fn(() => ({ resolve: vi.fn() })),
}));

import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { runTests } from '../src/runner.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyItem = any;

function makeItem(id: string, file = '/ws/greet.test.ts') {
  return {
    id,
    label: id,
    uri: Uri.file(file),
    canResolveChildren: false,
    children: { size: 0, add() {}, delete() {}, get() { return undefined; }, forEach() {} },
    parent: undefined,
  } as AnyItem;
}

function makeRun() {
  const calls: Record<string, unknown[][]> = {
    started: [], passed: [], failed: [], skipped: [], errored: [], appendOutput: [],
  };
  return {
    calls,
    started: vi.fn((...args) => calls['started']!.push(args)),
    passed: vi.fn((...args) => calls['passed']!.push(args)),
    failed: vi.fn((...args) => calls['failed']!.push(args)),
    skipped: vi.fn((...args) => calls['skipped']!.push(args)),
    errored: vi.fn((...args) => calls['errored']!.push(args)),
    appendOutput: vi.fn((...args) => calls['appendOutput']!.push(args)),
    end: vi.fn(),
  };
}

function makeToken(cancel = false) {
  const callbacks: (() => void)[] = [];
  return {
    isCancellationRequested: cancel,
    onCancellationRequested: vi.fn((cb: () => void) => {
      callbacks.push(cb);
      return { dispose: vi.fn() };
    }),
    _trigger() { callbacks.forEach((cb) => cb()); },
  };
}

function mockCliResolution(cliRoot = '/ws') {
  vi.mocked(createRequire).mockReturnValue({
    resolve: vi.fn().mockImplementation((specifier: string, options?: { paths?: string[] }) => {
      const searchRoot = options?.paths?.[0] ?? cliRoot;

      if (specifier === '@actharness/cli/dist/runner-bridge.js') {
        return `${searchRoot}/node_modules/@actharness/cli/dist/runner-bridge.js`;
      }

      if (specifier === 'tsx/esm') {
        return `${cliRoot}/node_modules/@actharness/cli/node_modules/tsx/dist/esm/index.cjs`;
      }

      throw new Error(`not found: ${specifier}`);
    }),
  } as never);
}

function makeChild(stdout = '', stderr = '', exitCode = 0) {
  let stdoutHandler: ((chunk: Buffer) => void) | null = null;
  let stderrHandler: ((chunk: Buffer) => void) | null = null;
  let closeHandler: ((code: number | null) => void) | null = null;

  const child = {
    stdout: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') stdoutHandler = cb;
      },
    },
    stderr: {
      on(event: string, cb: (chunk: Buffer) => void) {
        if (event === 'data') stderrHandler = cb;
      },
    },
    on(event: string, cb: (code: number | null) => void) {
      if (event === 'close') closeHandler = cb;
    },
    kill: vi.fn(),
    _emitData() {
      if (stdout) stdoutHandler?.(Buffer.from(stdout));
      if (stderr) stderrHandler?.(Buffer.from(stderr));
    },
    _emitClose() {
      closeHandler?.(exitCode);
    },
    _emit() {
      if (stdout) stdoutHandler?.(Buffer.from(stdout));
      if (stderr) stderrHandler?.(Buffer.from(stderr));
      closeHandler?.(exitCode);
    },
  };
  return child;
}

describe('runTests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(existsSync).mockReturnValue(false);
    mockCliResolution();

    const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue([folder]);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: vi.fn().mockReturnValue('node'),
    } as never);
  });

  it('reports error and returns when actharness is not installed', async () => {
    vi.mocked(createRequire).mockReturnValue({
      resolve: vi.fn().mockImplementation((specifier: string) => {
        if (specifier === '@actharness/cli/dist/runner-bridge.js') {
          throw new Error('not found');
        }

        throw new Error(`not found: ${specifier}`);
      }),
    } as never);

    const run = makeRun();
    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const token = makeToken();

    await runTests(run as never, [item], token as never);

    expect(run.appendOutput).toHaveBeenCalledWith(
      expect.stringContaining('not found in node_modules'),
    );
    expect(run.errored).toHaveBeenCalledWith(item, expect.anything());
  });

  it('resolves actharness from a fixture-local node_modules folder', async () => {
    vi.mocked(existsSync).mockImplementation((candidatePath: string) =>
      candidatePath.includes('/ws/fixtures/node_modules/@actharness/cli/dist/runner-bridge.js'),
    );
    vi.mocked(createRequire).mockReturnValue({
      resolve: vi.fn().mockImplementation((specifier: string, options?: { paths?: string[] }) => {
        const paths = options?.paths as string[] | undefined;

        if (specifier === '@actharness/cli/dist/runner-bridge.js') {
          expect(paths?.[0]).toBe('/ws/fixtures');
          return '/ws/fixtures/node_modules/@actharness/cli/dist/runner-bridge.js';
        }

        if (specifier === 'tsx/esm') {
          return '/ws/fixtures/node_modules/@actharness/cli/node_modules/tsx/dist/esm/index.cjs';
        }

        throw new Error(`not found: ${specifier}`);
      }),
    } as never);

    const item = makeItem(`file:///ws/fixtures/sample.test.ts::greets`, '/ws/fixtures/sample.test.ts');
    const run = makeRun();
    const token = makeToken();

    const child = makeChild('', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    expect(spawn).toHaveBeenCalled();
    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [string, string[], { cwd: string }];
    expect(spawnOpts.cwd).toBe('/ws/fixtures');
  });

  it('reports error when tsx cannot be resolved', async () => {
    vi.mocked(createRequire).mockReturnValue({
      resolve: vi.fn().mockImplementation((specifier: string, options?: { paths?: string[] }) => {
        if (specifier === '@actharness/cli/dist/runner-bridge.js') {
          return '/ws/node_modules/@actharness/cli/dist/runner-bridge.js';
        }

        if (specifier === 'tsx/esm') {
          throw new Error('not found');
        }

        throw new Error(`not found: ${specifier}`);
      }),
    } as never);

    const run = makeRun();
    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const token = makeToken();

    await runTests(run as never, [item], token as never);

    expect(run.appendOutput).toHaveBeenCalledWith(expect.stringContaining('tsx not found'));
    expect(run.errored).toHaveBeenCalledWith(item, expect.anything());
  });

  it('returns early when there are no workspace folders', async () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined);

    const run = makeRun();
    const token = makeToken();

    await runTests(run as never, [], token as never);

    expect(run.appendOutput).toHaveBeenCalledWith(expect.stringContaining('no workspace folder'));
  });

  it('spawns bridge and marks items started/passed on success', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const passEvent = JSON.stringify({
      type: 'test:pass',
      data: { name: 'greets', nesting: 0, file: '/ws/greet.test.ts', details: { duration_ms: 5 } },
    });
    const child = makeChild(passEvent + '\n', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    expect(spawn).toHaveBeenCalled();
    expect(run.started).toHaveBeenCalledWith(item);
    expect(run.passed).toHaveBeenCalledWith(item, 5);
  });

  it('marks remaining items errored on non-zero exit', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const child = makeChild('', 'something went wrong', 1);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    expect(run.errored).toHaveBeenCalledWith(item, expect.anything());
  });

  it('kills child and marks items skipped on cancellation', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const child = makeChild('', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    token._trigger(); // simulate cancellation
    child._emit();
    await promise;

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(run.skipped).toHaveBeenCalledWith(item);
  });

  it('uses "node" as fallback when nodeExecutable config returns undefined', async () => {
    vi.mocked(existsSync).mockReturnValue(true);
    // Override getConfiguration to return undefined for nodeExecutable
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
    } as never);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();
    const child = makeChild('', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    const [, , spawnOpts] = vi.mocked(spawn).mock.calls[0]! as [string, string[], { cwd: string }];
    // spawn was called (no early return) — the fallback 'node' was used
    expect(spawn).toHaveBeenCalled();
    expect(spawnOpts.cwd).toBe('/ws');
  });

  it('processes remaining buffer on close', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    // Send data without trailing newline so it stays in buffer until close
    const passEvent = JSON.stringify({
      type: 'test:pass',
      data: { name: 'greets', nesting: 0, file: '/ws/greet.test.ts', details: { duration_ms: 3 } },
    });
    // No trailing '\n' — should be flushed from buffer on close
    const child = makeChild(passEvent, '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    expect(run.passed).toHaveBeenCalledWith(item, 3);
  });

  it('uses fallback error message when stderr is empty on failure', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    // No stderr, non-zero exit
    const child = makeChild('', '', 1);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    const [, msg] = run.calls['errored']![0] as [unknown, { message: string }];
    expect(msg.message).toContain('Bridge exited with code 1');
  });

  it('does not add items without a uri to the file set', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const itemWithUri = makeItem(`file:///ws/greet.test.ts::greets`);
    const itemWithoutUri = { ...makeItem('no-uri-item'), uri: undefined } as AnyItem;
    const run = makeRun();
    const token = makeToken();

    const child = makeChild('', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [itemWithUri, itemWithoutUri], token as never);
    child._emit();
    await promise;

    const [, spawnArgs] = vi.mocked(spawn).mock.calls[0]!;
    const filesArg = spawnArgs[spawnArgs.indexOf('--files') + 1]!;
    expect(filesArg).not.toContain('no-uri-item');
    expect(filesArg).toContain('greet.test.ts');
  });

  it('does not skip already-completed items on cancellation', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const passEvent = JSON.stringify({
      type: 'test:pass',
      data: { name: 'greets', nesting: 0, file: '/ws/greet.test.ts', details: { duration_ms: 5 } },
    });
    const child = makeChild(passEvent + '\n', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emitData(); // process pass event first so item lands in completedIds
    token._trigger(); // cancellation fires but item is already completed
    child._emitClose();
    await promise;

    expect(run.skipped).not.toHaveBeenCalled();
  });

  it('does not error already-completed items on non-zero exit', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const passEvent = JSON.stringify({
      type: 'test:pass',
      data: { name: 'greets', nesting: 0, file: '/ws/greet.test.ts', details: { duration_ms: 5 } },
    });
    const child = makeChild(passEvent + '\n', 'something went wrong', 1);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never);
    child._emit();
    await promise;

    expect(run.errored).not.toHaveBeenCalled();
    expect(run.passed).toHaveBeenCalledWith(item, 5);
  });

  it('passes the filter as --pattern to the bridge', async () => {
    vi.mocked(existsSync).mockReturnValue(true);

    const item = makeItem(`file:///ws/greet.test.ts::greets`);
    const run = makeRun();
    const token = makeToken();

    const child = makeChild('', '', 0);
    vi.mocked(spawn).mockReturnValue(child as never);

    const promise = runTests(run as never, [item], token as never, '^greets$');
    child._emit();
    await promise;

    const [, spawnArgs] = vi.mocked(spawn).mock.calls[0]!;
    expect(spawnArgs).toContain('--pattern');
    expect(spawnArgs).toContain('^greets$');
  });
});
