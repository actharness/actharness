'use strict';
const core = require('@actions/core');

async function run() {
  core.saveState('initialized', 'true');
  core.saveState('cache-key', 'actharness-cache-42');
  core.info('[pre] state saved');
}

run().catch(err => core.setFailed(err.message));
