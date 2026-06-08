/**
 * Builds the ncc bundle for the "bundled" fixture action (Scenario B).
 * Called automatically via the "pretest" npm script.
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const sandboxDir = join(__dir, '..');
const actionDir = join(sandboxDir, 'actions/bundled');
const nccBin = join(sandboxDir, 'node_modules/.bin/ncc');
const distFile = join(actionDir, 'dist/index.js');

// Install the bundled action's deps if not already done.
if (!existsSync(join(actionDir, 'node_modules'))) {
  console.log('[build] Installing bundled action deps…');
  execSync('npm install --no-audit --no-fund', { cwd: actionDir, stdio: 'inherit' });
}

console.log('[build] Building ncc bundle for Scenario B…');
execSync(`"${nccBin}" build src/index.js -o dist -q`, { cwd: actionDir, stdio: 'inherit' });
console.log(`[build] Bundle written to ${distFile}`);
