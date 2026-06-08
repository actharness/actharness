'use strict';
const core = require('@actions/core');

async function run() {
  const name = core.getInput('name') || 'World';
  const greeting = `Hello, ${name}!`;
  core.setOutput('greeting', greeting);
  core.info(greeting);
}

run().catch(err => core.setFailed(err.message));
