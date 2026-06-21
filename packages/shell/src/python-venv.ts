// Lazy-creates and caches a per-binary coverage.py virtualenv.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));

function venvPythonPath(venvDir: string): string {
  return platform() === 'win32'
    ? join(venvDir, 'Scripts', 'python.exe')
    : join(venvDir, 'bin', 'python');
}

const cache = new Map<string, string>();

export async function resolveVenvPython(bin: 'python' | 'python3'): Promise<string> {
  const cached = cache.get(bin);
  if (cached) return cached;

  const venvDir = join(pkgDir, `.venv-${bin}`);
  const venvPython = venvPythonPath(venvDir);

  if (!existsSync(venvPython)) {
    execFileSync(bin, ['-m', 'venv', venvDir], { stdio: 'ignore' });
    const pipPath = platform() === 'win32'
      ? join(venvDir, 'Scripts', 'pip')
      : join(venvDir, 'bin', 'pip');
    execFileSync(pipPath, ['install', 'coverage', '--quiet'], { stdio: 'ignore' });
  }

  cache.set(bin, venvPython);
  return venvPython;
}

export function clearVenvCache(): void {
  cache.clear();
}
