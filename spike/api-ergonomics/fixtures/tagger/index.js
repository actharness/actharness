'use strict';
const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  const tagName = core.getInput('tag-name', { required: true });
  const token = core.getInput('token', { required: true });

  const octokit = github.getOctokit(token);
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? 'actspec/test-repo').split('/');
  const sha = process.env.GITHUB_SHA ?? '0000000000000000000000000000000000000000';

  const { data: repoData } = await octokit.rest.repos.get({ owner, repo });
  core.setOutput('default-branch', repoData.default_branch);

  const { data: ref } = await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/tags/${tagName}`,
    sha,
  });

  core.setOutput('tag-url', ref.url);
  core.info(`Created tag ${tagName}: ${ref.url}`);
}

run().catch(core.setFailed);
