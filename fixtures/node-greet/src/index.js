'use strict';
const core = require('@actions/core');

const name = core.getInput('name') || 'World';
core.setOutput('greeting', `Hello ${name}`);
