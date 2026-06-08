// ContainerSandbox: validates protocol file mounting, image sources, args/entrypoint,
// and pre-entrypoint/post-entrypoint lifecycle for the docker spike.

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, existsSync, chmodSync, rmSync } from 'fs';
import { join, resolve as resolvePath } from 'path';
import { evaluateTemplate } from '@actspec/expressions';
import {
  allocateProtocolFiles,
  parseProtocolFile,
  parseAnnotations,
  buildContexts,
  buildEnvVars,
  resolveInputValues,
  makeRunResult,
} from 'workflow-spike';
import type {
  ParsedAction,
  RunInput,
  RunResult,
  StepResult,
  Annotation,
  ProtocolFiles,
  JobStatus,
} from 'workflow-spike';
import type { MockRegistry } from 'workflow-spike';

export type ContainerBackend = 'mock' | 'docker';

export interface ContainerRunOptions {
  actionDir: string;
  action: ParsedAction;
  input: RunInput;
  mocks: MockRegistry;
  backend: ContainerBackend;
  actionRef: string;
}

// In-process image cache for H4: content-hash → docker image tag
const imageCache = new Map<string, string>();

export function clearImageCache(): void { imageCache.clear(); }
export function getImageCacheSize(): number { return imageCache.size; }

type ImageSource =
  | { kind: 'registry'; image: string }
  | { kind: 'dockerfile'; contextDir: string; cacheKey: string };

function resolveImageSource(image: string, actionDir: string): ImageSource {
  if (image.startsWith('docker://')) {
    // Probe #4: strip the docker:// prefix for docker pull/run
    return { kind: 'registry', image: image.slice('docker://'.length) };
  }
  const contextDir = image === 'Dockerfile' ? actionDir : resolvePath(actionDir, image);
  const dockerfilePath = join(contextDir, 'Dockerfile');
  let keyInput = '';
  if (existsSync(dockerfilePath)) keyInput += readFileSync(dockerfilePath, 'utf8');
  const ignorePath = join(contextDir, '.dockerignore');
  if (existsSync(ignorePath)) keyInput += readFileSync(ignorePath, 'utf8');
  const cacheKey = createHash('sha256').update(keyInput).digest('hex').slice(0, 16);
  return { kind: 'dockerfile', contextDir, cacheKey };
}

async function ensureImage(source: ImageSource): Promise<string> {
  if (source.kind === 'registry') return source.image;
  const cached = imageCache.get(source.cacheKey);
  if (cached) return cached;  // H4: cache hit — skip rebuild
  const tag = `actspec-docker-spike-${source.cacheKey}`;
  const { exitCode, stderr } = await spawnDocker(['build', '-t', tag, source.contextDir]);
  if (exitCode !== 0) throw new Error(`docker build failed:\n${stderr}`);
  imageCache.set(source.cacheKey, tag);
  return tag;
}

function spawnDocker(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', (c: Buffer) => { stdout += c.toString(); });
    proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });
    proc.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });
}

async function runPhase(
  image: string,
  entrypoint: string | undefined,
  args: string[],
  env: Record<string, string>,
  protocol: ProtocolFiles,
  phase: 'pre' | 'main' | 'post',
): Promise<{ step: StepResult; newState: Record<string, string>; annotations: Annotation[] }> {
  // H8: world-writable so non-root container users can write to protocol files
  for (const p of [protocol.output, protocol.env, protocol.state, protocol.path, protocol.summary]) {
    try { chmodSync(p, 0o666); } catch { /* ignore */ }
  }

  const dockerArgs: string[] = ['run', '--rm'];

  // Pass all env vars (INPUT_*, GITHUB_*, STATE_*)
  for (const [k, v] of Object.entries(env)) dockerArgs.push('-e', `${k}=${v}`);

  // Bind-mount each protocol file at its exact host path (H1, probe #2)
  for (const p of [protocol.output, protocol.env, protocol.state, protocol.path, protocol.summary]) {
    dockerArgs.push('-v', `${p}:${p}`);
  }

  if (entrypoint) dockerArgs.push('--entrypoint', entrypoint);
  dockerArgs.push(image);
  dockerArgs.push(...args);

  const { exitCode, stdout, stderr } = await spawnDocker(dockerArgs);
  const outputs = parseProtocolFile(protocol.output);
  const newState = parseProtocolFile(protocol.state);
  const annotations = parseAnnotations(stdout + '\n' + stderr);
  const outcome: StepResult['outcome'] = exitCode === 0 ? 'success' : 'failure';

  return {
    step: { id: phase, name: phase, phase, ran: true, outcome, conclusion: outcome, outputs, stdout, stderr },
    newState,
    annotations,
  };
}

