// Public API types — extended from api-ergonomics spike to cover workflow spike needs.
// Key addition: JobResult.conclusion is wider than RunResult.conclusion (H3 finding).

export interface RunResult {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  steps: StepResult[];
  step(id: string): StepResult | undefined;
  env: Record<string, string>;
  annotations: Annotation[];
  readonly stdout: string;
  readonly stderr: string;
}

export interface StepResult {
  id: string;
  name: string;
  phase: 'pre' | 'main' | 'post';
  ran: boolean;
  outcome: 'success' | 'failure' | 'skipped';
  conclusion: 'success' | 'failure' | 'skipped';
  outputs: Record<string, string>;
  if?: { expression: string; result: boolean };
  uses?: { ref: string; mocked: boolean };
  stdout: string;
  stderr: string;
}

export interface Annotation {
  level: 'error' | 'warning' | 'notice' | 'debug';
  message: string;
  file?: string;
  line?: number;
  col?: number;
}

export interface RunInput {
  inputs?: Record<string, string | number | boolean>;
  env?: Record<string, string>;
  github?: Partial<GitHubContext>;
  runner?: Partial<RunnerContext>;
  secrets?: Record<string, string>;
  jobStatus?: 'success' | 'failure' | 'cancelled';
}

export interface GitHubContext {
  repository: string;
  repositoryOwner: string;
  sha: string;
  ref: string;
  refName: string;
  refType: string;
  actor: string;
  eventName: string;
  workflow: string;
  runId: string;
  runNumber: string;
  runAttempt: string;
  serverUrl: string;
  apiUrl: string;
  [key: string]: unknown;
}

export interface RunnerContext {
  os: string;
  arch: string;
  name: string;
  temp: string;
  toolCache: string;
}

// ── Mock types ────────────────────────────────────────────────────────────────

export interface ActionMockDef {
  outputs?: Record<string, string>;
  conclusion?: 'success' | 'failure';
  env?: Record<string, string>;
}

export type ActionMockImpl = (call: {
  with: Record<string, string>;
  env: Record<string, string>;
}) => ActionMockDef | Promise<ActionMockDef> | void;

export interface ActionMockCall {
  with: Record<string, string>;
  env: Record<string, string>;
  outputs: Record<string, string>;
}

export interface ActionMock {
  readonly calls: ActionMockCall[];
  readonly called: boolean;
  readonly callCount: number;
  mockOutputs(outputs: Record<string, string>): this;
  mockConclusion(c: 'success' | 'failure'): this;
  mockImplementation(impl: ActionMockImpl): this;
  mockImplementationOnce(impl: ActionMockImpl): this;
  clear(): void;
}

export interface GitHubApiRoutes { [pattern: string]: unknown }

// ── Parsed manifest types ─────────────────────────────────────────────────────

export interface ParsedInput { description?: string; required?: boolean; default?: string }
export interface ParsedOutput { description?: string; value?: string }

export interface ParsedStep {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  with?: Record<string, string>;
  run?: string;
  shell?: string;
  env?: Record<string, string>;
  'working-directory'?: string;
  'continue-on-error'?: boolean | string;
  'timeout-minutes'?: number;
}

export interface ParsedAction {
  name: string;
  description?: string;
  inputs?: Record<string, ParsedInput>;
  outputs?: Record<string, ParsedOutput>;
  runs: {
    using: string;
    // composite
    steps?: ParsedStep[];
    // node
    pre?: string; 'pre-if'?: string;
    main?: string; post?: string; 'post-if'?: string;
    // docker
    image?: string;
    entrypoint?: string;
    args?: string[];
    env?: Record<string, string>;
    'pre-entrypoint'?: string;
    'post-entrypoint'?: string;
  };
}

export interface ParsedStrategy {
  matrix?: Record<string, unknown[]> & {
    include?: Record<string, unknown>[];
    exclude?: Record<string, unknown>[];
  };
  'fail-fast'?: boolean;
  'max-parallel'?: number;
}

export interface ParsedJob {
  name?: string;
  needs?: string | string[];
  'runs-on': string;
  if?: string;
  steps: ParsedStep[];
  outputs?: Record<string, string>;
  strategy?: ParsedStrategy;
}

export interface ParsedWorkflow {
  name?: string;
  on?: unknown;
  jobs: Record<string, ParsedJob>;
}

// ── Workflow result types ─────────────────────────────────────────────────────
//
// FINDING (H3): JobResult.conclusion must be wider than RunResult.conclusion.
// RunResult.conclusion is 'success' | 'failure' — sufficient for action results.
// JobResult needs 'skipped' (if: false or needs failed) and 'cancelled' (fail-fast).
// TypeScript does not allow widening an inherited property via `extends`, so
// JobResult uses Omit<RunResult, 'conclusion'> and explicitly declares conclusion.
// This is a v0.1-blocking finding: API.md §4 and §10 need to reflect this.

export interface JobResult extends Omit<RunResult, 'conclusion'> {
  conclusion: 'success' | 'failure' | 'skipped' | 'cancelled';
  id: string;
  outputs: Record<string, string>;
  matrix?: Record<string, unknown>;
  needs: string[];
  outcome: 'success' | 'failure' | 'skipped' | 'cancelled';
}

export interface WorkflowResult {
  conclusion: 'success' | 'failure' | 'cancelled';
  jobs: JobResult[];
  job(id: string): JobResult | undefined;
  annotations: Annotation[];
}

// ── ActspecOptions ────────────────────────────────────────────────────────────

export type UnmockedUsesPolicy = 'error' | 'noop' | 'real';

export interface ActspecOptions {
  unmockedUses?: UnmockedUsesPolicy | { local?: UnmockedUsesPolicy; remote?: UnmockedUsesPolicy };
  shell?: boolean;
  workspace?: 'temp' | string;
  keepWorkspace?: boolean;
  defaults?: RunInput;
  container?: 'mock' | 'docker' | 'podman';
}

// ── wouldTrigger types (API.md §10) ──────────────────────────────────────────

export interface TriggerInput {
  event: string;
  ref?: string;
  changedFiles?: string[];
  payload?: unknown;
  at?: Date | string;
  workflowRun?: { name: string; conclusion: string; branch?: string };
}

export interface TriggerResult {
  triggered: boolean;
  jobs: string[];
  reason?: string;
}

// ── WorkflowRunInput ──────────────────────────────────────────────────────────

export interface WorkflowRunInput extends RunInput {
  event?: string;
  job?: string;
  inputs?: Record<string, string | number | boolean>;
  secrets?: Record<string, string> | 'inherit';
  matrix?: Record<string, unknown>;
}

// ── JobMockDef ────────────────────────────────────────────────────────────────

export interface JobMockDef {
  outputs?: Record<string, string>;
  result?: 'success' | 'failure' | 'skipped';
}
