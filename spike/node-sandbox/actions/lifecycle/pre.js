'use strict';
const core = require('@actions/core');

async function run() {
  core.saveState('initialized', 'true');
  core.saveState('cache-key', `spike-cache-${Date.now()}`);
  core.info('[pre] state saved: initialized=true');
}

run().catch(err => core.setFailed(err.message));
