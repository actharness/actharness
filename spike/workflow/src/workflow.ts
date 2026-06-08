// WorkflowRunner — extends api-ergonomics spike with:
//   - Matrix expansion (cartesian product + include/exclude)
//   - fail-fast cancellation of sibling matrix instances
//   - Job-level if: evaluation
//   - wouldTrigger: evaluates on: filters without execution

import { evaluate, evaluateTemplate } from '@actspec/expressions';
import { buildContexts, buildEnvVars, resolveInputValues } from './context.js';
import { runComposite, makeRunResult } from './composite.js';
import type { MockRegistry } from './mock.js';
import type {
  ParsedWorkflow, ParsedJob, ParsedStrategy,
  RunInput, RunResult, JobResult, WorkflowResult,
  Annotation, TriggerInput, TriggerResult, JobMockDef,
} from './types.js';
import { dirname } from 'path';

export interface WorkflowRunOptions {
  workflowPath: string;
  workflow: ParsedWorkflow;
  input: RunInput;
  mocks: MockRegistry;
  mockedJobs?: Map<string, JobMockDef>;
}

// ── Matrix expansion ──────────────────────────────────────────────────────────

interface MatrixInstance {
  matrixId: string;
  matrix: Record<string, unknown>;
}

function expandMatrix(strategy: ParsedStrategy | undefined): MatrixInstance[] {
  if (!strategy?.matrix) return [{ matrixId: '', matrix: {} }];

  const rawMatrix = strategy.matrix as Record<string, unknown>;
  const include = (rawMatrix['include'] as Record<string, unknown>[] | undefined) ?? [];
  const exclude = (rawMatrix['exclude'] as Record<string, unknown>[] | undefined) ?? [];
  const dimKeys = Object.keys(rawMatrix).filter(k => k !== 'include' && k !== 'exclude');

  if (dimKeys.length === 0 && include.length > 0) {
    return include.map(inc => ({
      matrixId: Object.entries(inc).map(([k, v]) => `${k}=${v}`).join(', '),
      matrix: inc,
    }));
  }

  let combinations: Record<string, unknown>[] = [{}];
  for (const key of dimKeys) {
    const values = rawMatrix[key] as unknown[];
    const expanded: Record<string, unknown>[] = [];
    for (const existing of combinations) {
      for (const value of values) {
        expanded.push({ ...existing, [key]: value });
      }
    }
    combinations = expanded;
  }

  for (const inc of include) {
    const matching = combinations.find(c =>
      Object.keys(inc).every(k => !(k in c) || c[k] === inc[k])
    );
    if (matching) {
      Object.assign(matching, inc);
    } else {
      combinations.push({ ...inc });
    }
  }

  combinations = combinations.filter(c =>
    !exclude.some(ex => Object.keys(ex).every(k => c[k] === ex[k]))
  );

  return combinations.map(matrix => ({
    matrixId: dimKeys.map(k => `${k}=${matrix[k]}`).join(', '),
    matrix,
  }));
}

// ── Job if: evaluation ────────────────────────────────────────────────────────

function evaluateJobIf(
  ifExpr: string | undefined,
  input: RunInput,
  needsCtx: Record<string, unknown>,
  jobStatus: { success: boolean; failure: boolean; cancelled: boolean },
): boolean {
  if (ifExpr === undefined) return jobStatus.success;
  let expr = ifExpr.trim();
  if (expr.startsWith('${{') && expr.endsWith('}}')) expr = expr.slice(3, -2).trim();
  try {
    const ctx = buildContexts(input, {}, {}, {}, jobStatus, needsCtx);
    const val = evaluate(expr, ctx);
    return isTruthy(val);
  } catch {
    return false;
  }
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'number' && isNaN(v)) return false;
  return true;
}

// ── Main workflow runner ──────────────────────────────────────────────────────

