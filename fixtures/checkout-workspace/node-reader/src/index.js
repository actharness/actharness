'use strict';
const core = require('@actions/core');
const fs = require('fs');
const path = require('path');

// Builds the path via GITHUB_WORKSPACE explicitly — exercises the env var directly,
// as a real action author might. See node-reader-relative/ for the bare-relative-path
// variant, which exercises cwd fidelity instead.
async function run() {
  const filePath = path.join(process.env.GITHUB_WORKSPACE, 'data.txt');
  const value = fs.readFileSync(filePath, 'utf8').trim();
  core.setOutput('value', value);
}

run().catch(err => core.setFailed(err.message));
