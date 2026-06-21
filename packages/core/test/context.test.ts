import { describe, it, expect } from 'vitest';
import { GITHUB_DEFAULTS, RUNNER_DEFAULTS } from '@actharness/types';
import type { ParsedAction } from '@actharness/types';
import {
  buildContexts,
  buildEnvVars,
  resolveInputValues,
  createContextStore,
  buildExpressionContexts,
  updateStoreStep,
  mergeStoreEnv,
  evalExpression,
  evalTemplate,
} from '../src/context.js';
import { createJobStatus, markJobFailure, FROZEN_EPOCH } from '../src/determinism.js';
import { ExpressionError } from '../src/errors.js';

function makeAction(inputs?: ParsedAction['inputs']): ParsedAction {
  const action: ParsedAction = {
    name: 'Test',
    runs: { using: 'composite', steps: [] },
  };
  if (inputs !== undefined) action.inputs = inputs;
  return action;
}

describe('buildContexts', () => {
  it('applies GITHUB_DEFAULTS when no overrides given', () => {
    const jobStatus = createJobStatus();
    const { github, runner } = buildContexts(
      makeAction(),
      {},
      '/workspace',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(github.repository).toBe(GITHUB_DEFAULTS.repository);
    expect(github.actor).toBe(GITHUB_DEFAULTS.actor);
    expect(runner.os).toBe(RUNNER_DEFAULTS.os);
  });

  it('workspace is set to the provided path', () => {
    const jobStatus = createJobStatus();
    const { github } = buildContexts(
      makeAction(),
      {},
      '/my/workspace',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(github.workspace).toBe('/my/workspace');
  });

  it('user overrides win over defaults', () => {
    const jobStatus = createJobStatus();
    const { github, runner } = buildContexts(
      makeAction(),
      {
        github: { actor: 'custom-actor', repository: 'org/repo' },
        runner: { os: 'Windows' },
      },
      '/ws',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(github.actor).toBe('custom-actor');
    expect(github.repository).toBe('org/repo');
    expect(runner.os).toBe('Windows');
  });

  it('eventPayload populates github.event', () => {
    const jobStatus = createJobStatus();
    const payload = { action: 'opened', number: 42 };
    const { github } = buildContexts(
      makeAction(),
      { eventPayload: payload },
      '/ws',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(github.event).toEqual(payload);
  });

  it('secrets include GITHUB_TOKEN from github context', () => {
    const jobStatus = createJobStatus();
    const { secrets } = buildContexts(
      makeAction(),
      {},
      '/ws',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(secrets['GITHUB_TOKEN']).toBe(GITHUB_DEFAULTS.token);
  });

  it('user-provided secrets merge in', () => {
    const jobStatus = createJobStatus();
    const { secrets } = buildContexts(
      makeAction(),
      { secrets: { MY_SECRET: 'abc123' } },
      '/ws',
      '1',
      FROZEN_EPOCH,
      jobStatus,
    );
    expect(secrets['MY_SECRET']).toBe('abc123');
  });
});

describe('resolveInputValues', () => {
  it('applies declared defaults when no raw input provided', () => {
    const action = makeAction({
      greeting: { default: 'Hello' },
      name: { required: true },
    });
    const result = resolveInputValues(action, {});
    expect(result['greeting']).toBe('Hello');
    expect(result['name']).toBeUndefined();
  });

  it('coerces number and boolean to string', () => {
    const action = makeAction({ count: {}, flag: {} });
    const result = resolveInputValues(action, { count: 42, flag: true });
    expect(result['count']).toBe('42');
    expect(result['flag']).toBe('true');
  });

  it('passes through undeclared inputs', () => {
    const action = makeAction({});
    const result = resolveInputValues(action, { undeclared: 'value' });
    expect(result['undeclared']).toBe('value');
  });

  it('user-provided input overrides default', () => {
    const action = makeAction({ greeting: { default: 'Hello' } });
    const result = resolveInputValues(action, { greeting: 'Hi' });
    expect(result['greeting']).toBe('Hi');
  });
});

describe('buildEnvVars', () => {
  it('sets GITHUB_ACTIONS=true and CI=true', () => {
    const env = buildEnvVars(
      { ...GITHUB_DEFAULTS, workspace: '/ws' },
      { ...RUNNER_DEFAULTS },
      {},
      '/ws',
      '42',
      FROZEN_EPOCH,
    );
    expect(env['CI']).toBe('true');
    expect(env['GITHUB_ACTIONS']).toBe('true');
  });

  it('transforms input names to INPUT_* variables', () => {
    const env = buildEnvVars(
      { ...GITHUB_DEFAULTS, workspace: '/ws' },
      { ...RUNNER_DEFAULTS },
      { 'My Input': 'value', name: 'world' },
      '/ws',
      '1',
      FROZEN_EPOCH,
    );
    expect(env['INPUT_MY_INPUT']).toBe('value');
    expect(env['INPUT_NAME']).toBe('world');
  });

  it('sets GITHUB_RUN_STARTED_AT to frozen ISO timestamp', () => {
    const env = buildEnvVars(
      { ...GITHUB_DEFAULTS, workspace: '/ws' },
      { ...RUNNER_DEFAULTS },
      {},
      '/ws',
      '1',
      FROZEN_EPOCH,
    );
    expect(env['GITHUB_RUN_STARTED_AT']).toBe('2024-01-01T00:00:00.000Z');
  });

  it('sets RUNNER_OS from runner context', () => {
    const env = buildEnvVars(
      { ...GITHUB_DEFAULTS, workspace: '/ws' },
      { ...RUNNER_DEFAULTS, os: 'macOS' },
      {},
      '/ws',
      '1',
      FROZEN_EPOCH,
    );
    expect(env['RUNNER_OS']).toBe('macOS');
  });
});

describe('ContextStore', () => {
  it('creates a store with all required fields', () => {
    const jobStatus = createJobStatus();
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: { name: 'world' },
      env: { PATH: '/usr/bin' },
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus,
    });
    expect(store.inputs['name']).toBe('world');
    expect(store.env['PATH']).toBe('/usr/bin');
    expect(store.steps).toEqual({});
    expect(store.masks).toBeInstanceOf(Set);
    expect(store.annotations).toEqual([]);
  });

  it('createContextStore seeds masks from provided secret values', () => {
    const jobStatus = createJobStatus();
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: { MY_TOKEN: 'supersecret', OTHER: 'also-secret' },
      matrix: {},
      needs: {},
      jobStatus,
    });
    expect(store.masks.has('supersecret')).toBe(true);
    expect(store.masks.has('also-secret')).toBe(true);
  });

  it('updateStoreStep adds step to store.steps', () => {
    const jobStatus = createJobStatus();
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus,
    });
    updateStoreStep(store, 'my-step', {
      outputs: { out: 'val' },
      outcome: 'success',
      conclusion: 'success',
    });
    expect(store.steps['my-step']?.outputs?.['out']).toBe('val');
  });

  it('mergeStoreEnv merges into store.env', () => {
    const jobStatus = createJobStatus();
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: { EXISTING: 'yes' },
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus,
    });
    mergeStoreEnv(store, { NEW_VAR: 'hello', EXISTING: 'updated' });
    expect(store.env['NEW_VAR']).toBe('hello');
    expect(store.env['EXISTING']).toBe('updated');
  });
});