export async function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowResult> {
  const workflowDir = dirname(opts.workflowPath);
  const order = topologicalSort(opts.workflow.jobs);
  const jobResults: JobResult[] = [];
  const allAnnotations: Annotation[] = [];

  // Track the aggregate result per logical job id (for needs: context).
  // For matrix jobs: aggregate is failure if any instance failed.
  const jobAggregates = new Map<string, { conclusion: 'success' | 'failure' | 'skipped' | 'cancelled'; outputs: Record<string, string> }>();

  for (const jobId of order) {
    const jobDef = opts.workflow.jobs[jobId]!;
    const needsIds = normalizeNeeds(jobDef.needs);

    // Build needs context from completed job aggregates.
    const needsCtx: Record<string, unknown> = {};
    for (const n of needsIds) {
      const agg = jobAggregates.get(n);
      needsCtx[n] = { outputs: agg?.outputs ?? {}, result: agg?.conclusion ?? 'success' };
    }

    // Determine current job status for if: evaluation.
    const anyNeedsFailed = needsIds.some(n => {
      const agg = jobAggregates.get(n);
      return agg?.conclusion === 'failure';
    });
    const jobStatus = { success: !anyNeedsFailed, failure: anyNeedsFailed, cancelled: false };

    // Evaluate job-level if: condition.
    const shouldRunJob = evaluateJobIf(jobDef.if, opts.input, needsCtx, jobStatus);

    if (!shouldRunJob) {
      const skipped = makeSkippedJob(jobId, needsIds);
      jobResults.push(skipped);
      jobAggregates.set(jobId, { conclusion: 'skipped', outputs: {} });
      continue;
    }

    // Check for mocked job.
    const mockDef = opts.mockedJobs?.get(jobId);
    if (mockDef) {
      const mocked = makeMockedJob(jobId, needsIds, mockDef);
      jobResults.push(mocked);
      jobAggregates.set(jobId, { conclusion: mocked.conclusion, outputs: mocked.outputs });
      continue;
    }

    // Expand matrix.
    const instances = expandMatrix(jobDef.strategy);
    const failFast = jobDef.strategy?.['fail-fast'] ?? true;
    let matrixFailed = false;
    const instanceResults: JobResult[] = [];

    for (const instance of instances) {
      if (matrixFailed) {
        // fail-fast: cancel remaining instances.
        instanceResults.push(makeCancelledJob(jobId, needsIds, instance.matrix));
        continue;
      }

      const result = await runJobSteps({
        jobId,
        jobDef,
        workflowDir,
        input: opts.input,
        mocks: opts.mocks,
        needsCtx,
        needsIds,
        matrixCtx: instance.matrix,
      });

      instanceResults.push(result);
      allAnnotations.push(...result.annotations);

      if (result.conclusion === 'failure' && failFast) {
        matrixFailed = true;
      }
    }

    // Determine aggregate for this job id.
    const anyInstanceFailed = instanceResults.some(r => r.conclusion === 'failure');
    const aggregateConclusion = anyInstanceFailed ? 'failure' : 'success';
    // For needs: context, use outputs from the last successful instance (or last instance).
    const lastInstance = instanceResults.findLast(r => r.conclusion === 'success') ?? instanceResults[instanceResults.length - 1]!;

    jobAggregates.set(jobId, { conclusion: aggregateConclusion, outputs: lastInstance.outputs });
    jobResults.push(...instanceResults);
  }

  const anyFailed = jobResults.some(j => j.conclusion === 'failure');
  const anyCancelled = jobResults.some(j => j.conclusion === 'cancelled') && !anyFailed;
  const conclusion: WorkflowResult['conclusion'] = anyFailed ? 'failure' : anyCancelled ? 'cancelled' : 'success';

  return {
    conclusion,
    jobs: jobResults,
    // FINDING (probe #2): job(id) returns the first instance for matrix jobs.
    // Multiple instances with the same id are ambiguous — filter result.jobs manually.
    job(id: string) { return this.jobs.find(j => j.id === id); },
    annotations: allAnnotations,
  };
}

// ── Job step execution ────────────────────────────────────────────────────────

async function runJobSteps(opts: {
  jobId: string;
  jobDef: ParsedJob;
  workflowDir: string;
  input: RunInput;
  mocks: MockRegistry;
  needsCtx: Record<string, unknown>;
  needsIds: string[];
  matrixCtx: Record<string, unknown>;
}): Promise<JobResult> {
  const syntheticAction = {
    name: opts.jobDef.name ?? opts.jobId,
    inputs: {},
    outputs: {},
    runs: { using: 'composite', steps: opts.jobDef.steps },
  };

  const result = await runComposite({
    actionDir: opts.workflowDir,
    action: syntheticAction,
    input: { ...opts.input, inputs: {} },
    mocks: opts.mocks,
    inheritedEnv: {},
    needsCtx: opts.needsCtx,
    matrixCtx: opts.matrixCtx,
  });

  // Evaluate job-level outputs.
  const jobOutputs: Record<string, string> = {};
  for (const [name, expr] of Object.entries(opts.jobDef.outputs ?? {})) {
    const stepsCtx = buildStepsCtxFromResult(result);
    const jobStatus = { success: result.conclusion === 'success', failure: result.conclusion === 'failure', cancelled: false };
    const ctx = buildContexts(opts.input, {}, stepsCtx, result.env, jobStatus, opts.needsCtx, opts.matrixCtx);
    jobOutputs[name] = String(evaluateTemplate(expr, ctx));
  }

  const outcome = result.conclusion as 'success' | 'failure';
  return {
    ...result,
    conclusion: outcome,
    id: opts.jobId,
    needs: opts.needsIds,
    outcome,
    outputs: jobOutputs,
    ...(Object.keys(opts.matrixCtx).length > 0 ? { matrix: opts.matrixCtx } : {}),
  };
}

function buildStepsCtxFromResult(result: RunResult): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const step of result.steps) {
    ctx[step.id] = { outputs: step.outputs, outcome: step.outcome, conclusion: step.conclusion };
  }
  return ctx;
}

// ── Skipped / mocked / cancelled job factories ────────────────────────────────

function makeSkippedJob(id: string, needs: string[]): JobResult {
  const base = makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  return { ...base, id, needs, outcome: 'skipped', conclusion: 'skipped' };
}

