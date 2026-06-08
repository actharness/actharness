/**
 * Installs npm deps for all fixture actions.
 * Run once before testing: npm run install:actions
 */
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dir = dirname(fileURLToPath(import.meta.url));
const actionsDir = join(__dir, '../actions');

const actions = ['baseline', 'bundled', 'octokit', 'lifecycle'];

for (const name of actions) {
  const dir = join(actionsDir, name);
  if (!existsSync(join(dir, 'node_modules'))) {
    console.log(`[install] ${name}…`);
    execSync('npm install --no-audit --no-fund', { cwd: dir, stdio: 'inherit' });
  } else {
    console.log(`[install] ${name} — already installed, skipping`);
  }
}
console.log('[install] All actions ready.');
