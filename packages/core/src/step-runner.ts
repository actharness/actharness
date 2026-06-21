// Action-agnostic step loop.
// Takes ParsedStep[] + ContextStore; knows nothing about ParsedAction.
// Composite executor calls this with its action's steps.

import type { ParsedStep, StepResult, Annotation, ActharnessOptions } from '@actharness/types';
import type { ContextStore } from './context.js';
import {
  updateStoreStep,
  mergeStoreEnv,
  evalExpression,
  evalTemplate,
} from './context.js';
import { markJobFailure } from './determinism.js';
import {
  parseEnvFile,
  parsePathFile,
  parseStdoutCommands,
  allocateProtocolFiles,
  applyMasks,
} from './protocol.js';
import type { SandboxFactory, ShellSandboxResult, ExecutionCall, ExecutionResult } from './executor-registry.js';
import type { ProtocolFiles } from './protocol.js';
import type { MockRegistry } from './mock-resolver.js';
import { checkCycle, checkMaxDepth } from './mock-resolver.js';
import { resolve } from 'node:path';
import { cpSync, statSync } from 'node:fs';
import { ConfigError } from './errors.js';

// `uses:` refs that this harness treats as "the action that populates the workspace
// from the repo" — matched to decide when to copy `actharnessOptions.workspace` (the
// seed-source option) into the real runtime workspace dir. Intentionally narrow (the
// canonical action) rather than every checkout-like fork, to keep the gating predictable.
const CHECKOUT_REF_PATTERN = /^actions\/checkout(@.*)?$/;

// ── StepRunnerOptions ─────────────────────────────────────────────────────────

export interface StepRunnerOptions {
  workspace: string;
  actionDir: string;
  sandbox: SandboxFactory;
  mocks: MockRegistry;
  actharnessOptions: ActharnessOptions;
  dispatch: (call: ExecutionCall) => Promise<ExecutionResult>;
  cycleGuard: string[];
  depth: number;
  /** Source file path for diagnostic messages. */
  filePath?: string | undefined;
  /** Opaque run identifier; enables pwsh session reuse when present. */
  runId?: string | undefined;
  /** pwsh isolation mode for this run. Default 'runspace'. */
  pwshIsolation?: 'runspace' | 'process' | undefined;
}

// ── StepRunnerResult ──────────────────────────────────────────────────────────

export interface StepRunnerResult {
  steps: StepResult[];
  finalEnv: Record<string, string>;
  annotations: Annotation[];
  stdout: string;
  stderr: string;
}

// ── Shell selection ───────────────────────────────────────────────────────────

function resolveShell(
  stepShell: string | undefined,
  runnerOs: string,
  defaultShell: string | undefined,
): string {
  if (stepShell) return stepShell;
  if (defaultShell) return defaultShell;
  // GitHub default: bash on Linux/macOS, pwsh on Windows
  return runnerOs === 'Windows' ? 'pwsh' : 'bash';
}

// ── Run a single `run:` step ──────────────────────────────────────────────────

async function execRunStep(
  step: ParsedStep,
  store: ContextStore,
  proto: ProtocolFiles,
  opts: StepRunnerOptions,
): Promise<ShellSandboxResult> {
  const script = evalTemplate(step.run!, store, opts.filePath);
  const shell = resolveShell(
    step.shell,
    store.runner.os,
    typeof opts.actharnessOptions.shell === 'object' ? opts.actharnessOptions.shell.default : undefined,
  );

  // Build step-level env: base env + step env overrides
  const stepEnv: Record<string, string> = {};
  if (step.env) {
    for (const [k, v] of Object.entries(step.env)) {
      stepEnv[k] = evalTemplate(v, store, opts.filePath);
    }
  }

  // Build complete env injected into the shell process
  const shellEnv: Record<string, string> = {
    ...store.env,
    ...stepEnv,
    // Protocol file paths as env vars (fresh per step)
    GITHUB_OUTPUT: proto.output,
    GITHUB_ENV: proto.env,
    GITHUB_PATH: proto.path,
    GITHUB_STATE: proto.state,
    GITHUB_STEP_SUMMARY: proto.summary,
  };

  const cwd = step['working-directory']
    ? resolve(opts.workspace, evalTemplate(step['working-directory'], store, opts.filePath))
    : opts.workspace;

  const timeout = step['timeout-minutes'];
  const timeoutMs = timeout ? timeout * 60_000 : undefined;

  return opts.sandbox.shell({
    script,
    shell,
    env: shellEnv,
    cwd,
    timeout: timeoutMs,
    coverage: !!process.env['ACTHARNESS_COVERAGE_TMP'],
    runId: opts.runId,
    pwshIsolation: opts.pwshIsolation,
  });
}

