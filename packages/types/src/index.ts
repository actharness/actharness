// @actharness/types — zero-dep DAG root.
// All public interfaces and default constants. No functions, no classes, no side effects.

// ── Expression value (mirrors @actharness/expressions ExprValue without a dep) ──

export type ExprValue =
  | null
  | boolean
  | number
  | string
  | ExprValue[]
  | { [k: string]: ExprValue };

// ── Source position ───────────────────────────────────────────────────────────

export interface NodeRange {
  /** Byte offset of node start in source. */
  start: number;
  /** Byte offset of node end in source (exclusive). */
  end: number;
}

// ── Parsed manifest types ─────────────────────────────────────────────────────

export interface ParsedInput {
  description?: string;
  required?: boolean;
  default?: string;
  deprecationMessage?: string;
  /** Source byte-offset range for the full input definition block. Set by the parser. */
  _range?: NodeRange | undefined;
}

export interface ParsedOutput {
  description?: string;
  value?: string;
  _range?: NodeRange | undefined;
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
  /** Source byte-offset range for the full step block. Set by the parser. */
  _range?: NodeRange | undefined;
  /** Source byte-offset range for the `if:` value within this step. Set by the parser. */
  _ifRange?: NodeRange | undefined;
}

export interface ParsedActionRuns {
  using: string;
  // composite
  steps?: ParsedStep[];
  // node
  pre?: string;
  'pre-if'?: string;
  main?: string;
  post?: string;
  'post-if'?: string;
  // docker
  image?: string;
  entrypoint?: string;
  args?: string[];
  'pre-entrypoint'?: string;
  'post-entrypoint'?: string;
  // shared env (docker / node)
  env?: Record<string, string>;
  /** Source byte-offset range for the `main:` value. Set by the parser. */
  _mainRange?: NodeRange | undefined;
  /** Source byte-offset range for the `pre:` value. Set by the parser. */
  _preRange?: NodeRange | undefined;
  /** Source byte-offset range for the `post:` value. Set by the parser. */
  _postRange?: NodeRange | undefined;
  /** Source byte-offset range for the `pre-if:` value. Set by the parser. */
  _preIfRange?: NodeRange | undefined;
  /** Source byte-offset range for the `post-if:` value. Set by the parser. */
  _postIfRange?: NodeRange | undefined;
}

export interface ParsedAction {
  name: string;
  description?: string;
  inputs?: Record<string, ParsedInput>;
  outputs?: Record<string, ParsedOutput>;
  runs: ParsedActionRuns;
  /** Absolute path to the source file, if parsed from disk. Set by the parser. */
  _file?: string | undefined;
  /** Absolute path to the directory containing the action. Set by the parser. */
  _dir?: string | undefined;
}

// ── Contexts ──────────────────────────────────────────────────────────────────

export interface GitHubContext {
  repository: string;
  repository_owner: string;
  repository_id: string;
  actor: string;
  actor_id: string;
  triggering_actor: string;
  event_name: string;
  event: unknown;
  sha: string;
  run_id: string;
  run_number: string;
  run_attempt: string;
  ref: string;
  ref_name: string;
  ref_type: string;
  ref_protected: boolean;
  base_ref: string;
  head_ref: string;
  workflow: string;
  workflow_ref: string;
  job: string;
  token: string;
  retention_days: string;
  server_url: string;
  api_url: string;
  graphql_url: string;
  /** Absolute path to the workspace directory. Set at runtime by the runner. */
  workspace: string;
  /** The running action's id. Set at runtime. */
  action: string;
  /** Absolute path to the GITHUB_PATH temp file. Set at runtime. */
  path: string;
  /** Absolute path to the GITHUB_ENV temp file. Set at runtime. */
  env: string;
  /** Absolute path to the event.json temp file. Set at runtime. */
  event_path: string;
  [key: string]: unknown;
}

export interface RunnerContext {
  os: string;
  arch: string;
  name: string;
  temp: string;
  tool_cache: string;
  environment: string;
  debug: string;
}

// ── Default constants (single source of truth — CONTEXTS.md) ─────────────────

