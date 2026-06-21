// ActionExecutor interface + registry.
// Executors register themselves (composite, node, docker) via registerExecutor.
// Dispatch happens in action-runner via dispatchAction.

import type { ParsedAction, ActharnessOptions, PythonCoverageData, NodeCoverageData } from '@actharness/types';
import type { MockRegistry } from './mock-resolver.js';
import type { ContextStore } from './context.js';
import type { ProtocolFiles } from './protocol.js';

// ── SandboxFactory ────────────────────────────────────────────────────────────

export interface ShellSandboxOptions {
  script: string;
  shell: string;
  env: Record<string, string>;
  cwd: string;
  timeout?: number | undefined;
  coverage?: boolean | undefined;
  runId?: string | undefined;
  pwshIsolation?: 'runspace' | 'process' | undefined;
}

export interface ShellSandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  shellCoverage?: { lineHits: Record<number, number> } | { pythonCoverageData: PythonCoverageData } | { nodeCoverageData: NodeCoverageData[] } | undefined;
}

export interface SandboxFactory {
  shell(opts: ShellSandboxOptions): Promise<ShellSandboxResult>;
  endRun?(runId: string): void;
}

// ── ExecutionCall ─────────────────────────────────────────────────────────────
// Passed from ActionRunner to the executor; composite passes to StepRunner.

export interface ExecutionCall {
  /** The parsed action manifest. */
  action: ParsedAction;
  /** Resolved input values (defaults applied, coerced to strings). */
  inputs: Record<string, string>;
  /** Mutable context store for this invocation. */
  context: ContextStore;
  /** Protocol files allocated for this invocation. */
  protocol: ProtocolFiles;
  /** Per-handle mock registry. */
  mocks: MockRegistry;
  /** Shell/container sandbox provider. */
  sandbox: SandboxFactory;
  /** The ActharnessOptions passed to actharness()/run(), threaded through dispatch. */
  options: ActharnessOptions;
  /** Recursion path for cycle detection (list of action dirs). */
  cycleGuard: string[];
  /** Current recursion depth. */
  depth: number;
  /** Dispatch a child action (for local uses: recursion). */
  dispatch: (childCall: ExecutionCall) => Promise<ExecutionResult>;
}

// ── ExecutionResult ───────────────────────────────────────────────────────────

export interface ExecutionResult {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  env: Record<string, string>;
  /** Step-level results, if the executor runs steps (composite). */
  steps?: import('@actharness/types').StepResult[] | undefined;
  /** Annotations emitted during execution. */
  annotations?: import('@actharness/types').Annotation[] | undefined;
  /** Concatenated stdout from all steps. */
  stdout?: string | undefined;
  /** Concatenated stderr from all steps. */
  stderr?: string | undefined;
  /** v0.2: raw V8 script coverage from a node action's JsSandbox worker. */
  jsCoverage?: unknown;
  /** Shell coverage accumulated from composite run: steps. */
  shellCoverage?: Array<{ path: string; lineHits: Record<number, number> } | { path: string; pythonCoverageData: PythonCoverageData } | { path: string; nodeCoverageData: NodeCoverageData[] }> | undefined;
}

// ── ActionExecutor interface ──────────────────────────────────────────────────

export interface ActionExecutor {
  /** Return true if this executor handles the given `runs.using` string. */
  handles(using: string): boolean;
  /** Execute the action. The executor owns the step loop. */
  execute(call: ExecutionCall): Promise<ExecutionResult>;
}

// ── Registry ──────────────────────────────────────────────────────────────────

const REGISTRY: ActionExecutor[] = [];

export function registerExecutor(executor: ActionExecutor): void {
  REGISTRY.push(executor);
}

export function getExecutor(using: string): ActionExecutor | undefined {
  for (const e of REGISTRY) {
    if (e.handles(using)) return e;
  }
  return undefined;
}
