'use strict';
const core = require('@actions/core');

const tagName = core.getInput('tag-name');
core.info(`Tagger pre: validating tag name "${tagName}"`);
if (!tagName) {
  core.setFailed('tag-name input is required');
} else {
  core.saveState('pre-ran', 'true');
  core.saveState('validated-tag', tagName);
  core.info('Tagger pre: validation complete');
}