export const GITHUB_DEFAULTS: Readonly<GitHubContext> = {
  repository: 'owner/repo',
  repository_owner: 'owner',
  repository_id: '1',
  actor: 'octocat',
  actor_id: '1',
  triggering_actor: 'octocat',
  event_name: 'push',
  event: {},
  sha: '0000000000000000000000000000000000000000',
  run_id: '1',
  run_number: '1',
  run_attempt: '1',
  ref: 'refs/heads/main',
  ref_name: 'main',
  ref_type: 'branch',
  ref_protected: false,
  base_ref: '',
  head_ref: '',
  workflow: 'CI',
  workflow_ref: 'owner/repo/.github/workflows/ci.yml@refs/heads/main',
  job: 'test',
  token: 'ghs_stub_token_actharness',
  retention_days: '90',
  server_url: 'https://github.com',
  api_url: 'https://api.github.com',
  graphql_url: 'https://api.github.com/graphql',
  // Dynamic fields — set at runtime by @actharness/core; empty string is the placeholder.
  workspace: '',
  action: 'actharness',
  path: '',
  env: '',
  event_path: '',
};

export const RUNNER_DEFAULTS: Readonly<RunnerContext> = {
  os: 'Linux',
  arch: 'X64',
  name: 'actharness',
  temp: '/tmp/actharness-runner',
  tool_cache: '/opt/hostedtoolcache',
  environment: 'github-hosted',
  debug: '',
};

// ── Python coverage data ──────────────────────────────────────────────────────

export interface NodeCoverageData {
  /** Absolute path of the JS source file. */
  path: string;
  /** Raw V8 script coverage object for this file. */
  v8Data: unknown;
  /** Inline source text (used for temp scripts that are deleted before toCoverageReport runs). */
  source?: string;
}

export interface PythonCoverageData {
  executedLines: number[];
  missingLines: number[];
  executedBranches: [number, number][];
  missingBranches: [number, number][];
}

// ── Annotations ───────────────────────────────────────────────────────────────

export interface Annotation {
  level: 'error' | 'warning' | 'notice' | 'debug';
  message: string;
  file?: string | undefined;
  line?: number | undefined;
  col?: number | undefined;
}

// ── Expression trace (diagnostics:'trace' results) ────────────────────────────

export interface ExpressionTrace {
  expression: string;
  source?: { file: string; line: number; col: number } | undefined;
  nodes: Array<{ kind: string; text: string; value: ExprValue }>;
  result: ExprValue;
}

// ── Step and run results ──────────────────────────────────────────────────────

export interface StepResult {
  id: string;
  name: string;
  /** Lifecycle phase. Composite steps are always 'main'. */
  phase: 'pre' | 'main' | 'post';
  /** Whether the step executed (false = skipped by if:). */
  ran: boolean;
  /** Raw result before continue-on-error is applied. */
  outcome: 'success' | 'failure' | 'skipped';
  /** Result after continue-on-error. */
  conclusion: 'success' | 'failure' | 'skipped';
  /** This step's outputs (steps.<id>.outputs). */
  outputs: Record<string, string>;
  /** The evaluated if: condition, if any. */
  if?: { expression: string; result: boolean } | undefined;
  /** For uses: steps, the resolved ref, whether it hit a mock, and per-key with: coverage. */
  uses?: { ref: string; mocked: boolean; withCoverage?: Record<string, boolean> } | undefined;
  /** Declared timeout-minutes, and whether it was exceeded. */
  timeout?: { minutes: number; timedOut: boolean } | undefined;
  /** Diagnostics: rendered run: script (always present for run: steps). */
  render?: { script: string; shell: string; env: Record<string, string>; cwd: string } | undefined;
  /** Shell coverage from run: steps (only present when coverage is enabled). */
  shellCoverage?: { lineHits: Record<number, number> } | { pythonCoverageData: PythonCoverageData } | { nodeCoverageData: NodeCoverageData[] } | undefined;
  /** Expression eval trace (only when diagnostics:'trace'). */
  trace?: ExpressionTrace[] | undefined;
  /** Annotations emitted during this step (subset of RunResult.annotations). */
  annotations: Annotation[];
  stdout: string;
  stderr: string;
}

