# actspec — Public API surface

The whole point: **the same three verbs regardless of action type.**

```ts
const action = actspec('./action.yml'); // composite, node, or docker — caller doesn't care
action.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });
const result = await action.run({ inputs: { name: 'World' } });
expect(result).toHaveSucceeded();
```

Everything below is the proposed surface. Types are the contract; prose is rationale.

---

## 1. Entry point

```ts
export function actspec(source: string | ActionSource, options?: ActspecOptions): Action;

/** A path to `action.yml`/`action.yaml` or its directory, inline YAML, or a pre-parsed manifest. */
type ActionSource =
  | { path: string }
  | { yaml: string }
  | { manifest: ParsedAction };

interface ActspecOptions {
  /** What to do when a `uses:` step isn't mocked.
   *  Default: local-vs-remote — { local: 'real', remote: 'noop' }.
   *  `real` only ever resolves local ./ ../ paths; a remote ref set to 'real' is a config error. */
  unmockedUses?: 'error' | 'noop' | 'real' | { local?: 'error' | 'noop' | 'real'; remote?: 'error' | 'noop' | 'real' };
  /** Execute `run:` steps in a real shell sandbox (true) or require them stubbed (false). Default: true. */
  shell?: boolean | ShellOptions;
  /** Workspace strategy for run: steps. 'temp' (default, auto-cleaned) or an explicit dir. */
  workspace?: 'temp' | string;
  /** Keep the temp workspace after the run for debugging. Default: false. */
  keepWorkspace?: boolean;
  /** Determinism (frozen by default — see below). Override per-run via RunInput too. */
  determinism?: Determinism;
  /** Diagnostics depth. 'errors' (default) | 'trace' (capture expression + run: render traces). */
  diagnostics?: 'errors' | 'trace';
  /** Sandbox hardening for untrusted actions. 'scoped' (default) | 'vm' | 'container' | 'deny-net'. */
  isolation?: 'scoped' | 'vm' | 'container' | 'deny-net';
  /** Context applied to *every* run() unless overridden per-call. */
  defaults?: RunInput;
  /** Container backend for docker actions (v0.3). Default: 'mock'. */
  container?: 'mock' | 'docker' | 'podman' | ContainerBackend;
}

interface Determinism {
  /** Frozen wall clock for the run. Default: a fixed epoch. `false` = real time. */
  now?: Date | number | false;
  /** Seed for the RNG exposed to actions/expressions. Default: a fixed seed. `false` = real random. */
  seed?: number | false;
  /** Stable identifiers. Default: deterministic. */
  runId?: string;
}
```

`actspec()` is synchronous: it parses and returns a handle. All execution is on `run()`. **Determinism is frozen by default** — fixed clock, seeded RNG, stable `GITHUB_RUN_ID`/`RUNNER_TEMP`/workspace paths — so snapshots are stable out of the box; opt into real time/random per field.

---

## 2. The `Action` handle

```ts
interface Action {
  /** Parsed manifest (read-only). */
  readonly manifest: ParsedAction;
  /** Discriminated by `runs.using`. */
  readonly type: 'composite' | 'node' | 'docker' | (string & {});

  // ── mocking (chainable; persists across run() calls until reset) ──
  /** Mock an action invoked via `uses:`, by ref. The primary, type-agnostic mock surface. */
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  /** Mock GitHub API / Octokit calls a JS action makes internally (v0.2). */
  mockGitHubApi(routes: GitHubApiRoutes): NetworkMock;
  /** Mock arbitrary network for a JS/composite child (v0.2). */
  mockNetwork(matcher: NetworkMatcher): NetworkMock;
  /** Stub a shell command inside run: steps (e.g. `git`, `curl`) for determinism. */
  mockShellCommand(cmd: string | RegExp, impl: ShellCommandImpl): ShellMock;

  /** Remove one mock (by ref) or all mocks. */
  unmock(ref?: string): void;
  /** Clear recorded calls but keep mock definitions. */
  clearMocks(): void;
  /** Remove all mocks entirely. */
  resetMocks(): void;

  // ── execution ──
  run(input?: RunInput): Promise<RunResult>;
}
```

> **Why one `mock()` for `uses:` and separate `mockGitHubApi`/`mockNetwork`?** A `uses:` target is a *dependency you call*; that's unified across composite/node/docker. What a JS action does *inside itself* (Octokit, fetch) is a different kind of dependency. Same mental model ("mock your dependencies"), honestly typed instead of one overloaded magic function.

