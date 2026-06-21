'use strict';
const core = require('@actions/core');
const axios = require('axios');

async function run() {
  try {
    const res = await axios.get('https://api.example.com/data');
    core.setOutput('value', String(res.data.value ?? ''));
  } catch (err) {
    if (err.response) {
      core.setFailed(`request failed with status ${err.response.status}`);
      return;
    } else {
      throw err;
    }
  }
}

run().catch(err => core.setFailed(err.message));
