// Edge-case tests for ShellSandbox that require mocking resolveVenvPython.
// Covers the warnNoVenv path (lines 122, 151 of shell-sandbox.ts).

import { vi, describe, it, expect } from 'vitest';

vi.mock('../src/python-venv.js', () => ({
  resolveVenvPython: vi.fn().mockRejectedValue(new Error('venv creation failed')),
  clearVenvCache: vi.fn(),
}));

import { ShellSandbox } from '../src/shell-sandbox.js';

describe('ShellSandbox — warnNoVenv path', () => {
  it('appends no-venv warning to stdout when resolveVenvPython throws', async () => {
    const sandbox = new ShellSandbox();
    // python3 is available so the script itself runs fine via the fallback path,
    // but warnNoVenv=true causes the warning to be appended.
    const result = await sandbox.shell({
      script: 'print("hello")',
      shell: 'python3',
      env: {},
      cwd: '/',
      coverage: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('::warning::python coverage skipped — binary not found');
    expect(result.shellCoverage).toBeUndefined();
  });
});
