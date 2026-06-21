/**
 * Global setup — installs npm deps for fixture actions that need them.
 * Skips if node_modules already exist (idempotent).
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(__dir, 'fixtures');

// Only baseline, lifecycle, octokit, and fetch-action need npm install.
// esm uses only Node builtins; bundled and conditional have no deps at all.
const needsInstall = ['baseline', 'lifecycle', 'octokit', 'fetch-action'];

export async function setup() {
  for (const name of needsInstall) {
    const dir = join(fixturesDir, name);
    if (!existsSync(join(dir, 'node_modules'))) {
      console.log(`[setup-fixtures] installing ${name}…`);
      execSync('npm install --no-audit --no-fund --prefer-offline', {
        cwd: dir,
        stdio: 'inherit',
      });
    }
  }
}
