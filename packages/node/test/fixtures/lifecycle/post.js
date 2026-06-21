'use strict';
const core = require('@actions/core');

async function run() {
  const initialized = core.getState('initialized');
  const key = core.getState('cache-key');
  core.info(`[post] initialized=${initialized}, cache-key=${key}`);
  core.setOutput('cache-hit', initialized === 'true' ? 'true' : 'false');
}

run().catch(err => core.setFailed(err.message));
