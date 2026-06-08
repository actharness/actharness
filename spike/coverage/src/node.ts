import { Worker } from 'worker_threads';
import { rmSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { allocateProtocolFiles, parseProtocolFile, parseAnnotations } from './protocol.js';
import { buildEnvVars, resolveInputValues } from './context.js';
import { makeRunResult } from './composite.js';
import type { MockRegistry } from './mock.js';
import type { ParsedAction, RunInput, RunResult, StepResult, Annotation } from './types.js';
import type { FileCoverageData } from 'istanbul-lib-coverage';

const BOOTSTRAP = fileURLToPath(new URL('./worker-bootstrap.mjs', import.meta.url));

export interface NodeRunOptions {
  actionDir: string;
  action: ParsedAction;
  input: RunInput;
  mocks: MockRegistry;
}

export interface NodeRunResult {
  result: RunResult;
  jsLineCoverage: FileCoverageData[];
}

export async function runNode(opts: NodeRunOptions): Promise<NodeRunResult> {
  const inputValues = resolveInputValues(opts.action.inputs, opts.input.inputs);
  const baseEnv = buildEnvVars(opts.input, inputValues, {});
  const mockRoutes = opts.mocks.githubApiRoutes;
  const steps: StepResult[] = [];
  const allAnnotations: Annotation[] = [];
  const allJsLineCoverage: FileCoverageData[] = [];
  let state: Record<string, string> = {};

  const runs = opts.action.runs;

  if (runs.pre) {
    const preIf = runs['pre-if'] ?? 'always()';
    if (preIf.includes('always') || preIf === 'always()') {
      const r = await runPhase(join(opts.actionDir, runs.pre), 'pre', baseEnv, state, mockRoutes, opts.actionDir);
      steps.push(r.step);
      allAnnotations.push(...r.annotations);
      allJsLineCoverage.push(...r.jsLineCoverage);
      state = { ...state, ...r.state };
    }
  }

  const mainResult = await runPhase(join(opts.actionDir, runs.main!), 'main', baseEnv, state, mockRoutes, opts.actionDir);
  steps.push(mainResult.step);
  allAnnotations.push(...mainResult.annotations);
  allJsLineCoverage.push(...mainResult.jsLineCoverage);
  state = { ...state, ...mainResult.state };

  if (runs.post) {
    const postIf = runs['post-if'] ?? 'always()';
    if (postIf.includes('always') || postIf === 'always()') {
      const r = await runPhase(join(opts.actionDir, runs.post), 'post', baseEnv, state, mockRoutes, opts.actionDir);
      steps.push(r.step);
      allAnnotations.push(...r.annotations);
      allJsLineCoverage.push(...r.jsLineCoverage);
    }
  }

  const conclusion = steps.some(s => s.conclusion === 'failure') ? 'failure' : 'success';

  return {
    result: makeRunResult({
      conclusion,
      outputs: mainResult.step.outputs,
      steps, env: {},
      annotations: allAnnotations,
      stdout: steps.map(s => s.stdout).join(''),
      stderr: steps.map(s => s.stderr).join(''),
    }),
    jsLineCoverage: allJsLineCoverage,
  };
}

interface PhaseOutcome {
  step: StepResult;
  state: Record<string, string>;
  annotations: Annotation[];
  jsLineCoverage: FileCoverageData[];
}

async function runPhase(
  entrypoint: string,
  phase: 'pre' | 'main' | 'post',
  baseEnv: Record<string, string>,
  stateEnv: Record<string, string>,
  mockRoutes: Record<string, unknown>,
  actionDir: string,
): Promise<PhaseOutcome> {
  const protocol = allocateProtocolFiles();

  const stateVars: Record<string, string> = {};
  for (const [k, v] of Object.entries(stateEnv)) stateVars[`STATE_${k}`] = v;

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
    const { exitCode, stdout, stderr, v8CoverageData } = await spawnWorker(entrypoint, env, mockRoutes);
    const outputs = parseProtocolFile(protocol.output);
    const newState = parseProtocolFile(protocol.state);
    const annotations = parseAnnotations(stdout + '\n' + stderr);
    const outcome = exitCode === 0 ? 'success' : 'failure';

    const jsLineCoverage = await convertV8Coverage(v8CoverageData, actionDir);

    const step: StepResult = {
      id: phase, name: phase, phase,
      ran: true, outcome, conclusion: outcome,
      outputs, stdout, stderr,
    };

    return { step, state: newState, annotations, jsLineCoverage };
  } finally {
    rmSync(protocol.dir, { recursive: true, force: true });
  }
}

type V8ScriptCoverage = { scriptId: string; url: string; functions: unknown[] };

function spawnWorker(
  entrypoint: string,
  env: Record<string, string>,
  mockRoutes: Record<string, unknown>,
): Promise<{ exitCode: number; stdout: string; stderr: string; v8CoverageData: V8ScriptCoverage[] }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BOOTSTRAP, {
      workerData: { entrypoint, env, mockRoutes },
      env: { ...(process.env as Record<string, string>) },
      // Explicit execArgv: only tsx so the .ts bootstrap loads; omit actspec's
      // --import register.ts / coverage-register.ts which are for test files only.
      execArgv: ['--import', 'tsx/esm'],
      stdout: true,
      stderr: true,
    });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    let v8CoverageData: V8ScriptCoverage[] = [];

    worker.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    worker.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    worker.on('message', (msg: { type: string; exitCode?: number; data?: unknown }) => {
      if (msg.type === 'done') exitCode = msg.exitCode ?? 0;
      if (msg.type === 'v8coverage') v8CoverageData = msg.data as V8ScriptCoverage[];
    });
    worker.on('exit', (code: number) => resolve({ exitCode: exitCode || code || 0, stdout, stderr, v8CoverageData }));
    worker.on('error', reject);
  });
}

async function convertV8Coverage(
  v8Data: V8ScriptCoverage[],
  actionDir: string,
): Promise<FileCoverageData[]> {
  const result: FileCoverageData[] = [];

  for (const script of v8Data) {
    if (!script.url.startsWith('file://')) continue;
    const filePath = fileURLToPath(script.url);
    if (!filePath.startsWith(actionDir)) continue;

    try {
      const V8ToIstanbul = (await import('v8-to-istanbul')).default;
      const converter = new V8ToIstanbul(filePath, 0);
      await converter.load();
      converter.applyCoverage(script.functions as Parameters<typeof converter.applyCoverage>[0]);
      const data = converter.toIstanbul();
      for (const fc of Object.values(data)) {
        result.push(fc as unknown as FileCoverageData);
      }
    } catch {
      // Ignore conversion failures for individual scripts.
    }
  }

  return result;
}