---

## 3. Run input — the fixture for one execution

```ts
interface RunInput {
  /** Action inputs. Non-strings are coerced to strings, as the runner does. */
  inputs?: Record<string, string | number | boolean>;
  /** Seed environment (becomes the `env` context + process env for run: steps). */
  env?: Record<string, string>;
  /** `github` context overrides (repository, sha, ref, actor, eventName, …). */
  github?: Partial<GitHubContext>;
  /** `runner` context overrides (os, arch, temp, tool_cache, …). */
  runner?: Partial<RunnerContext>;
  /** Available secrets (also auto-masked in captured logs). */
  secrets?: Record<string, string>;
  /** `matrix` context. */
  matrix?: Record<string, unknown>;
  /** Convenience: sets `github.event` (and `event_name` if you pass it together). */
  eventPayload?: unknown;
  /** Simulated job status — drives success()/failure()/always()/cancelled(). Default 'success'. */
  jobStatus?: 'success' | 'failure' | 'cancelled';
  /** Per-run determinism override (clock/seed/runId). Merges over the handle's `determinism`. */
  determinism?: Determinism;
}
```

Anything omitted gets a documented default (`github.repository = 'owner/repo'`, `runner.os = 'Linux'`, …) so the simplest test is `await action.run()`.

---

## 4. Run result — the assertion target

```ts
interface RunResult {
  /** Overall conclusion (failure if any step failed without continue-on-error). */
  conclusion: 'success' | 'failure';
  /** Action-level outputs (composite: resolved `outputs.<name>.value`; node/docker: $GITHUB_OUTPUT merged across all phases that ran). */
  outputs: Record<string, string>;
  /** Steps in execution order (composite: many; node/docker: one StepResult per lifecycle phase that ran — up to three for pre/main/post). */
  steps: StepResult[];
  /** Lookup a step by id. */
  step(id: string): StepResult | undefined;
  /** Final environment state after all steps (seed + accumulated $GITHUB_ENV). */
  env: Record<string, string>;
  /** ::error::/::warning::/::notice:: emitted during the run. */
  annotations: Annotation[];
  /** Combined stdout/stderr across steps. */
  readonly stdout: string;
  readonly stderr: string;
}

interface StepResult {
  id: string;                 // explicit `id:` or a synthesized one
  name: string;
  /** Which lifecycle phase produced this result (JS/Docker actions have pre/main/post). */
  phase: 'pre' | 'main' | 'post';
  /** Did it execute (vs. skipped by `if:`)? */
  ran: boolean;
  /** Raw result before continue-on-error is applied. */
  outcome: 'success' | 'failure' | 'skipped';
  /** Result after continue-on-error. */
  conclusion: 'success' | 'failure' | 'skipped';
  /** This step's outputs (steps.<id>.outputs). */
  outputs: Record<string, string>;
  /** The evaluated `if:` condition, if any. */
  if?: { expression: string; result: boolean };
  /** For `uses:` steps, the resolved ref and whether it hit a mock. */
  uses?: { ref: string; mocked: boolean };
  /** Declared `timeout-minutes`, and whether it was exceeded (only with real time; see Coverage boundary). */
  timeout?: { minutes: number; timedOut: boolean };
  /** Diagnostics (always present for run: steps; eval trace only when diagnostics:'trace'). */
  render?: { script: string; shell: string; env: Record<string, string>; cwd: string };
  trace?: ExpressionTrace[];
  stdout: string;
  stderr: string;
}

interface Annotation {
  level: 'error' | 'warning' | 'notice' | 'debug';
  message: string;
  file?: string; line?: number; col?: number;
}
```

