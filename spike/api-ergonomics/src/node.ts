// Minimal node executor (JsSandbox adapter).
// Implements pre/main/post lifecycle using worker_threads.
// Design from spike/node-sandbox; findings §1 + §2 applied in worker-bootstrap.mjs.

import { Worker } from 'worker_threads';
import { rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { allocateProtocolFiles, parseProtocolFile, parseAnnotations } from './protocol.js';
import { buildEnvVars, resolveInputValues } from './context.js';
import { makeRunResult } from './composite.js';
import type { MockRegistry } from './mock.js';
import type { ParsedAction, RunInput, RunResult, StepResult, Annotation } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(__dirname, 'worker-bootstrap.mjs');

export interface NodeRunOptions {
  actionDir: string;
  action: ParsedAction;
  input: RunInput;
  mocks: MockRegistry;
}

export async function runNode(opts: NodeRunOptions): Promise<RunResult> {
  const inputValues = resolveInputValues(opts.action.inputs, opts.input.inputs);
  const baseEnv = buildEnvVars(opts.input, inputValues, {});
  const mockRoutes = opts.mocks.githubApiRoutes;
  const steps: StepResult[] = [];
  const allAnnotations: Annotation[] = [];
  let state: Record<string, string> = {};

  const runs = opts.action.runs;

  // pre: phase
  if (runs.pre) {
    const preIf = runs['pre-if'] ?? 'always()';
    const shouldRunPre = preIf.includes('always') || preIf === 'always()';
    if (shouldRunPre) {
      const r = await runPhase(join(opts.actionDir, runs.pre), 'pre', baseEnv, state, mockRoutes);
      steps.push(r.step);
      allAnnotations.push(...r.annotations);
      state = { ...state, ...r.state };
    }
  }

  // main: phase
  const mainResult = await runPhase(join(opts.actionDir, runs.main!), 'main', baseEnv, state, mockRoutes);
  steps.push(mainResult.step);
  allAnnotations.push(...mainResult.annotations);
  state = { ...state, ...mainResult.state };

  // post: phase
  if (runs.post) {
    const postIf = runs['post-if'] ?? 'always()';
    const shouldRunPost = postIf.includes('always') || postIf === 'always()';
    if (shouldRunPost) {
      const r = await runPhase(join(opts.actionDir, runs.post), 'post', baseEnv, state, mockRoutes);
      steps.push(r.step);
      allAnnotations.push(...r.annotations);
    }
  }

  const conclusion = steps.some(s => s.conclusion === 'failure') ? 'failure' : 'success';
  const outputs = mainResult.step.outputs;

  return makeRunResult({
    conclusion,
    outputs,
    steps,
    env: {},
    annotations: allAnnotations,
    stdout: steps.map(s => s.stdout).join(''),
    stderr: steps.map(s => s.stderr).join(''),
  });
}

interface PhaseOutcome {
  step: StepResult;
  state: Record<string, string>;
  annotations: Annotation[];
}

async function runPhase(
  entrypoint: string,
  phase: 'pre' | 'main' | 'post',
  baseEnv: Record<string, string>,
  stateEnv: Record<string, string>,
  mockRoutes: Record<string, unknown>,
): Promise<PhaseOutcome> {
  const protocol = allocateProtocolFiles();

  // Thread STATE_* from prior phases.
  const stateVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(stateEnv)) {
    stateVars[`STATE_${k}`] = v;
  }

  const env: Record<string, string> = {
    ...baseEnv,
    ...stateVars,
    GITHUB_OUTPUT: protocol.output,
    GITHUB_ENV: protocol.env,
    GITHUB_STATE: protocol.state,
    GITHUB_PATH: protocol.path,
    GITHUB_STEP_SUMMARY: protocol.summary,
  };

  try {
    const { exitCode, stdout, stderr } = await spawnWorker(entrypoint, env, mockRoutes);
    const outputs = parseProtocolFile(protocol.output);
    const newState = parseProtocolFile(protocol.state);
    const annotations = parseAnnotations(stdout + '\n' + stderr);
    const outcome = exitCode === 0 ? 'success' : 'failure';

    const step: StepResult = {
      id: phase,
      name: phase,
      phase,
      ran: true,
      outcome,
      conclusion: outcome,
      outputs,
      stdout,
      stderr,
    };

    return { step, state: newState, annotations };
  } finally {
    rmSync(protocol.dir, { recursive: true, force: true });
  }
}

function spawnWorker(
  entrypoint: string,
  env: Record<string, string>,
  mockRoutes: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BOOTSTRAP, {
      workerData: { entrypoint, env, mockRoutes },
      stdout: true,
      stderr: true,
    });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    worker.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    worker.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

    worker.on('message', (msg: { type: string; code?: number }) => {
      if (msg.type === 'done') exitCode = msg.code ?? 0;
    });

    worker.on('exit', (code: number) => {
      resolve({ exitCode: exitCode || code || 0, stdout, stderr });
    });

    worker.on('error', reject);
  });
}