export async function runContainerAction(opts: ContainerRunOptions): Promise<RunResult> {
  const { action, actionDir, input, mocks, backend, actionRef } = opts;
  const inputValues = resolveInputValues(action.inputs, input.inputs);
  const baseEnv = buildEnvVars(input, inputValues, {});

  // Mock backend: no docker invocation (H7)
  if (backend === 'mock') {
    if (mocks.hasMock(actionRef)) {
      const def = await mocks.invoke(actionRef, { with: inputValues, env: baseEnv });
      const conclusion = def.conclusion ?? 'success';
      return makeRunResult({
        conclusion,
        outputs: def.outputs ?? {},
        steps: [{
          id: 'main', name: 'main', phase: 'main',
          ran: true, outcome: conclusion, conclusion,
          outputs: def.outputs ?? {}, stdout: '', stderr: '',
        }],
        env: {},
        annotations: [],
        stdout: '',
        stderr: '',
      });
    }
    return makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
  }

  // Docker backend
  const runs = action.runs;
  if (!runs.image) throw new Error(`Docker action ${actionRef} is missing runs.image`);

  const imageSource = resolveImageSource(runs.image, actionDir);
  const image = await ensureImage(imageSource);

  const steps: StepResult[] = [];
  const allAnnotations: Annotation[] = [];
  const allOutputs: Record<string, string> = {};
  let state: Record<string, string> = {};

  const execPhase = async (phase: 'pre' | 'main' | 'post', entrypoint: string | undefined, args: string[]): Promise<void> => {
    const protocol = allocateProtocolFiles();
    try {
      const stateVars: Record<string, string> = {};
      for (const [k, v] of Object.entries(state)) stateVars[`STATE_${k}`] = v;
      const env: Record<string, string> = {
        ...baseEnv,
        ...stateVars,
        GITHUB_OUTPUT: protocol.output,
        GITHUB_ENV: protocol.env,
        GITHUB_STATE: protocol.state,
        GITHUB_PATH: protocol.path,
        GITHUB_STEP_SUMMARY: protocol.summary,
      };
      const { step, newState, annotations } = await runPhase(image, entrypoint, args, env, protocol, phase);
      steps.push(step);
      allAnnotations.push(...annotations);
      Object.assign(allOutputs, step.outputs);
      state = { ...state, ...newState };
    } finally {
      rmSync(protocol.dir, { recursive: true, force: true });
    }
  };

  if (runs['pre-entrypoint']) {
    await execPhase('pre', runs['pre-entrypoint'], []);
  }

  const evaluatedArgs = evaluateArgsExpressions(runs.args, action, input, inputValues);
  await execPhase('main', runs.entrypoint, evaluatedArgs);

  if (runs['post-entrypoint']) {
    await execPhase('post', runs['post-entrypoint'], []);
  }

  const conclusion = steps.some(s => s.conclusion === 'failure') ? 'failure' : 'success';

  return makeRunResult({
    conclusion,
    outputs: allOutputs,
    steps,
    env: {},
    annotations: allAnnotations,
    stdout: steps.map(s => s.stdout).join(''),
    stderr: steps.map(s => s.stderr).join(''),
  });
}

function evaluateArgsExpressions(
  args: string[] | undefined,
  action: ParsedAction,
  input: RunInput,
  inputValues: Record<string, string>,
): string[] {
  if (!args || args.length === 0) return [];
  const jobStatus: JobStatus = { success: true, failure: false, cancelled: false };
  const ctx = buildContexts(input, inputValues, {}, {}, jobStatus);
  return args.map(arg => {
    try {
      return String(evaluateTemplate(String(arg), ctx));
    } catch {
      return String(arg);
    }
  });
}
