'use strict';
const core = require('@actions/core');

async function run() {
  const greeting = core.getInput('greeting');
  if (!greeting) {
    core.setFailed('Input "greeting" must not be empty');
    process.exit(1);
  }
  const message = `${greeting} World`;
  core.setOutput('message', message);
  core.exportVariable('LAST_MESSAGE', message);
  core.info(`Message: ${message}`);
}

run().catch(err => core.setFailed(err.message));
