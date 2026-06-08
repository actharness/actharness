#!/usr/bin/env node
// Installs node_modules for the tagger fixture (needs @actions/core + @actions/github).
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const taggerDir = join(__dirname, '..', 'fixtures', 'tagger');

if (!existsSync(join(taggerDir, 'node_modules'))) {
  console.log('Installing tagger fixture dependencies...');
  execSync('npm install', { cwd: taggerDir, stdio: 'inherit' });
} else {
  console.log('Tagger fixture dependencies already installed.');
}
