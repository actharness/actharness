import { readFileSync } from 'fs';
import { join } from 'path';
import { load as yamlLoad } from 'js-yaml';
import { runInSandbox, type MockRoutes } from './sandbox.js';

// ── Manifest types ────────────────────────────────────────────────────────────

interface ActionManifest {
  name: string;
  inputs?: Record<string, { description?: string; required?: boolean; default?: string }>;
  outputs?: Record<string, { description?: string }>;
  runs: {
    using: string;
    pre?: string;
    'pre-if'?: string;
    main: string;
    post?: string;
    'post-if'?: string;
  };
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface PhaseResult {
  phase: 'pre' | 'main' | 'post';
  conclusion: 'success' | 'failure';
  exitCode: number;
  outputs: Record<string, string>;
  stdout: string;
  stderr: string;
  annotations: Array<{ level: string; message: string }>;
}

export interface RunResult {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  steps: PhaseResult[];
}

export interface RunOptions {
  inputs?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  github?: { repository?: string; token?: string };
  mockGitHubApi?: MockRoutes;
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runAction(actionDir: string, options: RunOptions = {}): Promise<RunResult> {
  const manifest = loadManifest(actionDir);
  const baseEnv = buildEnv(manifest, options);
  const steps: PhaseResult[] = [];
  // Accumulated state written via core.saveState(), threaded as STATE_* env vars.
  let state: Record<string, string> = {};

  if (manifest.runs.pre) {
    const r = await runPhase(actionDir, manifest.runs.pre, 'pre', baseEnv, state, options.mockGitHubApi);
    steps.push(r);
    state = { ...state, ...r._state };
  }

  const mainResult = await runPhase(actionDir, manifest.runs.main, 'main', baseEnv, state, options.mockGitHubApi);
  steps.push(mainResult);
  state = { ...state, ...mainResult._state };

  if (manifest.runs.post) {
    const r = await runPhase(actionDir, manifest.runs.post, 'post', baseEnv, state, options.mockGitHubApi);
    steps.push(r);
  }

  const conclusion: 'success' | 'failure' = steps.some(s => s.conclusion === 'failure') ? 'failure' : 'success';
  // The action's declared outputs come from the main phase's $GITHUB_OUTPUT.
  const outputs = mainResult.outputs;

  return { conclusion, outputs, steps };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadManifest(actionDir: string): ActionManifest {
  const ymlPath = join(actionDir, 'action.yml');
  return yamlLoad(readFileSync(ymlPath, 'utf8')) as ActionManifest;
}

function buildEnv(manifest: ActionManifest, options: RunOptions): Record<string, string> {
  const inputEnv: Record<string, string> = {};

  // Apply defaults from manifest first.
  for (const [name, meta] of Object.entries(manifest.inputs ?? {})) {
    if (meta.default !== undefined) {
      inputEnv[toInputEnvKey(name)] = meta.default;
    }
  }
  // User-supplied inputs override defaults.
  for (const [name, value] of Object.entries(options.inputs ?? {})) {
    inputEnv[toInputEnvKey(name)] = String(value);
  }

  return {
    // Minimal GitHub context — enough for @actions/github context.repo to work.
    GITHUB_REPOSITORY: options.github?.repository ?? 'actspec/test-repo',
    GITHUB_TOKEN: options.github?.token ?? 'ghs_fakefakefake',
    GITHUB_SHA: 'aabbccddaabbccddaabbccddaabbccddaabbccdd',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_ACTOR: 'test-actor',
    GITHUB_WORKFLOW: 'test-workflow',
    GITHUB_RUN_ID: '9999999999',
    GITHUB_RUN_NUMBER: '1',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_TEMP: '/tmp',
    RUNNER_TOOL_CACHE: '/tmp/tool-cache',
    ...inputEnv,
    ...options.env,
  };
}

function toInputEnvKey(name: string): string {
  return `INPUT_${name.toUpperCase().replace(/ /g, '_')}`;
}

// Internal phase result with the raw state map for threading.
type PhaseResultInternal = PhaseResult & { _state: Record<string, string> };

async function runPhase(
  actionDir: string,
  entrypointFile: string,
  phase: 'pre' | 'main' | 'post',
  baseEnv: Record<string, string>,
  state: Record<string, string>,
  mockRoutes?: MockRoutes,
): Promise<PhaseResultInternal> {
  // Thread state from prior phases as STATE_<KEY> env vars.
  const stateEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(state)) {
    stateEnv[`STATE_${key}`] = value;
  }

  const result = await runInSandbox({
    entrypoint: join(actionDir, entrypointFile),
    env: baseEnv,
    stateEnv,
    mockRoutes,
  });

  return {
    phase,
    conclusion: result.exitCode === 0 ? 'success' : 'failure',
    exitCode: result.exitCode,
    outputs: result.outputs,
    stdout: result.stdout,
    stderr: result.stderr,
    annotations: result.annotations,
    _state: result.state,
  };
}