// ── Run a single `uses:` step ─────────────────────────────────────────────────

async function execUsesStep(
  step: ParsedStep,
  store: ContextStore,
  proto: ProtocolFiles,
  opts: StepRunnerOptions,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  mocked: boolean;
  childOutputs: Record<string, string>;
  childEnv: Record<string, string>;
  withInputs: Record<string, string>;
}> {
  const ref = step.uses!;

  // Seed the workspace the moment a checkout-like step runs — regardless of whether
  // that step resolves as a mock, a no-op, or real local execution below. This is what
  // makes `options.workspace` faithful to real GitHub Actions: files aren't present
  // until something that "is" checkout actually executes, not from the start of the run.
  const seedFrom = opts.actharnessOptions.workspace;
  if (seedFrom && CHECKOUT_REF_PATTERN.test(ref)) {
    let seedStat;
    try {
      seedStat = statSync(seedFrom);
    } catch {
      throw new ConfigError(`options.workspace points to a path that does not exist: '${seedFrom}'`);
    }
    if (!seedStat.isDirectory()) {
      throw new ConfigError(`options.workspace must be a directory, got a file: '${seedFrom}'`);
    }
    cpSync(seedFrom, opts.workspace, { recursive: true });
  }

  const resolution = opts.mocks.resolve(ref, opts.actionDir, opts.actharnessOptions);

  // Evaluate with: inputs as templates
  const withInputs: Record<string, string> = {};
  if (step.with) {
    for (const [k, v] of Object.entries(step.with)) {
      withInputs[k] = evalTemplate(v, store, opts.filePath);
    }
  }

  // Evaluate step env as templates
  const stepEnv: Record<string, string> = {};
  if (step.env) {
    for (const [k, v] of Object.entries(step.env)) {
      stepEnv[k] = evalTemplate(v, store, opts.filePath);
    }
  }
  const callEnv = { ...store.env, ...stepEnv };

  if (resolution.kind === 'mock') {
    const { outputs, env, conclusion } = await resolution.handle.resolve({
      with: withInputs,
      env: callEnv,
    });
    return {
      exitCode: conclusion === 'success' ? 0 : 1,
      stdout: '',
      stderr: '',
      timedOut: false,
      mocked: true,
      childOutputs: outputs,
      childEnv: env,
      withInputs,
    };
  }

  if (resolution.kind === 'noop') {
    // Emit warning annotation and return empty
    store.annotations.push({ level: 'warning', message: resolution.warning });
    return {
      exitCode: 0,
      stdout: '',
      stderr: '',
      timedOut: false,
      mocked: false,
      childOutputs: {},
      childEnv: {},
      withInputs,
    };
  }

  // Real local execution — parse + dispatch child action
  const { parseAction } = await import('./parser.js');
  const childDir = resolve(opts.actionDir, ref);
  checkCycle(opts.cycleGuard, childDir);
  checkMaxDepth(opts.depth + 1);

  const childAction = parseAction(childDir);

  // Resolve child inputs against the child's manifest
  const { resolveInputValues } = await import('./context.js');
  const childInputs = resolveInputValues(childAction, withInputs);

  const childProto = allocateProtocolFiles();
  const childCall: ExecutionCall = {
    action: childAction,
    inputs: childInputs,
    context: store,
    protocol: childProto,
    mocks: opts.mocks,
    sandbox: opts.sandbox,
    options: opts.actharnessOptions,
    cycleGuard: [...opts.cycleGuard, childDir],
    depth: opts.depth + 1,
    dispatch: opts.dispatch,
  };

  const childResult = await opts.dispatch(childCall);

  return {
    exitCode: childResult.conclusion === 'success' ? 0 : 1,
    stdout: '',
    stderr: '',
    timedOut: false,
    mocked: false,
    childOutputs: childResult.outputs,
    childEnv: childResult.env,
    withInputs,
  };
}

