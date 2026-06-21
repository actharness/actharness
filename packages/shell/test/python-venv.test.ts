import { vi, describe, it, expect, beforeEach } from 'vitest';

const { existsSyncMock, execFileSyncMock, platformMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn<(path: string) => boolean>(),
  execFileSyncMock: vi.fn(),
  platformMock: vi.fn<() => NodeJS.Platform>(),
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncMock };
});

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...actual, execFileSync: execFileSyncMock };
});

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, platform: platformMock };
});

import { resolveVenvPython, clearVenvCache } from '../src/python-venv.js';

describe('python-venv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearVenvCache();
    execFileSyncMock.mockReturnValue(Buffer.from(''));
    platformMock.mockReturnValue('linux');
  });

  describe('resolveVenvPython — cache', () => {
    it('returns same path on second call and skips existsSync', async () => {
      existsSyncMock.mockReturnValue(true);
      const p1 = await resolveVenvPython('python3');
      existsSyncMock.mockClear();
      const p2 = await resolveVenvPython('python3');
      expect(p1).toBe(p2);
      expect(existsSyncMock).not.toHaveBeenCalled();
    });

    it('does not call execFileSync when venv already exists', async () => {
      existsSyncMock.mockReturnValue(true);
      await resolveVenvPython('python3');
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });
  });

  describe('resolveVenvPython — posix venv creation (lines 27-31)', () => {
    it('calls venv and pip with posix paths when venv does not exist', async () => {
      existsSyncMock.mockReturnValue(false);
      await resolveVenvPython('python3');
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        1,
        'python3',
        ['-m', 'venv', expect.stringContaining('.venv-python3')],
        { stdio: 'ignore' },
      );
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('/bin/pip'),
        ['install', 'coverage', '--quiet'],
        { stdio: 'ignore' },
      );
    });

    it('returns posix venvPython path (bin/python) on non-win32', async () => {
      existsSyncMock.mockReturnValue(true);
      const path = await resolveVenvPython('python3');
      expect(path).toContain('/bin/python');
    });
  });

  describe('resolveVenvPython — win32 branches', () => {
    beforeEach(() => {
      platformMock.mockReturnValue('win32');
    });

    it('returns Scripts/python.exe path on win32', async () => {
      existsSyncMock.mockReturnValue(true);
      const path = await resolveVenvPython('python3');
      expect(path).toContain('Scripts/python.exe');
    });

    it('calls pip with Scripts/pip path on win32 when venv does not exist', async () => {
      existsSyncMock.mockReturnValue(false);
      await resolveVenvPython('python3');
      expect(execFileSyncMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('Scripts/pip'),
        ['install', 'coverage', '--quiet'],
        { stdio: 'ignore' },
      );
    });
  });

  describe('clearVenvCache (line 39)', () => {
    it('clears cache so next call re-checks existsSync', async () => {
      existsSyncMock.mockReturnValue(true);
      await resolveVenvPython('python3');
      clearVenvCache();
      existsSyncMock.mockClear();
      existsSyncMock.mockReturnValue(true);
      await resolveVenvPython('python3');
      expect(existsSyncMock).toHaveBeenCalled();
    });
  });
});
