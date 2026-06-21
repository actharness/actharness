'use strict';
const core = require('@actions/core');

async function run() {
  const res = await fetch('https://api.example.com/data');
  if (!res.ok) {
    core.setFailed(`request failed with status ${res.status}`);
    return;
  }
  const data = await res.json();
  core.setOutput('value', String(data.value ?? ''));
}

run().catch(err => core.setFailed(err.message));