> `phase` is how pre/main/post stays on the unified surface: composite runs populate `main` (with children's `pre`/`post` interleaved as the runner orders them); a JS/Docker action yields up to three `StepResult`s. Filter with `result.steps.filter(s => s.phase === 'post')`.

---

## 5. Action mocks — spy + stub

```ts
interface ActionMockDef {
  /** Outputs the mocked action "sets". */
  outputs?: Record<string, string>;
  /** Force a conclusion (default 'success'). */
  conclusion?: 'success' | 'failure';
  /** Env this action contributes via $GITHUB_ENV. */
  env?: Record<string, string>;
}

/** Dynamic mock: receive the resolved `with:` inputs, return outputs. */
type ActionMockImpl = (call: {
  with: Record<string, string>;
  env: Record<string, string>;
}) => ActionMockDef | Promise<ActionMockDef> | void;

interface ActionMock {
  /** Recorded invocations, newest-last. Shaped to also satisfy native jest/vitest spy matchers. */
  readonly calls: ActionMockCall[];
  readonly called: boolean;
  readonly callCount: number;

  /** Re-stub after creation (chainable). */
  mockOutputs(outputs: Record<string, string>): this;
  mockConclusion(c: 'success' | 'failure'): this;
  mockImplementation(impl: ActionMockImpl): this;
  /** One-shot override for the next call only (queue). */
  mockImplementationOnce(impl: ActionMockImpl): this;
  clear(): void;
}

interface ActionMockCall {
  /** The `with:` block passed to the action, after expression evaluation. */
  with: Record<string, string>;
  /** Env visible to the action at call time. */
  env: Record<string, string>;
  /** Outputs this call produced. */
  outputs: Record<string, string>;
}
```

`calls` mirrors jest/vitest's `mock.calls` array shape so authors can reach for native `toHaveBeenCalledWith` *or* actspec's matchers.

**Shell command mocks** — stub `run:` step commands (e.g. `git`, `curl`) for determinism:

```ts
interface ShellMockResult {
  stdout?: string;      // default ''
  stderr?: string;      // default ''
  exitCode?: number;    // default 0
}

/** Static result object, or a function called with the full evaluated command string. */
type ShellCommandImpl =
  | ShellMockResult
  | ((cmd: string) => ShellMockResult | Promise<ShellMockResult>);

interface ShellMockCall {
  cmd: string;          // the evaluated shell command string
  result: ShellMockResult;
}

interface ShellMock {
  readonly calls: ShellMockCall[];
  readonly called: boolean;
  readonly callCount: number;
  clear(): void;
}
```

---

## 6. Matchers (`@actspec/matchers`)

actspec ships its **own** `expect()` — no Jest or Vitest dependency. When running via `actspec test`, `expect` is injected into `globalThis` automatically (zero imports). It can also be imported directly: `import { expect } from '@actspec/matchers'`.

TypeScript types for all globals are declared in `@actspec/matchers/globals.d.ts`. Add once to `tsconfig.json`:
```jsonc
{ "types": ["@actspec/matchers/globals"] }
```

```ts
// result matchers
expect(result).toHaveSucceeded();
expect(result).toHaveFailed();
expect(result).toHaveRunStep('build');
expect(result).toHaveSkippedStep('deploy');
expect(result).toHaveStepConclusion('build', 'success');
expect(result).toHaveOutput('version');               // present
expect(result).toHaveOutput('version', '1.2.3');      // present and equals
expect(result).toHaveStepOutput('build', 'sha', 'abc1234');
expect(result).toHaveAnnotation('error', /missing token/);
expect(result).toHaveStepStdout('build', /compiled/);   // step stdout matches string or regex
expect(result).toHaveStepOutcome('lint', 'failure');     // raw outcome before continue-on-error applied

// mock matchers (ActionMock.calls is also available directly)
expect(checkout).toHaveBeenCalled();
expect(checkout).toHaveBeenCalledWith({ ref: 'main', 'fetch-depth': '0' });
expect(checkout).toHaveBeenCalledTimes(1);

// workflow matchers (v0.4) — everything above also applies per job via result.job(id)
expect(wfResult).toHaveRunJob('release');            // conclusion !== 'skipped' && !== 'cancelled'
expect(wfResult).toHaveJobConclusion('build', 'success');
expect(wfResult).toHaveJobOutput('build', 'artifact', 'app.tgz');
expect(wfResult).toHaveSkippedJob('lint');           // if: false or needs failed
expect(wfResult).toHaveJobCancelled('deploy');       // cancelled by fail-fast
expect(wfResult.job('release')).toHaveStepOutput('publish', 'url', 'https://…'); // §6 matchers, reused
```

---

## 7. Standalone expression engine

Exported independently for community reuse (`@actspec/expressions`). Full normative semantics + conformance corpus: [EXPRESSIONS.md](EXPRESSIONS.md).

```ts
/** Evaluate a single expression body (no surrounding `${{ }}`), preserving type. */
export function evaluate(expr: string, contexts: ExpressionContexts): ExprValue;

/** Evaluate a full template string; single-expression values keep their type, mixed text → string. */
export function evaluateTemplate(input: string, contexts: ExpressionContexts): ExprValue;

/** Lower-level access for tooling. */
export function tokenize(expr: string): Token[];
export function parse(tokens: Token[]): Ast;

interface ExpressionContexts {
  github?: unknown; env?: unknown; inputs?: unknown; steps?: unknown;
  runner?: unknown; secrets?: unknown; matrix?: unknown; strategy?: unknown;
  job?: unknown; needs?: unknown; vars?: unknown;
  /** Status functions wiring. */
  status?: { success: boolean; failure: boolean; cancelled: boolean };
  /** Override/extend built-in functions (e.g. provide hashFiles in a test). */
  functions?: Record<string, (...args: ExprValue[]) => ExprValue>;
}

type ExprValue = null | boolean | number | string | ExprValue[] | { [k: string]: ExprValue };
```

---

## 8. Worked examples

### Composite (v0.1)
```ts
// no imports — actspec, expect, describe, test are injected by `actspec test`

test('greet composite sets the greeting output', async () => {
  const action = actspec('./greet/action.yml');
  const result = await action.run({ inputs: { name: 'World' } });

  expect(result).toHaveSucceeded();
  expect(result).toHaveRunStep('say-hello');
  expect(result).toHaveOutput('greeting', 'Hello World');
});

test('skips publish step when dry-run', async () => {
  const action = actspec('./release/action.yml');
  const checkout = action.mock('actions/checkout@v4', { outputs: { ref: 'sha123' } });

  const result = await action.run({
    inputs: { 'dry-run': true },
    github: { ref: 'refs/heads/main' },
  });

  expect(checkout).toHaveBeenCalledWith({ 'fetch-depth': '0' });
  expect(result).toHaveSkippedStep('publish');
  expect(result).toHaveStepConclusion('build', 'success');
});
```

### JS action (v0.2) — identical surface
```ts
test('node action masks the token and sets a fingerprint', async () => {
  const action = actspec('./fingerprint/action.yml'); // using: node24
  action.mockGitHubApi({
    'GET /repos/{owner}/{repo}': { default_branch: 'main' },
  });

  const result = await action.run({
    inputs: { token: 'super-secret' },
    github: { repository: 'acme/widgets' },
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('fingerprint');
  expect(result.annotations).not.toContainEqual(
    expect.objectContaining({ message: expect.stringContaining('super-secret') }),
  ); // secret stayed masked
});
```

### Docker action (v0.3) — still identical
```ts
test('docker action returns parsed version', async () => {
  const action = actspec('./scanner/action.yml', { container: 'mock' }); // using: docker
  action.mock('./scanner', { outputs: { report: 'clean' } }); // or run real with container:'docker'
  const result = await action.run({ inputs: { path: './src' } });
  expect(result).toHaveOutput('report', 'clean');
});
```

### Workflow (v0.4) — a parallel entry, same step/mock vocabulary
```ts
import { actspecWorkflow } from 'actspec';

test('release job runs only on a tag, after build succeeds', async () => {
  const wf = actspecWorkflow('./.github/workflows/release.yml');
  wf.mock('actions/checkout@v4');
  wf.mockJob('build', { outputs: { artifact: 'app.tgz' } }); // mock a whole job

  const result = await wf.run({
    event: 'push',
    eventPayload: { ref: 'refs/tags/v1.2.3' },
  });

  expect(result).toHaveRunJob('release');
  expect(result).toHaveJobConclusion('release', 'success');
  expect(result.job('release')).toHaveStepOutput('publish', 'url', expect.any(String));
});
```

The step/output/mock matchers are identical — only `toHaveRunJob`/`toHaveJobConclusion` and `actspecWorkflow()` are new. The `actspec()` action surface is untouched.

### Coverage (all versions) — opt-in reporting, zero test-body change
```bash
# enable via the CLI flag — no config file needed
actspec test --coverage --reporter text,html,lcov --threshold ifBranches=80
```

```ts
// optional: programmatic config in actspec.config.ts
import { actspecCoverage } from '@actspec/coverage';

actspecCoverage({
  include: ['action.yml', '.github/workflows/*.yml'],
  reporters: ['text', 'html', 'lcov'],
  thresholds: { steps: 100, ifBranches: 80 }, // fail the suite if under
});
// Tests are written exactly as above — coverage is harvested from every run() automatically.
```

The test body never branches on action type — or on whether it's an action or a workflow. That is the contract.

---

## 9. Coverage (`@actspec/coverage`)

Coverage ships from v0.1 and is **passive**: it observes every `run()` and aggregates across the suite. No change to how tests are written — only config + (optionally) thresholds. It is **parallel-safe**: `actspec test` runs each test file in its own worker; fragments are written to a temp dir per worker and merged by the CLI after all workers complete — so a fully parallel suite still yields one report (see ARCHITECTURE → Coverage).

Internally, coverage is an **Istanbul-compatible coverage map** (steps → statements, `if:` → branches, v0.2 JS lines as real line coverage). That one decision means the **full Istanbul reporter set works** and the emitted `coverage-final.json` is mergeable with your other coverage via standard istanbul tooling (e.g. `nyc merge`).

```ts
/** Register the suite-level collector + reporters. Call once in a setup file. */
export function actspecCoverage(options?: CoverageOptions): void;

interface CoverageOptions {
  /** Action/workflow files to attribute coverage to (globs). Default: auto from run() sources. */
  include?: string[];
  exclude?: string[];
  /** Reports to emit (full Istanbul reporter set). Default: ['text', 'html'].
   *  console: 'text' | 'text-summary'
   *  human:   'html' | 'html-spa'
   *  CI:      'lcov' (lcov.info + html) | 'lcovonly' | 'cobertura' (GitLab/Azure/Jenkins) | 'clover' | 'teamcity'
   *  data:    'json' (coverage-final.json — Istanbul map, mergeable) | 'json-summary' (badges/gates) | 'none' */
  reporters?: Array<
    | 'text' | 'text-summary' | 'html' | 'html-spa'
    | 'lcov' | 'lcovonly' | 'cobertura' | 'clover' | 'teamcity'
    | 'json' | 'json-summary' | 'none' | CoverageReporter
  >;
  /** Directory for all coverage output — reports + `coverage-final.json` (hand that to `nyc merge`).
   *  Default: './coverage'. */
  coverageDir?: string;
  /** Fail the suite if any metric falls below its percentage. */
  thresholds?: Partial<Record<CoverageMetric, number>>;
}

/** The layered coverage model (see ARCHITECTURE → Coverage). */
type CoverageMetric =
  | 'steps'          // v0.1: steps executed vs skipped
  | 'ifBranches'     // v0.1: each if: seen both true AND false
  | 'inputs'         // v0.1: declared inputs/defaults exercised
  | 'jsLines'        // v0.2: V8 line coverage of JS action code
  | 'jobs';          // v0.4: workflow jobs run + needs edges taken

/** Programmatic access (e.g. for custom assertions or CI gating). */
export function getCoverage(): CoverageReport;

interface CoverageReport {
  total: Record<CoverageMetric, CoverageStat>;
  /** Per source file (action.yml / workflow path). */
  files: Record<string, FileCoverage>;
}
interface CoverageStat { covered: number; total: number; pct: number }
interface FileCoverage {
  metrics: Record<CoverageMetric, CoverageStat>;
  /** Per-`if:` truth table: which branches were observed. */
  ifBranches: Array<{ step: string; expression: string; sawTrue: boolean; sawFalse: boolean }>;
  uncoveredSteps: string[];
}
```

> Why a truth table for `if:` branches? It's the metric no existing tool reports: a step guarded by `if: ${{ inputs.publish }}` is only *fully* covered when your suite exercises it both ways. `ifBranches` makes "you never tested the skip path" a visible gap.

---

## 10. Workflows (`@actspec/workflow`, v0.4)

A parallel entry. Everything from §3–§6 (run input, results, mocks, matchers) applies per job; only the orchestration surface below is added. The `Action` API in §2 does not change.

```ts
export function actspecWorkflow(source: string | WorkflowSource, options?: ActspecOptions): Workflow;

interface Workflow {
  readonly manifest: ParsedWorkflow;

  // ── mocking: same action mocks, plus job / reusable-workflow / service scope ──
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock; // uses: in any job
  /** Mock an entire job by id — declare its outputs/result instead of running it. */
  mockJob(id: string, def?: JobMockDef | JobMockImpl): JobMock;
  /** Mock a called reusable workflow (`uses: ./.github/workflows/x.yml`). */
  mockReusable(ref: string, def?: JobMockDef | JobMockImpl): JobMock;
  /** Mock a service container (`jobs.<id>.services.<name>`) — declare ports/env instead of running it. */
  mockService(name: string, def?: ServiceMockDef): ServiceMock;
  resetMocks(): void;

  /** Evaluate `on:` filters without executing: which jobs would fire for this event? */
  wouldTrigger(event: TriggerInput): TriggerResult;

  run(input?: WorkflowRunInput): Promise<WorkflowResult>;
}

interface WorkflowRunInput extends Omit<RunInput, 'inputs' | 'secrets'> {
  /** The triggering event name (drives `github.event_name` + which `on:` filters apply). */
  event?: string;
  /** Limit execution to one job (and its `needs:` ancestors). Default: the whole graph. */
  job?: string;
  /** workflow_dispatch / workflow_call inputs (typed when the manifest declares `inputs:`). */
  inputs?: Record<string, string | number | boolean>;
  /** Secrets. For a reusable workflow, `'inherit'` mirrors the caller's secrets. */
  secrets?: Record<string, string> | 'inherit';
  /** Pin a matrix combination instead of expanding all. */
  matrix?: Record<string, unknown>;
}

interface TriggerInput {
  event: string;                       // 'push' | 'pull_request' | 'schedule' | 'workflow_run' | …
  ref?: string;                        // e.g. 'refs/heads/main'
  /** Files changed in this push/PR — drives paths: / paths-ignore: filters.
   *  When omitted and the workflow has a paths: filter, wouldTrigger returns
   *  triggered: false (conservative: cannot evaluate the filter without file list). */
  changedFiles?: string[];
  payload?: unknown;                   // event body for types: filters etc.
  /** For event:'schedule' — the instant to test cron expressions against. */
  at?: Date | string;
  /** For event:'workflow_run' — the upstream workflow that completed. */
  workflowRun?: { name: string; conclusion: 'success' | 'failure' | 'cancelled'; branch?: string };
}
interface TriggerResult {
  triggered: boolean;                  // would the workflow run at all?
  /** All job ids defined in the workflow when triggered === true.
   *  Per-job if: conditions are NOT evaluated — they reference needs context
   *  that only exists during execution, not at trigger time. */
  jobs: string[];
  reason?: string;                     // why not, when triggered === false (e.g. 'paths-ignore matched')
}

interface ServiceMockDef {
  ports?: Record<number, number>;      // container → host
  env?: Record<string, string>;
}

interface WorkflowResult {
  conclusion: 'success' | 'failure' | 'cancelled';
  /** Jobs in topological order; each is a per-job view of the familiar RunResult. */
  jobs: JobResult[];
  /** Find a job by id. For matrix jobs with multiple instances, returns the first.
   *  To target a specific matrix instance, pass the matrix values or filter `result.jobs`. */
  job(id: string, matrix?: Record<string, unknown>): JobResult | undefined;
  annotations: Annotation[];
}

// JobResult uses Omit<RunResult, 'conclusion'> rather than extending RunResult directly.
// RunResult.conclusion is 'success' | 'failure' — sufficient for action results.
// Jobs need 'skipped' (if: false or needs failed) and 'cancelled' (fail-fast).
// TypeScript does not allow widening an inherited property through extends,
// so the Omit pattern is required. (Confirmed by workflow spike — H3 finding.)
interface JobResult extends Omit<RunResult, 'conclusion'> {
  conclusion: 'success' | 'failure' | 'skipped' | 'cancelled';
  id: string;
  /** `needs.<id>.outputs` this job exposed. */
  outputs: Record<string, string>;
  /** The matrix values for this instance, if any. */
  matrix?: Record<string, unknown>;
  /** Job ids this one depended on. */
  needs: string[];
  /** outcome = raw result; conclusion applies job-level continue-on-error (failure → doesn't fail the run). */
  outcome: 'success' | 'failure' | 'skipped' | 'cancelled';
}

interface JobMockDef {
  outputs?: Record<string, string>;
  result?: 'success' | 'failure' | 'skipped';
}
type JobMockImpl = (call: { needs: Record<string, JobResult>; matrix?: Record<string, unknown> })
  => JobMockDef | Promise<JobMockDef> | void;
```

`JobResult extends Omit<RunResult, 'conclusion'>` is the deliberate move: a job *is* an action-like step run, so `expect(result.job('build')).toHaveStepOutput(...)` reuses the §6 matchers verbatim. The `Omit` is required because job conclusions include `'skipped'` and `'cancelled'` which are not valid for action results. Only `toHaveRunJob`/`toHaveJobConclusion`/`toHaveJobOutput`/`toHaveSkippedJob`/`toHaveJobCancelled` are net-new.

```ts
// trigger evaluation — test the `on:` filters themselves, no execution
expect(wf.wouldTrigger({ event: 'push', ref: 'refs/heads/main', changedFiles: ['src/a.ts'] }))
  .toEqual({ triggered: true, jobs: ['build', 'test'] });
expect(wf.wouldTrigger({ event: 'push', changedFiles: ['README.md'] }).triggered).toBe(false); // paths-ignore

// reusable workflow as the unit under test, with inherited secrets + a mocked service
const reusable = actspecWorkflow('./.github/workflows/deploy.yml');
reusable.mockService('postgres', { ports: { 5432: 5432 } });
const r = await reusable.run({ inputs: { environment: 'staging' }, secrets: 'inherit' });
expect(r).toHaveJobOutput('deploy', 'url', 'https://staging.app');
```

---

## 11. Typed actions (`@actspec/gen`)

A codegen step turns an `action.yml` into a typed handle, so inputs, outputs, and mocks are checked against the action's real surface. Opt-in — the untyped `actspec()` still works.

```bash
npx actspec gen ./action.yml > action.gen.ts   # or a glob; emits one typed module per action
```

```ts
import { greet } from './action.gen';            // generated: typed wrapper around actspec('./action.yml')

const action = greet();
await action.run({
  inputs: { name: 'World' },                     // ✅ key + type checked against inputs:
  //         naem: 'World'                        // ✗ compile error — no such input
});
const result = await action.run({ inputs: { name: 'World' } });
result.outputs.greeting;                          // ✅ typed string; unknown keys are compile errors
```

```ts
/** Shape of the generated handle. */
type TypedAction<I extends Record<string, string>, O extends Record<string, string>> =
  Omit<Action, 'run' | 'manifest'> & {
    run(input?: TypedRunInput<I>): Promise<TypedRunResult<O>>;
  };

interface TypedRunInput<I>  extends Omit<RunInput, 'inputs'>  { inputs?: Partial<I> }
interface TypedRunResult<O> extends Omit<RunResult, 'outputs'> { outputs: O }
```

Mocks can be typed the same way from the *mocked* action's manifest, so `mock('actions/checkout@v4', { outputs: { … } })` is checked when a manifest is available.

---

## 12. Fixtures & factories (`@actspec/fixtures`)

Realistic context + event payloads so tests aren't hand-rolling envelopes.

```ts
import { contexts, events } from '@actspec/fixtures';

await action.run({
  github: contexts.github({ repository: 'acme/widgets', ref: 'refs/heads/main' }), // fills the rest
  runner: contexts.runner({ os: 'Windows' }),
  eventPayload: events.pull_request({ action: 'opened', number: 42 }),             // full PR envelope
});
```

```ts
/** Each factory returns a complete, realistic object; overrides are deep-merged. */
export const contexts: {
  github(overrides?: Partial<GitHubContext>): GitHubContext;
  runner(overrides?: Partial<RunnerContext>): RunnerContext;
};
export const events: {
  push(o?: DeepPartial<PushEvent>): PushEvent;
  pull_request(o?: DeepPartial<PullRequestEvent>): PullRequestEvent;
  workflow_dispatch(o?: DeepPartial<WorkflowDispatchEvent>): WorkflowDispatchEvent;
  // …one per supported `on:` event
};
```

---

## 13. Diagnostics & snapshots

For a testing tool, *why it failed* is half the product. Failures throw typed errors with source context; with `diagnostics: 'trace'` the result also carries the data behind the failure.

```ts
interface ExpressionTrace {
  expression: string;              // e.g. "inputs.publish && !inputs.draft"
  source?: { file: string; line: number; col: number };
  /** Each AST node with the value it produced — the "why" of an if: result. */
  nodes: Array<{ kind: string; text: string; value: ExprValue }>;
  result: ExprValue;
}

/** Thrown errors are typed and carry action.yml source position. */
class ActspecError extends Error { code: string; source?: { file: string; line: number; col: number } }
class MissingMockError extends ActspecError {}   // names the unmocked ref + the one-line fix
class ExpressionError extends ActspecError {}    // points at the bad ${{ }} with a caret
```

Snapshots work out of the box because results are serializable and determinism is frozen:

```ts
const result = await action.run({ inputs: { name: 'World' } });
expect(result).toMatchSnapshot();                          // stable: fixed clock/seed/run-id
// or assert on the rendered run: script, masked + normalized
expect(result.step('build')!.render!.script).toMatchSnapshot();
```

A registered snapshot serializer normalizes volatile bits (temp paths) and masks secrets, so snapshots are diff-friendly and leak-free.

---

## 14. CLI (`@actspec/cli`)

Two commands: `actspec test` — the purpose-built test runner; `actspec run` — execute one action outside a test.

```bash
# run the test suite (discovers **/*.actspec.ts and **/*.test.ts by default)
actspec test
actspec test 'src/**/*.actspec.ts'       # custom pattern
actspec test --coverage                  # emit Istanbul reports
actspec test --reporter html,lcov        # reporter selection
actspec test --threshold ifBranches=80   # fail if under

# scaffold a test for an existing action
actspec init ./action.yml                # writes action.test.ts with no imports

# generate typed wrappers (see §11)
actspec types './actions/**/action.yml' --outdir ./generated
```

`actspec test` injects `describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actspec`, and `expect` into `globalThis` before running each test file — no imports needed in test files. Each file runs in its own worker (via `node:test` parallel mode). Coverage is managed by the CLI; no `setupFiles` or `globalTeardown` config is needed.

---

`actspec run` executes a single action outside a test — same runtime, so behavior matches the test path exactly. The CLI *runs and prints*; it does not assert (assertions belong in tests).

```bash
# run an action with inputs + a mock, print outputs/conclusion
actspec run ./action.yml \
  --input name=World \
  --mock actions/checkout@v4='{"outputs":{"ref":"abc123"}}' \
  --event push --json

# generate typed wrappers (see §11)
actspec types './actions/**/action.yml' --outdir ./generated

# scaffold a test for an existing action
actspec init ./action.yml            # writes action.test.ts with a runnable starting point
```

`actspec run` honors the same `ActspecOptions` (e.g. `--container docker`, `--unmocked-uses error`, `--no-freeze-time`), so what you see on the CLI is what a test sees.

### Mocking on the CLI — one surface, never a second DSL
The CLI has **no mocking language of its own**. Beyond a flag or two it drives the *same* `mock()` API your tests use, so mocks are authored once and reused. Scales by how much you mock:

```bash
# 1 — a couple of static mocks: inline flags
actspec run ./action.yml --mock actions/checkout@v4='{"outputs":{"ref":"abc"}}'

# 2 — many static mocks: a declarative file (no flag soup)
actspec run ./action.yml --mock-file ./mocks.yml

# 3 — dynamic mocks / API / shell / shared with a test: a setup module (the real answer)
actspec run ./action.yml --setup ./mocks.ts

# 4 — don't want to hand-write them: record once, replay deterministically
#     (deferred post-v0.1 — flag is reserved; errors politely if used today)
actspec run ./action.yml --record            # captures each uses:'s real outputs → writes mocks.yml
actspec run ./action.yml --mock-file mocks.yml
```

**`--mock-file` (declarative, static only):**
```yaml
# mocks.yml
uses:
  actions/checkout@v4: { outputs: { ref: abc123 } }
  ./build:             { conclusion: success, outputs: { artifact: app.tgz } }
github-api:
  "GET /repos/{owner}/{repo}": { default_branch: main }
shell:
  - match: "^git rev-parse"
    stdout: "abc123\n"
```

**`--setup` (the same API as a test — dynamic, GitHub API, shell, anything):**
```ts
// mocks.ts  (loaded via tsx/jiti)
import type { Action } from 'actspec';

export default function setup(action: Action) {
  action.mock('actions/checkout@v4', { outputs: { ref: 'abc' } });
  action.mock('./deploy', ({ with: w }) => ({ outputs: { url: `https://${w.env}.app` } })); // dynamic
  action.mockGitHubApi({ 'GET /repos/{owner}/{repo}': { default_branch: 'main' } });
}
```
The same `setup()` is imported by the test, so mocks live in one place:
```ts
import setup from './mocks';
const action = actspec('./action.yml'); setup(action);   // identical behavior in-test
```

> **Why this scales.** The trivial case is flags; everything heavier is *code you already wrote for your tests*. Past a certain amount of mocking you're really describing a test — so the CLI just runs that test's `setup()` module instead of growing a wall of flags. `--record` (item 4, deferred post-v0.1 — flag reserved) needs the opt-in network resolver to fetch remote-real, so recording is explicit by nature — consistent with the hermetic default.
