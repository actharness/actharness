'use strict';
const core = require('@actions/core');
const fs = require('fs');

// Bare relative path, no GITHUB_WORKSPACE — proves the node sandbox's cwd matches
// the real runner's GITHUB_WORKSPACE (see specs/sessions/node-sandbox-cwd-fidelity.md).
async function run() {
  const value = fs.readFileSync('./data.txt', 'utf8').trim();
  core.setOutput('value', value);
}

run().catch(err => core.setFailed(err.message));
