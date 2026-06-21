'use strict';
const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  const token = core.getInput('token', { required: true });
  const issueNumber = parseInt(core.getInput('issue-number', { required: true }), 10);

  const octokit = github.getOctokit(token);
  const { data: comments } = await octokit.rest.issues.listComments({
    owner: 'actharness',
    repo: 'actharness',
    issue_number: issueNumber,
  });

  core.setOutput('comment-count', String(comments.length));
}

run().catch(err => {
  core.setFailed(err.message);
});
