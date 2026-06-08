import type { RunInput, GitHubContext, RunnerContext } from './types.js';
import type { ExpressionContexts } from '@actspec/expressions';

export interface JobStatus {
  success: boolean;
  failure: boolean;
  cancelled: boolean;
}

const DEFAULT_GITHUB: GitHubContext = {
  repository: 'actspec/test-repo',
  repositoryOwner: 'actspec',
  sha: '0000000000000000000000000000000000000000',
  ref: 'refs/heads/main',
  refName: 'main',
  refType: 'branch',
  actor: 'octocat',
  eventName: 'push',
  workflow: 'test-workflow',
  runId: '1',
  runNumber: '1',
  runAttempt: '1',
  serverUrl: 'https://github.com',
  apiUrl: 'https://api.github.com',
};

const DEFAULT_RUNNER: RunnerContext = {
  os: 'Linux',
  arch: 'X64',
  name: 'actspec',
  temp: '/tmp/actspec-runner',
  toolCache: '/opt/hostedtoolcache',
};

export function buildContexts(
  input: RunInput,
  inputValues: Record<string, string>,
  stepsCtx: Record<string, unknown>,
  envCtx: Record<string, string>,
  jobStatus: JobStatus,
  needsCtx?: Record<string, unknown>,
): ExpressionContexts {
  const github = { ...DEFAULT_GITHUB, ...input.github };
  const runner = { ...DEFAULT_RUNNER, ...input.runner };

  return {
    github,
    inputs: inputValues,
    steps: stepsCtx,
    env: envCtx,
    runner,
    secrets: input.secrets ?? {},
    needs: needsCtx ?? {},
    status: jobStatus,
    functions: {
      success: () => jobStatus.success,
      failure: () => jobStatus.failure,
      always: () => true,
      cancelled: () => jobStatus.cancelled,
    },
  };
}

export function buildEnvVars(
  input: RunInput,
  inputValues: Record<string, string>,
  accumulatedEnv: Record<string, string>,
  stepEnv?: Record<string, string>,
): Record<string, string> {
  const github = { ...DEFAULT_GITHUB, ...input.github };
  const runner = { ...DEFAULT_RUNNER, ...input.runner };

  const inputEnv: Record<string, string> = {};
  for (const [name, value] of Object.entries(inputValues)) {
    inputEnv[`INPUT_${name.toUpperCase().replace(/ /g, '_')}`] = value;
  }

  return {
    GITHUB_REPOSITORY: github.repository,
    GITHUB_REPOSITORY_OWNER: github.repositoryOwner,
    GITHUB_SHA: github.sha,
    GITHUB_REF: github.ref,
    GITHUB_REF_NAME: github.refName,
    GITHUB_ACTOR: github.actor,
    GITHUB_EVENT_NAME: github.eventName,
    GITHUB_WORKFLOW: github.workflow,
    GITHUB_RUN_ID: github.runId,
    GITHUB_RUN_NUMBER: github.runNumber,
    GITHUB_RUN_ATTEMPT: github.runAttempt,
    GITHUB_SERVER_URL: github.serverUrl,
    GITHUB_API_URL: github.apiUrl,
    GITHUB_TOKEN: (input.secrets?.GITHUB_TOKEN) ?? 'ghs_fakefakefake',
    RUNNER_OS: runner.os,
    RUNNER_ARCH: runner.arch,
    RUNNER_NAME: runner.name,
    RUNNER_TEMP: runner.temp,
    RUNNER_TOOL_CACHE: runner.toolCache,
    ...accumulatedEnv,
    ...inputEnv,
    ...input.env,
    ...stepEnv,
  };
}

export function resolveInputValues(
  declaredInputs: Record<string, { default?: string; required?: boolean }> | undefined,
  supplied: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, meta] of Object.entries(declaredInputs ?? {})) {
    if (meta.default !== undefined) result[name] = meta.default;
  }
  for (const [name, value] of Object.entries(supplied ?? {})) {
    result[name] = String(value);
  }
  return result;
}