// ── Main step loop ────────────────────────────────────────────────────────────

export async function runSteps(
  steps: ParsedStep[],
  store: ContextStore,
  opts: StepRunnerOptions,
): Promise<StepRunnerResult> {
  const stepResults: StepResult[] = [];
  const allAnnotations: Annotation[] = [];
  let allStdout = '';
  let allStderr = '';

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepIndex = i + 1;
    const stepId = step.id ?? `__step_${stepIndex}__`;
    const stepName = step.name ?? step.uses ?? (step.run ? `Run ${step.run.slice(0, 40).split('\n')[0]!}` : `Step ${stepIndex}`);

    // ── 1. Evaluate if: (default: success()) ────────────────────────────────
    const ifExpr = step.if ?? 'success()';
    let shouldRun: boolean;
    let evaluatedIf: { expression: string; result: boolean } | undefined;

    try {
      const ifResult = evalExpression(ifExpr, store, opts.filePath);
      shouldRun = Boolean(ifResult);
      evaluatedIf = { expression: ifExpr, result: shouldRun };
    } catch {
      shouldRun = false;
      evaluatedIf = { expression: ifExpr, result: false };
    }

    // ── 2. Skipped step ──────────────────────────────────────────────────────
    if (!shouldRun) {
      const skippedEntry = {
        id: stepId,
        name: String(stepName),
        phase: 'main' as const,
        ran: false,
        outcome: 'skipped' as const,
        conclusion: 'skipped' as const,
        outputs: {},
        if: evaluatedIf,
        annotations: [] as import('@actharness/types').Annotation[],
        stdout: '',
        stderr: '',
      };
      stepResults.push(skippedEntry);
      if (step.id) {
        updateStoreStep(store, step.id, {
          outputs: {},
          outcome: 'skipped',
          conclusion: 'skipped',
        });
      }
      continue;
    }

    // ── 3. Execute step ──────────────────────────────────────────────────────
    const proto = allocateProtocolFiles();
    let exitCode = 0;
    let rawStdout = '';
    let rawStderr = '';
    let timedOut = false;
    let mocked = false;
    let childOutputs: Record<string, string> = {};
    let childEnv: Record<string, string> = {};
    let usesWithInputs: Record<string, string> = {};
    let renderInfo: StepResult['render'] | undefined;

    let stepShellCoverage: import('@actharness/types').StepResult['shellCoverage'];

    try {
      if (step.run !== undefined) {
        const result = await execRunStep(step, store, proto, opts);
        exitCode = result.exitCode;
        rawStdout = result.stdout;
        rawStderr = result.stderr;
        timedOut = result.timedOut;
        if (result.shellCoverage) {
          stepShellCoverage = result.shellCoverage;
        }

        // Build render info for diagnostics
        const script = evalTemplate(step.run, store, opts.filePath);
        const shell = resolveShell(
          step.shell,
          store.runner.os,
          typeof opts.actharnessOptions.shell === 'object' ? opts.actharnessOptions.shell.default : undefined,
        );
        const stepEnv: Record<string, string> = {};
        if (step.env) {
          for (const [k, v] of Object.entries(step.env)) {
            stepEnv[k] = evalTemplate(v, store, opts.filePath);
          }
        }
        renderInfo = {
          script,
          shell,
          env: { ...store.env, ...stepEnv },
          cwd: step['working-directory']
            ? resolve(opts.workspace, evalTemplate(step['working-directory'], store, opts.filePath))
            : opts.workspace,
        };
      } else if (step.uses !== undefined) {
        const result = await execUsesStep(step, store, proto, opts);
        exitCode = result.exitCode;
        rawStdout = result.stdout;
        rawStderr = result.stderr;
        timedOut = result.timedOut;
        mocked = result.mocked;
        childOutputs = result.childOutputs;
        childEnv = result.childEnv;
        usesWithInputs = result.withInputs;
      }
    } catch (e) {
      exitCode = 1;
      rawStderr = String(e);
    }

    // ── 4. Process stdout commands ───────────────────────────────────────────
    const cmdResult = parseStdoutCommands(rawStdout);
    for (const mask of cmdResult.masks) store.masks.add(mask);

    const maskedStdout = applyMasks(rawStdout, store.masks);
    const maskedStderr = applyMasks(rawStderr, store.masks);
    allStdout += maskedStdout;
    allStderr += maskedStderr;

    // ── 5. Read protocol files ───────────────────────────────────────────────
    const stepOutputs: Record<string, string> = {
      ...childOutputs,
      ...parseEnvFile(proto.output),
      // legacy ::set-output:: support
      ...cmdResult.legacyOutputs,
    };

    const newEnv: Record<string, string> = {
      ...childEnv,
      ...parseEnvFile(proto.env),
    };
    mergeStoreEnv(store, newEnv);

    // Prepend $GITHUB_PATH additions and legacy ::add-path:: entries to PATH
    const newPaths = [...parsePathFile(proto.path), ...cmdResult.addedPaths];
    if (newPaths.length > 0) {
      // Fall back to the process PATH so bash/sh remain findable after prepending.
      const currentPath = store.env['PATH'] ?? process.env['PATH'] ?? '';
      mergeStoreEnv(store, {
        PATH: [...newPaths, ...(currentPath ? [currentPath] : [])].join(':'),
      });
    }

    // ── 6. Determine outcome and conclusion ──────────────────────────────────
    let outcome: 'success' | 'failure' = exitCode === 0 ? 'success' : 'failure';
    if (timedOut) outcome = 'failure';

    let coeRaw = step['continue-on-error'];
    let continueOnError = false;
    if (coeRaw !== undefined && coeRaw !== false) {
      if (typeof coeRaw === 'boolean') {
        continueOnError = coeRaw;
      } else {
        // Expression string
        try {
          continueOnError = Boolean(evalExpression(coeRaw, store, opts.filePath));
        } catch {
          continueOnError = false;
        }
      }
    }

    const conclusion: 'success' | 'failure' =
      outcome === 'failure' && continueOnError ? 'success' : outcome;

    // ── 7. Update job status ─────────────────────────────────────────────────
    if (outcome === 'failure' && !continueOnError) {
      markJobFailure(store.jobStatus);
    }

    // ── 8. Update steps context ──────────────────────────────────────────────
    const stepsEntry = {
      outputs: stepOutputs,
      outcome,
      conclusion,
    };
    if (step.id) {
      updateStoreStep(store, step.id, stepsEntry);
    }

    // ── 9. Collect annotations ───────────────────────────────────────────────
    const stepAnnotations = [
      ...store.annotations.splice(0),
      ...cmdResult.annotations,
    ];
    allAnnotations.push(...stepAnnotations);

    // ── 10. Build StepResult ─────────────────────────────────────────────────
    const stepResult: StepResult = {
      id: stepId,
      name: String(stepName),
      phase: 'main',
      ran: true,
      outcome,
      conclusion,
      outputs: stepOutputs,
      if: evaluatedIf,
      annotations: stepAnnotations,
      stdout: maskedStdout,
      stderr: maskedStderr,
    };

    if (step.uses !== undefined) {
      const withCoverage: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(usesWithInputs)) {
        withCoverage[k] = v !== '';
      }
      stepResult.uses = { ref: step.uses, mocked, withCoverage };
    }

    if (step['timeout-minutes'] !== undefined) {
      stepResult.timeout = { minutes: step['timeout-minutes'], timedOut };
    }

    if (renderInfo) {
      stepResult.render = renderInfo;
    }

    if (stepShellCoverage) {
      stepResult.shellCoverage = stepShellCoverage;
    }

    stepResults.push(stepResult);
  }

  return {
    steps: stepResults,
    finalEnv: store.env,
    annotations: allAnnotations,
    stdout: allStdout,
    stderr: allStderr,
  };
}