describe('buildExpressionContexts', () => {
  it('exposes success/failure/always/cancelled as functions', () => {
    const jobStatus = createJobStatus('success');
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus,
    });
    const ctx = buildExpressionContexts(store);
    expect(ctx.functions?.['success']?.()).toBe(true);
    expect(ctx.functions?.['failure']?.()).toBe(false);
    expect(ctx.functions?.['always']?.()).toBe(true);
    expect(ctx.functions?.['cancelled']?.()).toBe(false);
  });

  it('failure() returns true after markJobFailure', () => {
    const jobStatus = createJobStatus('success');
    markJobFailure(jobStatus);
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus,
    });
    const ctx = buildExpressionContexts(store);
    expect(ctx.functions?.['success']?.()).toBe(false);
    expect(ctx.functions?.['failure']?.()).toBe(true);
  });
});

describe('evalExpression', () => {
  it('evaluates simple expressions', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: { name: 'world' },
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    expect(evalExpression('inputs.name', store)).toBe('world');
  });

  it('evaluates success() correctly', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus('success'),
    });
    expect(evalExpression('success()', store)).toBe(true);
  });

  it('includes file location in ExpressionError when filePath provided', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    // '(' causes parse error, filePath is provided → error should include location
    expect(() => evalExpression('(', store, '/fake/action.yml')).toThrow();
  });

  it('strips ${{ }} wrapper before evaluating', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: { flag: 'true' },
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    expect(evalExpression("${{ inputs.flag != 'false' }}", store)).toBe(true);
  });
});

describe('evalTemplate', () => {
  it('resolves ${{ }} expressions in a template', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: { name: 'world' },
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    expect(evalTemplate('Hello, ${{ inputs.name }}!', store)).toBe('Hello, world!');
  });

  it('throws ExpressionError when template contains invalid expression', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    expect(() => evalTemplate('${{ ( }}', store)).toThrow(ExpressionError);
  });

  it('returns empty string for null expression result', () => {
    const store = createContextStore({
      github: { ...GITHUB_DEFAULTS, workspace: '/ws' },
      runner: { ...RUNNER_DEFAULTS },
      inputs: {},
      env: {},
      secrets: {},
      matrix: {},
      needs: {},
      jobStatus: createJobStatus(),
    });
    expect(evalTemplate('${{ null }}', store)).toBe('');
  });
});