function makeMockedJob(id: string, needs: string[], def: JobMockDef): JobResult {
  const conclusion = (def.result ?? 'success') as 'success' | 'failure';
  const base = makeRunResult({ conclusion: conclusion === 'failure' ? 'failure' : 'success', outputs: def.outputs ?? {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  return { ...base, id, needs, outcome: conclusion, conclusion, outputs: def.outputs ?? {} };
}

function makeCancelledJob(id: string, needs: string[], matrix?: Record<string, unknown>): JobResult {
  const base = makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  return { ...base, id, needs, outcome: 'cancelled', conclusion: 'cancelled', ...(matrix ? { matrix } : {}) };
}

// ── Topological sort ──────────────────────────────────────────────────────────

function topologicalSort(jobs: Record<string, ParsedJob>): string[] {
  const visited = new Set<string>();
  const order: string[] = [];

  function visit(id: string) {
    if (visited.has(id)) return;
    visited.add(id);
    const job = jobs[id];
    if (!job) return;
    for (const dep of normalizeNeeds(job.needs)) visit(dep);
    order.push(id);
  }

  for (const id of Object.keys(jobs)) visit(id);
  return order;
}

function normalizeNeeds(needs: string | string[] | undefined): string[] {
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

// ── wouldTrigger ──────────────────────────────────────────────────────────────

export function wouldTrigger(workflow: ParsedWorkflow, input: TriggerInput): TriggerResult {
  const allJobIds = Object.keys(workflow.jobs);
  const triggers = normalizeTriggers(workflow.on);

  if (!Object.hasOwn(triggers, input.event)) {
    return { triggered: false, jobs: [], reason: `event '${input.event}' not in on: triggers` };
  }

  const filter = triggers[input.event] ?? null;

  if (filter !== null) {
    // branches filter
    if (filter.branches && filter.branches.length > 0) {
      const refName = extractRefName(input.ref ?? '');
      if (!refName || !matchesAnyGlob(filter.branches, refName)) {
        return { triggered: false, jobs: [], reason: `ref '${refName || input.ref}' does not match branches filter` };
      }
    }

    // paths filter — FINDING (probe #6): when changedFiles is omitted, conservatively not triggered.
    if (filter.paths && filter.paths.length > 0) {
      if (!input.changedFiles || input.changedFiles.length === 0) {
        return { triggered: false, jobs: [], reason: `paths filter requires changedFiles to be provided` };
      }
      const negated = filter.paths.filter(p => p.startsWith('!'));
      const positive = filter.paths.filter(p => !p.startsWith('!'));
      const anyPositive = positive.length === 0 || input.changedFiles.some(f => matchesAnyGlob(positive, f));
      const anyNegated = negated.some(p => input.changedFiles!.some(f => matchesGlob(p.slice(1), f)));
      if (!anyPositive || anyNegated) {
        return { triggered: false, jobs: [], reason: `no changedFiles match paths filter` };
      }
    }

    // types filter
    if (filter.types && filter.types.length > 0) {
      const action = (input.payload as Record<string, unknown> | undefined)?.['action'] as string | undefined;
      if (!action || !filter.types.includes(action)) {
        return { triggered: false, jobs: [], reason: `action type '${action ?? '(none)'}' not in types filter` };
      }
    }

    // tags filter
    if (filter.tags && filter.tags.length > 0) {
      const refName = extractRefName(input.ref ?? '');
      if (!refName || !matchesAnyGlob(filter.tags, refName)) {
        return { triggered: false, jobs: [], reason: `ref '${refName}' does not match tags filter` };
      }
    }
  }

  return { triggered: true, jobs: allJobIds };
}

// ── Trigger normalization ─────────────────────────────────────────────────────

interface NormalizedFilter {
  branches?: string[];
  'branches-ignore'?: string[];
  paths?: string[];
  'paths-ignore'?: string[];
  tags?: string[];
  'tags-ignore'?: string[];
  types?: string[];
}
type NormalizedTriggers = Record<string, NormalizedFilter | null>;

function normalizeTriggers(on: unknown): NormalizedTriggers {
  if (!on) return {};
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on)) {
    const result: NormalizedTriggers = {};
    for (const e of on as string[]) result[e] = null;
    return result;
  }
  const result: NormalizedTriggers = {};
  for (const [event, filter] of Object.entries(on as Record<string, unknown>)) {
    result[event] = (filter && typeof filter === 'object') ? filter as NormalizedFilter : null;
  }
  return result;
}

// ── Glob matching ─────────────────────────────────────────────────────────────

function extractRefName(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/tags/')) return ref.slice('refs/tags/'.length);
  return ref;
}

function matchesAnyGlob(patterns: string[], value: string): boolean {
  return patterns.some(p => matchesGlob(p, value));
}

function matchesGlob(pattern: string, value: string): boolean {
  // Convert glob to a regex. Order matters: escape first, then replace wildcards.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\x00')      // placeholder for **
    .replace(/\*/g, '[^/]*')        // * matches within a segment
    .replace(/\x00/g, '.*');        // ** matches across segments
  return new RegExp(`^${escaped}$`).test(value);
}
