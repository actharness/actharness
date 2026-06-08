import { spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { evaluate, evaluateTemplate } from '@actspec/expressions';
import { allocateProtocolFiles, parseProtocolFile, parseAnnotations, parseLegacyOutputCommands } from './protocol.js';
import { buildContexts, buildEnvVars, resolveInputValues, type JobStatus } from './context.js';
import type { MockRegistry } from './mock.js';
import type { ParsedAction, ParsedStep, RunInput, RunResult, StepResult, Annotation } from './types.js';

type StepResultInternal = StepResult & { _envWrites: Record<string, string> };

export interface CompositeRunOptions {
  actionDir: string;
  action: ParsedAction;
  input: RunInput;
  mocks: MockRegistry;
  inheritedEnv?: Record<string, string>;
  needsCtx?: Record<string, unknown>;
}

export async function runComposite(opts: CompositeRunOptions): Promise<RunResult> {
  const inputValues = resolveInputValues(opts.action.inputs, opts.input.inputs);
  const steps: StepResult[] = [];
  const allAnnotations: Annotation[] = [];
  let accumulatedEnv: Record<string, string> = { ...opts.inheritedEnv };
  const stepsCtx: Record<string, unknown> = {};

  let jobStatus: JobStatus = { success: true, failure: false, cancelled: false };
  if (opts.input.jobStatus === 'failure') jobStatus = { success: false, failure: true, cancelled: false };
  if (opts.input.jobStatus === 'cancelled') jobStatus = { success: false, failure: false, cancelled: true };

  const workspace = mkdtempSync(join(tmpdir(), 'actspec-ws-'));

  try {
    for (const step of opts.action.runs.steps ?? []) {
      const stepId = step.id ?? `step-${steps.length}`;
      const stepName = step.name ?? stepId;
      const ctx = buildContexts(opts.input, inputValues, stepsCtx, accumulatedEnv, jobStatus, opts.needsCtx);

      const { shouldRun, ifRecord } = resolveIf(step.if, ctx, jobStatus);

      if (!shouldRun) {
        const skipped: StepResultInternal = {
          id: stepId, name: stepName, phase: 'main',
          ran: false, outcome: 'skipped', conclusion: 'skipped',
          outputs: {}, if: ifRecord, stdout: '', stderr: '', _envWrites: {},
        };
        steps.push(skipped);
        stepsCtx[stepId] = { outputs: {}, outcome: 'skipped', conclusion: 'skipped' };
        continue;
      }

      const stepEnvRaw: Record<string, string> = {};
      for (const [k, v] of Object.entries(step.env ?? {})) {
        stepEnvRaw[k] = String(evaluateTemplate(String(v), ctx));
      }

      let result: StepResultInternal;
      if (step.run !== undefined) {
        result = await execShellStep({ stepId, stepName, step, input: opts.input, inputValues, accumulatedEnv, stepEnvRaw, stepsCtx, jobStatus, workspace, needsCtx: opts.needsCtx });
      } else if (step.uses !== undefined) {
        result = await execUsesStep({ stepId, stepName, step, input: opts.input, inputValues, accumulatedEnv, stepEnvRaw, stepsCtx, jobStatus, mocks: opts.mocks, actionDir: opts.actionDir, needsCtx: opts.needsCtx });
      } else {
        result = { id: stepId, name: stepName, phase: 'main', ran: true, outcome: 'success', conclusion: 'success', outputs: {}, stdout: '', stderr: '', _envWrites: {} };
      }

      const continueOnError = resolveFlag(step['continue-on-error']);
      if (continueOnError && result.outcome === 'failure') result = { ...result, conclusion: 'success' };

      result.if = ifRecord;
      steps.push(result);
      allAnnotations.push(...parseAnnotations(result.stdout + '\n' + result.stderr));
      accumulatedEnv = { ...accumulatedEnv, ...result._envWrites };
      stepsCtx[stepId] = { outputs: result.outputs, outcome: result.outcome, conclusion: result.conclusion };

      if (result.conclusion === 'failure') jobStatus = { success: false, failure: true, cancelled: false };
    }

    const finalCtx = buildContexts(opts.input, inputValues, stepsCtx, accumulatedEnv, jobStatus, opts.needsCtx);
    const outputs: Record<string, string> = {};
    for (const [name, outDef] of Object.entries(opts.action.outputs ?? {})) {
      if (outDef.value) outputs[name] = String(evaluateTemplate(outDef.value, finalCtx));
    }

    return makeRunResult({
      conclusion: jobStatus.failure ? 'failure' : 'success',
      outputs, steps, env: accumulatedEnv,
      annotations: allAnnotations,
      stdout: steps.map(s => s.stdout).join(''),
      stderr: steps.map(s => s.stderr).join(''),
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

interface StepCtx {
  stepId: string; stepName: string; step: ParsedStep;
  input: RunInput; inputValues: Record<string, string>;
  accumulatedEnv: Record<string, string>; stepEnvRaw: Record<string, string>;
  stepsCtx: Record<string, unknown>; jobStatus: JobStatus;
  workspace: string; needsCtx?: Record<string, unknown>;
}

async function execShellStep(opts: StepCtx): Promise<StepResultInternal> {
  const ctx = buildContexts(opts.input, opts.inputValues, opts.stepsCtx, opts.accumulatedEnv, opts.jobStatus, opts.needsCtx);
  const script = String(evaluateTemplate(opts.step.run!, ctx));
  const shell = opts.step.shell ?? 'bash';
  const cwd = opts.step['working-directory']
    ? String(evaluateTemplate(opts.step['working-directory'], ctx))
    : opts.workspace;

  const protocol = allocateProtocolFiles();
  const envVars = buildEnvVars(opts.input, opts.inputValues, opts.accumulatedEnv, {
    ...opts.stepEnvRaw,
    GITHUB_OUTPUT: protocol.output,
    GITHUB_ENV: protocol.env,
    GITHUB_STATE: protocol.state,
    GITHUB_PATH: protocol.path,
    GITHUB_STEP_SUMMARY: protocol.summary,
    GITHUB_WORKSPACE: opts.workspace,
  });

  try {
    const { exitCode, stdout, stderr } = await spawnShell(shell, script, envVars, cwd);
    const stepOutputs = { ...parseLegacyOutputCommands(stdout), ...parseProtocolFile(protocol.output) };
    const envWrites = parseProtocolFile(protocol.env);
    const outcome: StepResult['outcome'] = exitCode === 0 ? 'success' : 'failure';
    return { id: opts.stepId, name: opts.stepName, phase: 'main', ran: true, outcome, conclusion: outcome, outputs: stepOutputs, stdout, stderr, _envWrites: envWrites };
  } finally {
    rmSync(protocol.dir, { recursive: true, force: true });
  }
}

function spawnShell(shell: string, script: string, env: Record<string, string>, cwd: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const args = shell === 'bash' ? ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script]
      : shell === 'sh' ? ['-e', '-c', script]
      : ['-c', script];
    const proc = spawn(shell, args, { env: { ...process.env, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code) => res({ exitCode: code ?? 0, stdout, stderr }));
  });
}

interface UsesStepCtx {
  stepId: string; stepName: string; step: ParsedStep;
  input: RunInput; inputValues: Record<string, string>;
  accumulatedEnv: Record<string, string>; stepEnvRaw: Record<string, string>;
  stepsCtx: Record<string, unknown>; jobStatus: JobStatus;
  mocks: MockRegistry; actionDir: string; needsCtx?: Record<string, unknown>;
}

async function execUsesStep(opts: UsesStepCtx): Promise<StepResultInternal> {
  const ctx = buildContexts(opts.input, opts.inputValues, opts.stepsCtx, opts.accumulatedEnv, opts.jobStatus, opts.needsCtx);
  const ref = opts.step.uses!;

  const withInputs: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts.step.with ?? {})) {
    withInputs[k] = String(evaluateTemplate(String(v), ctx));
  }

  const currentEnv = buildEnvVars(opts.input, opts.inputValues, opts.accumulatedEnv, opts.stepEnvRaw);

  if (opts.mocks.hasMock(ref)) {
    const def = await opts.mocks.invoke(ref, { with: withInputs, env: currentEnv });
    return {
      id: opts.stepId, name: opts.stepName, phase: 'main',
      ran: true, outcome: def.conclusion ?? 'success', conclusion: def.conclusion ?? 'success',
      outputs: def.outputs ?? {}, uses: { ref, mocked: true },
      stdout: '', stderr: '', _envWrites: def.env ?? {},
    };
  }

  if (ref.startsWith('./') || ref.startsWith('../')) {
    const childDir = resolve(opts.actionDir, ref);
    const { parseAction } = await import('./parser.js');
    const childAction = parseAction(childDir);
    const childInput: RunInput = { inputs: withInputs, env: opts.input.env, github: opts.input.github, runner: opts.input.runner, secrets: opts.input.secrets };

    let childResult: RunResult;
    if (childAction.runs.using === 'composite') {
      childResult = await runComposite({ actionDir: childDir, action: childAction, input: childInput, mocks: opts.mocks, inheritedEnv: opts.accumulatedEnv });
    } else if (childAction.runs.using.startsWith('node')) {
      const { runNode } = await import('./node.js');
      childResult = await runNode({ actionDir: childDir, action: childAction, input: childInput, mocks: opts.mocks });
    } else {
      childResult = makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
    }

    return {
      id: opts.stepId, name: opts.stepName, phase: 'main',
      ran: true, outcome: childResult.conclusion, conclusion: childResult.conclusion,
      outputs: childResult.outputs, uses: { ref, mocked: false },
      stdout: childResult.stdout, stderr: childResult.stderr, _envWrites: childResult.env,
    };
  }

  return {
    id: opts.stepId, name: opts.stepName, phase: 'main',
    ran: true, outcome: 'success', conclusion: 'success',
    outputs: {}, uses: { ref, mocked: false }, stdout: '', stderr: '', _envWrites: {},
  };
}

function resolveIf(
  ifExpr: string | undefined,
  ctx: ReturnType<typeof buildContexts>,
  jobStatus: JobStatus,
): { shouldRun: boolean; ifRecord?: { expression: string; result: boolean } } {
  if (ifExpr === undefined) return { shouldRun: jobStatus.success };
  let expr = ifExpr.trim();
  if (expr.startsWith('${{') && expr.endsWith('}}')) expr = expr.slice(3, -2).trim();
  try {
    const val = evaluate(expr, ctx);
    const boolResult = isTruthy(val);
    return { shouldRun: boolResult, ifRecord: { expression: ifExpr, result: boolResult } };
  } catch {
    return { shouldRun: false, ifRecord: { expression: ifExpr, result: false } };
  }
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === false || v === 0 || v === '') return false;
  if (typeof v === 'number' && isNaN(v)) return false;
  return true;
}

function resolveFlag(val: boolean | string | undefined): boolean {
  if (val === undefined || val === false) return false;
  if (val === true) return true;
  return String(val) === 'true';
}

export function makeRunResult(fields: {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  steps: StepResult[];
  env: Record<string, string>;
  annotations: Annotation[];
  stdout: string;
  stderr: string;
}): RunResult {
  return {
    conclusion: fields.conclusion,
    outputs: fields.outputs,
    steps: fields.steps,
    step(id: string) { return this.steps.find(s => s.id === id); },
    env: fields.env,
    annotations: fields.annotations,
    get stdout() { return fields.stdout; },
    get stderr() { return fields.stderr; },
  };
}
