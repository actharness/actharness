'use strict';
const core = require('@actions/core');

const preRan = core.getState('pre-ran');
const validatedTag = core.getState('validated-tag');
core.info(`Tagger post: cleanup (pre-ran=${preRan}, validated-tag=${validatedTag})`);
core.setOutput('post-cleanup', 'done');
