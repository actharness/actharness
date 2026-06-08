'use strict';

const core = require('@actions/core');

function buildMessage(greeting, name) {
  if (!name) {
    return `${greeting}, World!`;
  }
  return `${greeting}, ${name}!`;
}

async function run() {
  const greeting = core.getInput('greeting') || 'Hello';
  const name = core.getInput('name', { required: true });
  const message = buildMessage(greeting, name);
  core.setOutput('message', message);
  core.info(message);
}

run().catch(core.setFailed);
