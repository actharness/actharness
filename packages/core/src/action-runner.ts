// actharness() entry point — creates an Action handle.
// ActionRunner.run() builds the context, dispatches to the registered executor,
// and packages the ExecutionResult into a RunResult.

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  ParsedAction,
  RunInput,
  RunResult,
  StepResult,
  ActharnessOptions,
} from '@actharness/types';
import { parseAction } from './parser.js';
import {
  buildContexts,
  createContextStore,
} from './context.js';
import { allocateProtocolFiles } from './protocol.js';
import { MockRegistry } from './mock-resolver.js';
import {
  getExecutor,
  type ExecutionCall,
  type ExecutionResult,
} from './executor-registry.js';
import {
  resolveDeterminism,
  createJobStatus,
} from './determinism.js';
import { notifyRunSink } from './run-sink.js';
import { ConfigError } from './errors.js';

// Shared stateless registry instance — resolve() reads from the scope chain.
const sharedRegistry = new MockRegistry();

// ── Action handle (public) ────────────────────────────────────────────────────

export interface Action {
  readonly manifest: ParsedAction;
  readonly type: string;
  /** Execute the action and return the result. */
  run(input?: RunInput): Promise<RunResult>;
}

// ── RunResult implementation ──────────────────────────────────────────────────

function buildRunResult(opts: {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  steps: StepResult[];
  env: Record<string, string>;
  annotations: import('@actharness/types').Annotation[];
  stdout: string;
  stderr: string;
}): RunResult {
  return {
    conclusion: opts.conclusion,
    outputs: opts.outputs,
    steps: opts.steps,
    step(id: string) { return opts.steps.find((s) => s.id === id); },
    env: opts.env,
    annotations: opts.annotations,
    stdout: opts.stdout,
    stderr: opts.stderr,
  };
}

// ── dispatch (core-internal) ──────────────────────────────────────────────────

async function dispatchAction(call: ExecutionCall): Promise<ExecutionResult> {
  const using = call.action.runs.using;
  const executor = getExecutor(using);

  if (!executor) {
    throw new ConfigError(
      `No executor registered for 'runs.using: ${using}'. ` +
      `Import '@actharness/composite' to enable composite action support.`,
    );
  }

  return executor.execute(call);
}

// ── ActionImpl ────────────────────────────────────────────────────────────────

class ActionImpl implements Action {
  readonly manifest: ParsedAction;
  readonly type: string;
  private readonly _options: ActharnessOptions;

  constructor(manifest: ParsedAction, options: ActharnessOptions) {
    this.manifest = manifest;
    this.type = manifest.runs.using;
    this._options = options;
  }

  async run(input: RunInput = {}): Promise<RunResult> {
    return runAction(this.manifest, this._options, input);
  }
}

// ── runAction (internal) ──────────────────────────────────────────────────────

async function runAction(
  manifest: ParsedAction,
  options: ActharnessOptions,
  input: RunInput,
): Promise<RunResult> {
  const det = resolveDeterminism(
    input.determinism ?? options.determinism,
  );

  // Workspace starts empty — `options.workspace`, if set, is only copied in once a
  // checkout-like `uses:` step actually executes (see step-runner.ts's execUsesStep),
  // matching real GitHub Actions: the workspace has no repo content until checkout runs.
  const workspaceParent = options.tempDir ?? tmpdir();
  const workspace = mkdtempSync(join(workspaceParent, 'actharness-ws-'));
  mkdirSync(workspace, { recursive: true });

  const initialJobStatus = input.jobStatus ?? 'success';
  const jobStatus = createJobStatus(initialJobStatus);

  const { github, runner, inputs, env, secrets, matrix, needs } = buildContexts(
    manifest,
    input,
    workspace,
    det.runId,
    det.now,
    jobStatus,
  );

  const store = createContextStore({
    github,
    runner,
    inputs,
    env,
    secrets,
    matrix,
    needs,
    jobStatus,
  });

  const protocol = allocateProtocolFiles();

  store.github.workspace = workspace;
  store.github.env = protocol.env;
  store.github.path = protocol.path;

  const call: ExecutionCall = {
    action: manifest,
    inputs,
    context: store,
    protocol,
    mocks: sharedRegistry,
    options,
    sandbox: {
      async shell(_opts) {
        throw new ConfigError(
          `Cannot execute 'run:' steps: no sandbox registered. ` +
          `Import '@actharness/composite' to enable shell execution.`,
        );
      },
    },
    cycleGuard: [manifest._dir!],
    depth: 0,
    dispatch: dispatchAction,
  };

  let executionResult: ExecutionResult;
  try {
    executionResult = await dispatchAction(call);
  } finally {
    if (!options.keepWorkspace) {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  const result = buildRunResult({
    conclusion: executionResult.conclusion,
    outputs: executionResult.outputs,
    steps: executionResult.steps ?? [],
    env: store.env,
    annotations: executionResult.annotations ?? store.annotations,
    stdout: executionResult.stdout ?? '',
    stderr: executionResult.stderr ?? '',
  });

  const rawInputs = input.inputs ?? {};
  const inputsExercised: Record<string, 'provided' | 'default'> = {};
  for (const name of Object.keys(manifest.inputs ?? {})) {
    inputsExercised[name] = name in rawInputs ? 'provided' : 'default';
  }

  notifyRunSink(result, {
    sourceFile: manifest._file,
    inputsExercised,
    jsCoverage: executionResult.jsCoverage,
    shellCoverage: executionResult.shellCoverage,
  });

  return result;
}

// ── Public API ────────────────────────────────────────────────────────────────

// Walk a captured stack string to find the first caller directory.
// slice(2) skips the Error header line and the actharness frame (which always
// holds the `new Error()` call), leaving only the true caller frames.
// Skips node_modules (test-runner proxy frames).
// Returns process.cwd() when no file:// frame is found (safe fallback).
// Exported for unit testing — not part of the public package API.
export function _dirFromStack(stack: string): string {
  for (const frame of stack.split('\n').slice(2)) {
    if (frame.includes('node_modules')) continue;
    const m = frame.match(/(?:file:\/\/)?(\/.+?):\d+:\d+/);
    if (m) return dirname(m[1]!);
  }
  return process.cwd();
}

/**
 * Load an action manifest and return an Action handle.
 * @param source  Path to an action directory or action.yml file.
 *                Relative paths (./  or ../) are resolved relative to the
 *                calling file, so actharness('./action.yml') always works.
 */
export function actharness(source: string, options: ActharnessOptions = {}): Action {
  const callerDir = _dirFromStack(new Error().stack!);
  if (source.startsWith('./') || source.startsWith('../')) {
    source = resolve(callerDir, source);
  }
  if (options.workspace && (options.workspace.startsWith('./') || options.workspace.startsWith('../'))) {
    options = { ...options, workspace: resolve(callerDir, options.workspace) };
  }
  const manifest = parseAction(source);
  return new ActionImpl(manifest, options);
}
