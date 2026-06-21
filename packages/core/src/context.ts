// ContextStore, buildContexts, buildEnvVars, resolveInputValues.
// All mutable — StepRunner updates this as steps execute.

import type {
  GitHubContext,
  RunnerContext,
  ParsedAction,
  RunInput,
  Annotation,
} from '@actharness/types';
import { GITHUB_DEFAULTS, RUNNER_DEFAULTS } from '@actharness/types';
import type { ExpressionContexts } from '@actharness/expressions';
import { evaluate as exprEvaluate, evaluateTemplate as exprEvaluateTemplate } from '@actharness/expressions';
import type { JobStatus } from './determinism.js';
import { ExpressionError } from './errors.js';

// ── StepContextEntry ──────────────────────────────────────────────────────────

export interface StepContextEntry {
  outputs: Record<string, string>;
  outcome: 'success' | 'failure' | 'skipped';
  conclusion: 'success' | 'failure' | 'skipped';
}

// ── ContextStore ──────────────────────────────────────────────────────────────

export interface ContextStore {
  github: GitHubContext;
  runner: RunnerContext;
  inputs: Record<string, string>;
  /** Accumulated env (merged from GITHUB_ENV writes). */
  env: Record<string, string>;
  steps: Record<string, StepContextEntry>;
  secrets: Record<string, string>;
  matrix: Record<string, unknown>;
  needs: Record<string, unknown>;
  jobStatus: JobStatus;
  /** Values to mask in stdout/stderr. */
  masks: Set<string>;
  /** Annotations accumulated during the run. */
  annotations: Annotation[];
}

// ── Expression context object (fed to @actharness/expressions) ──────────────────

export function buildExpressionContexts(store: ContextStore): ExpressionContexts {
  return {
    github: store.github,
    inputs: store.inputs,
    steps: store.steps,
    env: store.env,
    runner: store.runner,
    secrets: store.secrets,
    matrix: store.matrix,
    needs: store.needs,
    functions: {
      success: () => store.jobStatus.success,
      failure: () => store.jobStatus.failure,
      always: () => true,
      cancelled: () => store.jobStatus.cancelled,
    },
  };
}

// ── createContextStore ────────────────────────────────────────────────────────

export function createContextStore(opts: {
  github: GitHubContext;
  runner: RunnerContext;
  inputs: Record<string, string>;
  env: Record<string, string>;
  secrets: Record<string, string>;
  matrix: Record<string, unknown>;
  needs: Record<string, unknown>;
  jobStatus: JobStatus;
}): ContextStore {
  return {
    github: opts.github,
    runner: opts.runner,
    inputs: opts.inputs,
    env: { ...opts.env },
    steps: {},
    secrets: opts.secrets,
    matrix: opts.matrix,
    needs: opts.needs,
    jobStatus: opts.jobStatus,
    masks: new Set(Object.values(opts.secrets).filter(Boolean)),
    annotations: [],
  };
}

// ── Step updates ──────────────────────────────────────────────────────────────

export function updateStoreStep(
  store: ContextStore,
  id: string,
  entry: StepContextEntry,
): void {
  store.steps[id] = entry;
}

export function mergeStoreEnv(
  store: ContextStore,
  env: Record<string, string>,
): void {
  Object.assign(store.env, env);
}

// ── Build contexts from RunInput ──────────────────────────────────────────────

export function buildContexts(
  action: ParsedAction,
  input: RunInput,
  workspace: string,
  runId: string,
  now: Date,
  _jobStatus: JobStatus,
): {
  github: GitHubContext;
  runner: RunnerContext;
  inputs: Record<string, string>;
  env: Record<string, string>;
  secrets: Record<string, string>;
  matrix: Record<string, unknown>;
  needs: Record<string, unknown>;
} {
  const github: GitHubContext = {
    ...GITHUB_DEFAULTS,
    workspace,
    run_id: runId,
    ...input.github,
  };

  if (input.eventPayload !== undefined) {
    github.event = input.eventPayload;
  }

  const runner: RunnerContext = {
    ...RUNNER_DEFAULTS,
    ...input.runner,
  };

  const rawInputs = input.inputs ?? {};
  const inputs = resolveInputValues(action, rawInputs);

  const env: Record<string, string> = {
    ...buildEnvVars(github, runner, inputs, workspace, runId, now),
    ...input.env,
  };

  const secrets: Record<string, string> = {
    GITHUB_TOKEN: github.token,
    ...input.secrets,
  };

  const matrix = input.matrix ?? {};
  const needs: Record<string, unknown> = {};

  return { github, runner, inputs, env, secrets, matrix, needs };
}

