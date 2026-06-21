import '@actharness/composite';
import { actharness as _actharness } from '@actharness/core';
import type { ActharnessOptions, ActionMockDef, ActionMockImpl, ActionMock, GitHubApiRoutes, NetworkMatcher, NetworkMock } from '@actharness/types';
import type { Action } from '@actharness/core';

export type ActharnessFn = {
  (source: string, options?: ActharnessOptions): Action;
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  mockOnce(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  resetMocks(): void;
  mockGitHubApi(routes: GitHubApiRoutes): NetworkMock;
  mockGitHubApiOnce(routes: GitHubApiRoutes): NetworkMock;
  mockNetwork(matcher: NetworkMatcher, status: number, response: unknown, headers?: Record<string, string>): NetworkMock;
  mockNetworkOnce(matcher: NetworkMatcher, status: number, response: unknown, headers?: Record<string, string>): NetworkMock;
};

export const actharness = _actharness as unknown as ActharnessFn;
export type { Action };

export {
  describe, it, test,
  before, after,
  beforeEach, afterEach,
  beforeAll, afterAll,
} from '@actharness/cli/lifecycle';

export { expect } from '@actharness/matchers';
export type {
  AssertionHandle,
  RunResultAssertionHandle,
  StepResultAssertionHandle,
  MockAssertionHandle,
} from '@actharness/matchers';

export {
  GITHUB_DEFAULTS,
  RUNNER_DEFAULTS,
  github,
  runner,
  pushEvent,
  pullRequestEvent,
  workflowDispatchEvent,
  issueEvent,
  releaseEvent,
} from '@actharness/fixtures';
export type {
  PushEventOptions,
  PullRequestEventOptions,
  WorkflowDispatchEventOptions,
  IssueEventOptions,
  ReleaseEventOptions,
} from '@actharness/fixtures';
