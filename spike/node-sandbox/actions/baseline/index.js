'use strict';
const core = require('@actions/core');

async function run() {
  const greeting = core.getInput('greeting');
  if (!greeting) {
    core.error('Input "greeting" must not be empty');
    // Explicit process.exit(1) to prove H5: test runner must survive this.
    process.exit(1);
  }
  const message = `${greeting} World`;
  core.setOutput('message', message);
  core.info(`Greeting set: ${message}`);
}

run().catch(err => core.setFailed(err.message));
