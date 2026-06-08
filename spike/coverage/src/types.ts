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

export interface GitHubApiRoutes {
  [pattern: string]: unknown;
}

export interface ParsedInput {
  description?: string;
  required?: boolean;
  default?: string;
}

export interface ParsedOutput {
  description?: string;
  value?: string;
}

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
    steps?: ParsedStep[];
    pre?: string;
    'pre-if'?: string;
    main?: string;
    post?: string;
    'post-if'?: string;
  };
}

export interface ParsedJob {
  name?: string;
  needs?: string | string[];
  'runs-on': string;
  if?: string;
  steps: ParsedStep[];
  outputs?: Record<string, string>;
}

export interface ParsedWorkflow {
  name?: string;
  on?: unknown;
  jobs: Record<string, ParsedJob>;
}

export interface JobResult extends RunResult {
  id: string;
  needs: string[];
  outcome: 'success' | 'failure' | 'skipped' | 'cancelled';
}

export interface WorkflowResult {
  conclusion: 'success' | 'failure' | 'cancelled';
  jobs: JobResult[];
  job(id: string): JobResult | undefined;
  annotations: Annotation[];
}

export type UnmockedUsesPolicy = 'error' | 'noop' | 'real';

export interface ActspecOptions {
  unmockedUses?: UnmockedUsesPolicy | { local?: UnmockedUsesPolicy; remote?: UnmockedUsesPolicy };
  shell?: boolean;
  workspace?: 'temp' | string;
  keepWorkspace?: boolean;
  defaults?: RunInput;
}
