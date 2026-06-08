import { evaluateTemplate } from '@actspec/expressions';
import { buildContexts, buildEnvVars, resolveInputValues } from './context.js';
import { runComposite, makeRunResult } from './composite.js';
import { runNode } from './node.js';
import { notifyRunSink } from './run-sink.js';
import type { MockRegistry } from './mock.js';
import type { ParsedWorkflow, ParsedJob, RunInput, RunResult, JobResult, WorkflowResult, Annotation } from './types.js';
import { join, dirname } from 'path';

export interface WorkflowRunOptions {
  workflowPath: string;
  workflow: ParsedWorkflow;
  input: RunInput;
  mocks: MockRegistry;
  mockedJobs?: Map<string, { outputs?: Record<string, string>; result?: string }>;
}

export async function runWorkflow(opts: WorkflowRunOptions): Promise<WorkflowResult> {
  const workflowDir = dirname(opts.workflowPath);
  const order = topologicalSort(opts.workflow.jobs);
  const jobResults = new Map<string, JobResult>();
  const allAnnotations: Annotation[] = [];

  for (const jobId of order) {
    const jobDef = opts.workflow.jobs[jobId]!;
    const needsIds = normalizeNeeds(jobDef.needs);

    const needsFailed = needsIds.some(n => {
      const r = jobResults.get(n);
      return r && r.conclusion === 'failure';
    });

    if (needsFailed) {
      const skipped = makeSkippedJob(jobId, needsIds);
      jobResults.set(jobId, skipped);
      notifyRunSink({ kind: 'job', sourceFile: opts.workflowPath, jobId, ran: false, outcome: 'skipped' });
      continue;
    }

    const mockDef = opts.mockedJobs?.get(jobId);
    if (mockDef) {
      const mocked = makeMockedJob(jobId, needsIds, mockDef);
      jobResults.set(jobId, mocked);
      notifyRunSink({ kind: 'job', sourceFile: opts.workflowPath, jobId, ran: true, outcome: mocked.outcome });
      continue;
    }

    const needsCtx: Record<string, unknown> = {};
    for (const n of needsIds) {
      const r = jobResults.get(n);
      needsCtx[n] = { outputs: r?.outputs ?? {}, result: r?.conclusion ?? 'success' };
    }

    const jobResult = await runJobSteps({ jobId, jobDef, workflowDir, input: opts.input, mocks: opts.mocks, needsCtx, needsIds });
    jobResults.set(jobId, jobResult);
    allAnnotations.push(...jobResult.annotations);
    notifyRunSink({ kind: 'job', sourceFile: opts.workflowPath, jobId, ran: true, outcome: jobResult.outcome });
  }

  const jobs = order.map(id => jobResults.get(id)!);
  const conclusion: WorkflowResult['conclusion'] = jobs.some(j => j.conclusion === 'failure') ? 'failure' : 'success';

  return {
    conclusion, jobs,
    job(id: string) { return this.jobs.find(j => j.id === id); },
    annotations: allAnnotations,
  };
}

async function runJobSteps(opts: {
  jobId: string; jobDef: ParsedJob; workflowDir: string;
  input: RunInput; mocks: MockRegistry;
  needsCtx: Record<string, unknown>; needsIds: string[];
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
  });

  const jobOutputs: Record<string, string> = {};
  for (const [name, expr] of Object.entries(opts.jobDef.outputs ?? {})) {
    const ctx = buildContexts(opts.input, {}, buildStepsCtxFromResult(result), result.env,
      { success: result.conclusion === 'success', failure: result.conclusion === 'failure', cancelled: false },
      opts.needsCtx);
    jobOutputs[name] = String(evaluateTemplate(expr, ctx));
  }

  return { ...result, id: opts.jobId, needs: opts.needsIds, outcome: result.conclusion, outputs: jobOutputs };
}

function buildStepsCtxFromResult(result: RunResult): Record<string, unknown> {
  const ctx: Record<string, unknown> = {};
  for (const step of result.steps) {
    ctx[step.id] = { outputs: step.outputs, outcome: step.outcome, conclusion: step.conclusion };
  }
  return ctx;
}

function makeSkippedJob(id: string, needs: string[]): JobResult {
  const base = makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  return { ...base, id, needs, outcome: 'skipped', conclusion: 'success' };
}

function makeMockedJob(id: string, needs: string[], def: { outputs?: Record<string, string>; result?: string }): JobResult {
  const conclusion = (def.result ?? 'success') as 'success' | 'failure';
  const base = makeRunResult({ conclusion, outputs: def.outputs ?? {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  return { ...base, id, needs, outcome: conclusion };
}

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
