'use strict';
const core = require('@actions/core');

async function run() {
  const key = core.getState('cache-key');
  core.info(`[main] read state cache-key: ${key}`);
  core.setOutput('main-ran', 'true');
}

run().catch(err => core.setFailed(err.message));