// ── Resolve inputs (apply defaults, coerce types) ─────────────────────────────

export function resolveInputValues(
  action: ParsedAction,
  rawInputs: Record<string, string | number | boolean>,
): Record<string, string> {
  const result: Record<string, string> = {};
  const defs = action.inputs ?? {};

  for (const [name, def] of Object.entries(defs)) {
    const raw = rawInputs[name];
    if (raw !== undefined && raw !== null) {
      result[name] = String(raw);
    } else if (def.default !== undefined) {
      result[name] = def.default;
    }
  }

  // Pass through any extra inputs not declared in the manifest
  for (const [name, val] of Object.entries(rawInputs)) {
    if (!(name in result)) {
      result[name] = String(val);
    }
  }

  return result;
}

// ── Build environment variables injected into each step shell ─────────────────

export function buildEnvVars(
  github: GitHubContext,
  runner: RunnerContext,
  inputs: Record<string, string>,
  workspace: string,
  runId: string,
  now: Date,
): Record<string, string> {
  const env: Record<string, string> = {
    CI: 'true',
    GITHUB_ACTIONS: 'true',
    ...(process.env['PATH'] ? { PATH: process.env['PATH'] } : {}),

    GITHUB_WORKFLOW: github.workflow,
    GITHUB_WORKFLOW_REF: github.workflow_ref,
    GITHUB_RUN_ID: runId,
    GITHUB_RUN_NUMBER: github.run_number,
    GITHUB_RUN_ATTEMPT: github.run_attempt,
    GITHUB_JOB: github.job,
    GITHUB_ACTOR: github.actor,
    GITHUB_ACTOR_ID: github.actor_id,
    GITHUB_TRIGGERING_ACTOR: github.triggering_actor,
    GITHUB_REPOSITORY: github.repository,
    GITHUB_REPOSITORY_OWNER: github.repository_owner,
    GITHUB_REPOSITORY_ID: github.repository_id,
    GITHUB_SHA: github.sha,
    GITHUB_REF: github.ref,
    GITHUB_REF_NAME: github.ref_name,
    GITHUB_REF_TYPE: github.ref_type,
    GITHUB_REF_PROTECTED: String(github.ref_protected),
    GITHUB_BASE_REF: github.base_ref,
    GITHUB_HEAD_REF: github.head_ref,
    GITHUB_EVENT_NAME: github.event_name,
    GITHUB_SERVER_URL: github.server_url,
    GITHUB_API_URL: github.api_url,
    GITHUB_GRAPHQL_URL: github.graphql_url,
    GITHUB_TOKEN: github.token,
    GITHUB_RETENTION_DAYS: github.retention_days,
    GITHUB_WORKSPACE: workspace,

    RUNNER_OS: runner.os,
    RUNNER_ARCH: runner.arch,
    RUNNER_NAME: runner.name,
    RUNNER_TEMP: runner.temp,
    RUNNER_TOOL_CACHE: runner.tool_cache,
    RUNNER_ENVIRONMENT: runner.environment,
    RUNNER_DEBUG: runner.debug,

    GITHUB_RUN_STARTED_AT: now.toISOString(),
  };

  for (const [name, val] of Object.entries(inputs)) {
    const key = `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
    env[key] = val;
  }

  return env;
}

// ── Template evaluation helpers ───────────────────────────────────────────────

export function evalExpression(
  expr: string,
  store: ContextStore,
  filePath?: string,
): unknown {
  const trimmed = expr.trim();
  const body =
    trimmed.startsWith('${{') && trimmed.endsWith('}}')
      ? trimmed.slice(3, -2).trim()
      : trimmed;
  try {
    return exprEvaluate(body, buildExpressionContexts(store));
  } catch (e) {
    throw new ExpressionError(
      `Failed to evaluate expression: ${expr}\n  ${String(e)}`,
      filePath ? { file: filePath, line: 0, col: 0 } : undefined,
    );
  }
}

export function evalTemplate(
  template: string,
  store: ContextStore,
  filePath?: string,
): string {
  try {
    const result = exprEvaluateTemplate(template, buildExpressionContexts(store));
    return result === null || result === undefined ? '' : String(result);
  } catch (e) {
    throw new ExpressionError(
      `Failed to evaluate template: ${template}\n  ${String(e)}`,
      filePath ? { file: filePath, line: 0, col: 0 } : undefined,
    );
  }
}