export interface RunResult {
  /** Overall conclusion (failure if any step failed without continue-on-error). */
  conclusion: 'success' | 'failure';
  /** Action-level outputs. */
  outputs: Record<string, string>;
  /** Steps in execution order. */
  steps: StepResult[];
  /** Lookup a step by id. */
  step(id: string): StepResult | undefined;
  /** Final environment state after all steps. */
  env: Record<string, string>;
  /** Annotations emitted during the run. */
  annotations: Annotation[];
  readonly stdout: string;
  readonly stderr: string;
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

export interface ActionMockDef {
  outputs?: Record<string, string> | undefined;
  conclusion?: 'success' | 'failure' | undefined;
  env?: Record<string, string> | undefined;
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

export interface ShellMockResult {
  stdout?: string | undefined;
  stderr?: string | undefined;
  exitCode?: number | undefined;
}

export type ShellCommandImpl =
  | ShellMockResult
  | ((cmd: string) => ShellMockResult | Promise<ShellMockResult>);

export interface ShellMockCall {
  cmd: string;
  result: ShellMockResult;
}

export interface ShellMock {
  readonly calls: ShellMockCall[];
  readonly called: boolean;
  readonly callCount: number;
  clear(): void;
}

// ── Network mocks (v0.2) ──────────────────────────────────────────────────────

/** Octokit REST-style route → static response body or function returning one. */
export type GitHubApiRouteResponse =
  | Record<string, unknown>
  | unknown[]
  | ((params: Record<string, string>) => Record<string, unknown> | unknown[]);

export type GitHubApiRoutes = Record<string, GitHubApiRouteResponse>;

/** URL pattern for arbitrary network interception. */
export type NetworkMatcher = string | RegExp | ((url: string, method: string) => boolean);

export interface NetworkMockCall {
  url: string;
  method: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  response: unknown;
  matchedPattern: string;
}

export interface NetworkMock {
  readonly calls: NetworkMockCall[];
  readonly called: boolean;
  readonly callCount: number;
  clear(): void;
}

// ── Run input ─────────────────────────────────────────────────────────────────

export interface Determinism {
  /** Frozen wall clock for the run. Default: a fixed epoch. false = real time. */
  now?: Date | number | false | undefined;
  /** Seed for the RNG. Default: a fixed seed. false = real random. */
  seed?: number | false | undefined;
  /** Stable run identifier. */
  runId?: string | undefined;
}

export interface RunInput {
  inputs?: Record<string, string | number | boolean> | undefined;
  env?: Record<string, string> | undefined;
  github?: Partial<GitHubContext> | undefined;
  runner?: Partial<RunnerContext> | undefined;
  secrets?: Record<string, string> | undefined;
  matrix?: Record<string, unknown> | undefined;
  eventPayload?: unknown;
  jobStatus?: 'success' | 'failure' | 'cancelled' | undefined;
  determinism?: Determinism | undefined;
}

// ── Action options ────────────────────────────────────────────────────────────

export interface ShellOptions {
  /** Override the default shell. */
  default?: string | undefined;
}

export interface ContainerBackend {
  type: string;
}

export interface ActharnessOptions {
  unmockedUses?:
    | 'error'
    | 'noop'
    | 'real'
    | { local?: 'error' | 'noop' | 'real' | undefined; remote?: 'error' | 'noop' | 'real' | undefined }
    | undefined;
  shell?: boolean | ShellOptions | undefined;
  /** Path to a directory to copy into the run's temp workspace, the moment a checkout-like
   *  `uses:` step (currently: `actions/checkout@*`) executes — not eagerly at the start of
   *  the run. Matches real GitHub Actions: the workspace has no repo content until checkout
   *  runs, so a step before checkout sees an empty workspace, same as on the real runner.
   *  If the action under test never has such a step, this is simply never used. Always a
   *  copy, never in-place. Relative paths resolve against the calling test file's directory
   *  (same convention as the `source` argument to `actharness()`). Omit for the default: an
   *  empty workspace for the whole run. */
  workspace?: string | undefined;
  /** Parent directory under which the disposable temp workspace dir is created.
   *  Default: os.tmpdir(). Unrelated to `workspace` above. */
  tempDir?: string | undefined;
  keepWorkspace?: boolean | undefined;
  determinism?: Determinism | undefined;
  diagnostics?: 'errors' | 'trace' | undefined;
  isolation?: 'scoped' | 'vm' | 'container' | 'deny-net' | undefined;
  defaults?: RunInput | undefined;
  container?: 'mock' | 'docker' | 'podman' | ContainerBackend | undefined;
  /** Override pwsh isolation mode. 'runspace' (default) reuses one pwsh process and isolates
   *  steps via Runspaces. 'process' spawns a dedicated pwsh process per step — complete
   *  isolation at the cost of ~500 ms/step. */
  pwshIsolation?: 'runspace' | 'process' | undefined;
  /** Maps dist entrypoint paths (as declared in action.yml) to source paths for test execution.
   *  Relative to each action's directory. Applied to all node22 actions in the run, including
   *  child actions dispatched via uses:. E.g. { 'dist/index.js': 'src/index.js' } */
  nodeSource?: Record<string, string> | undefined;
}
