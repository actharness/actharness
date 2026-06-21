# actharness — Architecture

> Unit testing for GitHub Actions.

## Goals & non-goals

**Goals**
- Test a single action in **isolation**, hermetically, with no real GitHub runner and no network.
- One unified test API (`mock` / `run` / `expect`) that is **identical** whether the unit under test is a composite, JS, Docker action — or (v0.4) a whole workflow.
- Faithful simulation of the parts of the runner that affect observable behavior: the **runner-file protocol** (`$GITHUB_OUTPUT`, `$GITHUB_ENV`, …), **workflow commands** (`::set-output::`, `::error::`, …), and the **expression language** (`${{ … }}`).
- **Coverage as a first-class output, every version.** Each `run()` reports which steps ran, which were skipped, and how each `if:` resolved; the suite aggregates that into a coverage report (step + `if:`-branch + input/default + output from v0.1; JS line coverage from v0.2; job coverage from v0.4). See [Coverage](#coverage-cross-cutting-all-versions).
- Extensible without changing the public API — by *action type* (a new executor) or *scope* (a new orchestrator). Roadmap: v0.0 expressions standalone → v0.1 composite → v0.2 node → v0.3 docker → **v0.4 workflows** → v0.5+ future types.

**Non-goals**
- Being an *integration* runner. `act` boots full workflows in Docker to reproduce a run; actharness stays hermetic and mock-first — even for workflows (v0.4), child actions and the network are mocked unless you opt into real execution. Different tool, different promise.
- Being a linter. `actionlint` covers static analysis. actharness executes.
- Byte-for-byte runner reproduction. We reproduce *observable* behavior, not VM provisioning, caching, or telemetry.
- **A security sandbox.** actharness runs the real `bash`/JS from your `action.yml`; its isolation is env-scoping + a temp workspace (hermeticity and determinism), **not** a trust boundary. It is for testing actions *you control or trust* — not for executing untrusted/malicious actions safely. (See [Threat model](#threat-model).)

## The core idea: actions compose, so the runtime is recursive

Every action type reduces to the same shape from the test author's point of view:

```
run(inputs) ─▶ [executor for `using:`] ─▶ { outputs, steps, conclusion }
```

A **composite** action is a list of steps; a step is either `run:` (shell) or `uses:` (another action). That `uses:` target is *itself* a composite, node, or docker action. So executing a composite means recursively executing child actions — which is exactly the same operation as the top-level `run()`.

This recursion is what makes the unified API possible. There is one execution contract; each `using:` value is just a different **executor** plugged into the same runtime. Adding Docker support (v0.3) means registering one more executor — the API, the mock surface, and the matchers don't move. A **workflow** (v0.4) is the same step machinery one level up: a job's `steps:` are identical in shape to a composite's, so workflows are a sibling **orchestrator** above the executors, not a new executor.

```
┌────────────────────────────────────────────────────────────────┐
│  Public API   actharness() · actharness.mock() · actharnessWorkflow()   │  ← stable across all versions
│               · .run() · result.step() · expect()             │
├────────────────────────────────────────────────────────────────┤
│  Test Harness   mock registry · result builder · matchers ·    │
│                 context fixtures · CoverageCollector (suite)   │  ← coverage is cross-cutting
├────────────────────────────────────────────────────────────────┤
│  Orchestrators                                                 │
│    ActionRunner    one action                        (v0.1–v0.3)   │
│    WorkflowRunner  job DAG · needs · matrix expansion   (v0.4)   │
├────────────────────────────────────────────────────────────────┤
│  Runtime Core   (all type- and scope-agnostic)                 │
│    StepRunner         if: → execute → collect outputs          │
│    ExpressionEngine   lexer · parser · evaluator (the ${{}})   │
│    RunnerProtocol     env-file IO · workflow-command parser    │
│    ContextStore       github · env · steps · inputs · needs…   │
│    MockResolver       resolve `uses:` → mock | real | error    │
├────────────────────────────────────────────────────────────────┤
│  Executor Registry    dispatch on `using:`                     │
│    ┌────────────┬───────────────┬───────────────┬──────────┐   │
│    │ composite  │ node20/24/…   │ docker        │  future  │   │
│    │   (v0.1)     │    (v0.2)       │   (v0.3)        │  (v0.5+)   │   │
│    └────────────┴───────────────┴───────────────┴──────────┘   │
├────────────────────────────────────────────────────────────────┤
│  Sandbox Providers                                             │
│    ShellSandbox       temp workspace · scoped env · stub cmds  │
│    JsSandbox          child process (fork) · env isolation · net mock │
│    ContainerSandbox   pluggable: mock | docker | podman        │
├────────────────────────────────────────────────────────────────┤
│  Parser               action.yml + workflow.yml schemas        │
└────────────────────────────────────────────────────────────────┘
```

The two orchestrators share everything below them. `ActionRunner` builds one `ExecutionCall` and dispatches to an executor; `WorkflowRunner` resolves the job DAG and, per job, drives the *same* `StepRunner` over that job's steps — reusing the expression engine, runner protocol, sandboxes, and mock resolver unchanged. That reuse is why v0.4 is mostly additive (see [Workflow orchestration](#workflow-orchestration-v0.4)).

## The execution contract (the seam every executor implements)

```ts
interface ActionExecutor {
  /** Does this executor handle the given `using:` value? e.g. /^node\d+$/ */
  handles(using: string): boolean;
  /** Run the action and report observable results. */
  execute(call: ExecutionCall): Promise<ExecutionResult>;
}

interface ExecutionCall {
  action: ParsedAction;        // parsed manifest
  inputs: Record<string, string>;   // resolved (defaults applied, expressions evaluated)
  context: ContextStore;       // github, env, runner, steps, … (read scope)
  protocol: RunnerProtocol;    // env-file handles + command sink for this invocation
  mocks: MockResolver;         // for child `uses:` resolution
  sandbox: SandboxFactory;     // shell / js / container providers
  jobStatus: JobStatus;        // drives success()/failure()/always()/cancelled()
}

interface ExecutionResult {
  outputs: Record<string, string>;
  steps: StepResult[];         // composite: many; node/docker: one per lifecycle phase that ran (pre/main/post)
  conclusion: 'success' | 'failure';
  annotations: Annotation[];   // ::error::/::warning::/::notice::
}
```

`actharness().run()` produces the top-level `ExecutionCall`, dispatches to the matching executor, and the harness shapes the `ExecutionResult` into the public `RunResult` the matchers read.

## Data flow of a single `run()`

1. **Resolve & parse** — if `source` starts with `./` or `../`, the path is resolved relative to the calling file's directory via stack-trace inspection (so `actharness('./action.yml')` always finds the right file regardless of the working directory); then `action.yml` is parsed and cached on the `Action` handle.
2. **Build context** — merge user-supplied `github`/`env`/`runner`/`secrets`/`matrix` over sane defaults; resolve `inputs` (apply `default:`, coerce to strings, fill `INPUT_*`).
3. **Dispatch** to the executor matching `runs.using`.
4. Executor runs:
   - **composite**: for each step, evaluate `if:` → run `run:` in `ShellSandbox` or resolve `uses:` via `MockResolver` (recurse on real, replay on mock); thread env-file state forward; collect `steps.<id>.outputs/outcome/conclusion`.
   - **node**: launch entrypoint in `JsSandbox` with protocol files wired so `@actions/core` "just works"; read outputs back from `$GITHUB_OUTPUT`.
   - **docker**: hand the image/entrypoint to the configured `ContainerSandbox`.
5. **Resolve action outputs** — composite evaluates each `outputs.<name>.value` expression against the final `steps` context.
6. **Collect** outputs, per-step results, annotations, final env → `RunResult`, **stamped with the source action id** and every `if:` outcome.
7. **Record coverage** — the `RunResult`'s step/`if:` signal (plus any JS line data from the sandbox) is pushed to the suite-level `CoverageCollector`.
8. **Teardown** — temp workspace removed unless `keepWorkspace` is set.

> The above is the single-action path (`ActionRunner`). A workflow `run()` wraps it: `WorkflowRunner` schedules jobs and, per job, performs steps 2–7 over that job's steps. See [Workflow orchestration](#workflow-orchestration-v0.4).

## Fidelity & semantics

The simulation is only useful if it matches the real runner where it counts. These are the behaviors a naïve implementation gets wrong; we model them explicitly. Each is pinned by the [conformance corpus](#trust-conformance-against-the-real-runner). **Principle:** we reproduce the runner's *observable* behavior faithfully — including its footguns — rather than "improving" on it; the specifics are corpus-dictated, not chosen ([D39](DECISIONS.md#d39--faithful-reproduction-including-footguns-is-binding)).

### Action lifecycle: pre / main / post
JS and Docker actions are not a single entrypoint — they have **three phases**. State flows between phases of the *same* action via `$GITHUB_STATE` (written by earlier phases, exposed to later phases as `STATE_<name>` env vars), **not** through outputs. The runtime runs all three phases in order, threads state between them, and surfaces each phase's `StepResult` so tests can assert phase-specific conclusions.

- **JS actions** use `pre:`/`main:`/`post:` manifest fields, guarded by `pre-if`/`post-if` (default `always()`).
- **Docker actions** use `pre-entrypoint:`/`entrypoint:`/`post-entrypoint:` — the exact field names differ but the semantics and state-threading are identical. Each phase spawns a separate `docker run` invocation; `GITHUB_STATE` is threaded by parsing the state file after each phase and injecting the values as `STATE_<key>` env vars into the next phase's container. Fresh protocol files are allocated per phase — the state file is not shared between containers.
- **Outputs across phases:** outputs written to `$GITHUB_OUTPUT` by *any* phase (pre, main, or post) are merged into the final `RunResult.outputs`. Docker `post-entrypoint:` is a first-class output producer (e.g. a cache action's post phase reports what it restored).
- **Composite** actions have no per-action pre/post, but a composite *step* that `uses:` a JS/Docker action triggers that child's full pre/main/post. So in a composite run, `post:` phases of children run **in reverse order after all main steps** — exactly as the runner does. `RunResult` preserves this ordering.
- The `RunResult`/`StepResult` carry a `phase` discriminator (`'pre' | 'main' | 'post'`) so phase-specific assertions are possible without changing the unified surface.

### Shell execution fidelity
GitHub does not just "run the script" — it wraps it, and the wrapper decides pass/fail:

| `shell:` | Invocation (faithfully reproduced) |
|----------|-------------------------------------|
| `bash` (default on Linux/macOS) | `bash --noprofile --norc -eo pipefail {0}` |
| `sh` | `sh -e {0}` |
| `pwsh` (default on Windows) | `pwsh -NonInteractive -command ". '{0}'"` with `$ErrorActionPreference='Stop'` prepended to script. actharness keeps a persistent pwsh host process per run and isolates each step in its own Runspace (`pwshIsolation: 'runspace'`, the default); `pwshIsolation: 'process'` spawns a dedicated process per step instead (full .NET state isolation at ~500 ms/step cost). |
| `python` | `python {0}` |
| `cmd` / `powershell` | OS-specific wrappers |

The `-e`/`pipefail` flags mean a step **fails on the first failing command / broken pipe** — get the wrapper wrong and conclusions diverge. We also honor `working-directory:`, the `shell` precedence (`step` → `defaults.run.shell` → OS default), and step-level `env:` (precedence: step `env` > action/job `env` > workflow `env` > process allowlist). `continue-on-error` is modeled as the **outcome vs. conclusion** split already in `StepResult` — at step level *and* job level (a `continue-on-error` job that fails reports `outcome: failure` but doesn't fail the workflow). In a composite, the status functions track the **accumulated step conclusions**: a non-`continue-on-error` failure flips `success()` false (so later default-`if: success()` steps skip), while a `continue-on-error` failure does not ([D3](DECISIONS.md#d3--composite-status-evolves-with-step-conclusions)). `timeout-minutes` on a step is **honored and enforced** — if the step exceeds the declared limit it receives SIGTERM then SIGKILL, and `StepResult.timedOut` is set to `true`.

### Expression-evaluation surface
We pin *which* fields are templated and *when*, because the runner evaluates some eagerly and some late:

- **Eagerly, before a step runs:** `if:`, `with.*`, `env.*`, `name:`, `working-directory:`, `continue-on-error:`, `timeout-minutes:`. (`if:` may omit `${{ }}` and is coerced to boolean.)
- **Late, after steps complete:** composite `outputs.<name>.value` and workflow `jobs.<id>.outputs.*` — evaluated against the final `steps`/`needs` context.
- **Input transform:** an input `My Input` becomes the env var `INPUT_MY_INPUT` (uppercased, spaces → `_`); this exact transform is what `core.getInput` reverses, so we reproduce it byte-for-byte.
- **Input metadata is advisory, faithfully.** The real runner does *not* hard-fail an action for a missing `required: true` input (the action receives `''`), so neither do we — but we surface a **warning annotation** for a missing required input and for any `deprecationMessage` on a supplied input, matching the runner's advisory behavior while making the gap visible in tests.
- **`run:` substitution is literal string interpolation** — including GitHub's script-injection footgun — so tests can *catch* injection, not hide it.

### Determinism (frozen by default)
A testing library must own its nondeterminism. By default every run gets a **fixed clock, a seeded RNG, and stable `GITHUB_RUN_ID`/`RUNNER_TEMP`/workspace paths**, so `toMatchSnapshot()` of outputs and logs is stable. Each is overridable per run (`now`, `seed`, …). `hashFiles()` is computed against the real workspace contents (deterministic given fixture files) or can be stubbed via the expression `functions` hook. Wall-clock/random passthrough is opt-in for the rare test that needs it.

## Subsystem notes

### Expression engine (`@actharness/expressions`) — the hard part
Ships as a standalone package because **no complete open-source JS implementation exists** and the community wants one. Pipeline: `tokenize → parse (Pratt / precedence-climbing) → evaluate(ast, contexts)`.

The reference is the C# runner (`Sdk/Expressions`), *not* JavaScript semantics — the differences are where every naïve port breaks:
- **No arithmetic operators.** Only `! < <= > >= == != && ||`, plus `( ) [ ] .` and calls.
- **Loose equality with GitHub's coercion**, not JS's: across types, cast to Number (`null→0`, `false→0`, `true→1`, `''→0`, unparseable string → `NaN`); `NaN` compares unequal to everything.
- **String comparison is case-insensitive.** `'ABC' == 'abc'` is `true`.
- **Objects/arrays compare by reference**, never structurally.
- **`&&`/`||` return the operand**, not a boolean (`'' || 'x'` → `'x'`).
- **Truthiness:** `null`, `''`, `0`, `NaN` are falsy; *every other string is truthy* — including `'false'`.
- **Object filters:** `things.*.name`, `array[*]`.
- **Functions:** `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`, and the status checks `success() failure() always() cancelled()`.
- **Template vs single-expression typing:** a value that is *exactly* `${{ expr }}` preserves the expression's type (so `fromJSON('{...}')` yields an object); a value with surrounding text coerces every expression to string and concatenates. `if:` coerces the result to boolean and may omit the `${{ }}`.

Correctness is pinned by the [conformance corpus](#trust-conformance-against-the-real-runner) — the runner's own expression test vectors plus golden outputs captured from real runs. **Full normative spec: [EXPRESSIONS.md](EXPRESSIONS.md)** (grounded against `nektos/act` + GitHub docs).

### Runner protocol
A per-invocation handle that allocates temp files for `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_PATH`, `GITHUB_STATE`, `GITHUB_STEP_SUMMARY`, parses both the file formats (`name=value` and `name<<DELIM … DELIM` heredocs) and the stdout workflow commands (`::set-output name=x::y`, `::save-state::`, `::add-mask::`, `::error file=…,line=…::msg`, `::group::`/`::endgroup::`, `::add-path::`). Because real `@actions/core` reads/writes exactly these, a real JS action is driven without patching it.

### Mocking model — two distinct surfaces, one mental model ("mock your dependencies")
1. **Action mocks (the primary surface, unified across types).** Any action invoked via `uses:` — `actions/checkout@v4`, `./local`, `docker://img` — is intercepted by ref. You assert on the `with:` it received and declare its `outputs`/`conclusion`. This is the unified surface because composite, node, and docker actions are *all* reachable as a `uses:` target.
2. **Network mocks (`mockNetwork` / `mockGitHubApi`).** HTTP/HTTPS calls made from within a step — `curl`, `fetch`, `requests`, Octokit — are intercepted without making real connections. Two paths, same registry and API:
   - **Shell steps** (bash, sh, python, pwsh): an in-process HTTPS CONNECT proxy is started; the subprocess receives `HTTP_PROXY`, `HTTPS_PROXY`, and a CA cert path via env vars (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`). For pwsh specifically, `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` is also prepended to the script — both the CA cert env vars and the skip directive are applied. This covers tools like `curl` (which honours `CURL_CA_BUNDLE`) and PowerShell web cmdlets (`Invoke-WebRequest`/`Invoke-RestMethod`, which use .NET's cert store and require the skip directive). Runs in the test process — function matchers and response factories are evaluated in-process, no serialization boundary.
   - **Node executor** (`runs.using: node<N>`) and **`shell: node`**: undici `MockAgent` + MSW interceptors inside the forked child, driven by a bidirectional IPC round-trip for per-call response factories. Function matchers are supported — they are evaluated in the test process via the IPC round-trip.

**Default policy for an unmocked `uses:` is local-vs-remote:**
- **Local refs (`./`, `../`)** — actions you own, in your tree → **`real`**: recurse and execute them. Deterministic (no network), and it means a composite that calls your other local actions "just works" without ceremony — the "run your own code" feel.
- **Remote refs (`owner/repo@ref`, `docker://…`)** → **`noop`**: treated as success with no outputs, **never auto-fetched**. This is what keeps moving refs like `@main` from breaking hermeticity. A warning annotation is emitted so the silent gap is visible (not truly silent).

The knob is overridable globally or per-ref (`error` to force a declaration, `real`/`noop` to pin behavior). **Real recursion only ever resolves local paths** — there is no network resolver; a remote ref set to `real` is a configuration error, surfaced as such. The `MockResolver` enforces **cycle detection and a max-depth limit** across nested composites and (v0.4) reusable workflows, so a self-referential or deeply nested graph fails loudly instead of hanging.

### Sandboxes

- **ShellSandbox** — spawns the declared `shell:` (default `bash`) with `cwd` = temp workspace and a **scoped, non-inherited** env (explicit allowlist + `GITHUB_*` + `RUNNER_*` + `INPUT_*` + accumulated `GITHUB_ENV`). Expression substitution into `run:` strings is literal — we reproduce GitHub's behavior faithfully, including its script-injection footgun, so tests can *catch* it. When `mockNetwork` / `mockGitHubApi` mocks are registered, starts an in-process HTTPS CONNECT proxy and injects the relevant env vars into the subprocess. Does not cover `shell: node` — that uses `JsSandbox`.
- **JsSandbox** — used for `runs.using: node<N>` actions and `shell: node` steps. `fork` (child process) for per-child `process.env` isolation; wires protocol files; captures `stdout`/`stderr` and `process.exit`; drives network mocks via bidirectional IPC (undici `MockAgent` + MSW interceptors in the bootstrap). (Heavier `vm`/process isolation is a pluggable upgrade.)
- **ContainerSandbox** — interface with backends: `mock` (default; treat the container like any mocked dependency — declare outputs), `docker`, `podman`. Real container execution is opt-in so CI without a daemon still runs the suite.
  - **Image sources:** `image: Dockerfile` or `image: ./path` → built via `docker build` on demand, cached by SHA-256 of the Dockerfile + `.dockerignore` (content-hash cache is in-process, keyed `actharness-docker-<hash16>`). `image: docker://registry/img` → the `docker://` prefix is stripped and the image is passed directly to `docker run` (pulled on first use). Relative `./path` is resolved relative to the action directory, not the test file.
  - **Protocol file mounting:** the five protocol files (`GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STATE`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`) are host temp files bind-mounted into the container at their **exact host absolute paths** (e.g. `-v /tmp/actharness-abc/output:/tmp/actharness-abc/output`). The container sets its protocol env vars to these same paths, so `echo "name=val" >> $GITHUB_OUTPUT` inside the container writes to the host file. After the container exits, the host reads the file. **Invariant:** protocol temp files are created with `chmod 0o666` (world-writable) before each `docker run` so containers running as non-root users can write to them without permission errors — see [CONVENTIONS.md](CONVENTIONS.md#protocol-file-permissions-docker).
  - **`args:` and `entrypoint:`:** `args:` values are expression-evaluated (template substitution with `${{ inputs.* }}`) before being passed as positional arguments to `docker run`. `entrypoint:` is passed as `--entrypoint`; it overrides the image's `ENTRYPOINT` but not `CMD` — the evaluated `args:` serve as the command.
  - **State threading:** each phase (pre-entrypoint, entrypoint, post-entrypoint) gets its own fresh protocol file allocation. `$GITHUB_STATE` written in one phase is parsed after that phase exits and injected into the next phase's container as `STATE_<key>` env vars — the state file itself is not shared between containers.
  - **Output merging:** `$GITHUB_OUTPUT` writes from *all* phases are merged into `RunResult.outputs`. The `docker://` step form follows the same mock-first contract as composite `uses:` targets.

### Coverage (cross-cutting, all versions)
Coverage is not a version — it's a capability that ships in v0.1 and deepens as executors are added. "Coverage" for actions is **layered**, because the unit being covered differs from ordinary code:

| Layer | From | Cost | What it answers |
|-------|------|------|-----------------|
| **Step coverage** | v0.1 | ~free | Which steps ran vs. were skipped, across the suite |
| **`if:`-branch coverage** | v0.1 | low | Did each `if:` resolve **both** `true` and `false` somewhere in the suite? *(the novel, valuable one — nobody else reports an untested `action.yml` branch)* |
| **Input/default coverage** | v0.1 | low | Which declared `inputs:` / `default:`s were actually exercised |
| **Output coverage** | v0.1 | low | Which declared `outputs:` were actually produced by at least one run |
| **JS statement/branch/function/line coverage** | v0.2 | near-free | V8 inspector API from the `JsSandbox` worker → Istanbul |
| **sh/bash line coverage** | v0.2 | partial | Lines inside `run:` scripts via `PS4`/`set -x`; **line-only** — branch, statement, and function coverage is unsolved; see [sh/bash coverage](ROADMAP.md#shbash-coverage) |
| **pwsh line coverage** | v0.2 | partial | Lines via `Set-PSBreakpoint` per line; line-only |
| **Python statement/branch/line coverage** | v0.2 | near-free | Via `coverage.py` inside a managed venv |
| **`shell: node` line/statement/branch coverage** | v0.2 | near-free | V8 inspector API, same mechanism as `JsSandbox` |
| **Job coverage** | v0.4 | low | Which workflow `jobs:` ran/were skipped; which `needs:` edges were taken |
| **Expression sub-branch** | later | hard | Sub-conditions inside `${{ a && b \|\| c }}`; needs AST instrumentation |

**How it works — and why it must be disk-first.** Every `RunResult` already carries the raw signal (`step.ran`, `step.outcome`, `if.result`) and is stamped with its source id (step 6 above). The subtlety: **`actharness test` runs each test *file* in its own worker process** (via `node:test`'s parallel mode), so an in-memory singleton collector would only ever see one file's runs. The `CoverageCollector` therefore **persists per-file coverage fragments to a temp dir** (the `NODE_V8_COVERAGE`/c8 pattern) during the run, and a single **reporter merges them after all workers complete** — writing the configured reports to `coverageDir` and (optionally) failing the suite under a `threshold`. The CLI manages this full lifecycle; no `setupFiles` or `globalTeardown` configuration is needed. It lives in its own package, `@actharness/coverage`, parallel to `@actharness/matchers` — a *consumer* of results, never in the hot path.

**Istanbul-compatible by construction.** The merged result is an **Istanbul coverage map**: each `action.yml`/workflow file is a "source file" whose **steps map to statements** (at their YAML line ranges) and **`if:`s map to branches** (true/false), with v0.2 JS lines as real line coverage. That single choice unlocks the **entire Istanbul reporter set** — `text`/`text-summary`, **`html`** (renders the YAML with covered/uncovered steps highlighted), `lcov`/`lcovonly`, `cobertura` (GitLab/Azure/Jenkins), `clover`, `teamcity`, `json` (`coverage-final.json`), `json-summary` — and makes `coverage-final.json` **mergeable with your other coverage** via standard istanbul tooling (`nyc merge`), so `action.yml` can share one combined report with your app. *Caveat, stated plainly:* a workflow file shows up in that report as a "file" whose statements are steps and branches are `if:`s — positions are YAML, not code.

**Isolation invariant (also what makes coverage correct).** Every **top-level** `run()` gets its **own temp workspace** (shared across its recursion tree — nested local `uses: ./child` reuse it — while env-files are allocated fresh per step; [D4](DECISIONS.md#d4--one-workspace-per-top-level-run-env-files-per-step)) and all mocks — both action mocks (`actharness.mock`) and network mocks (`mockNetwork`/`mockGitHubApi`) — are stored in the **current ALS scope** (file-root / describe / test), never in a process-global. Inner scopes override outer scopes; entries are automatically discarded when their scope exits. Because each worker process gets its own ALS context, parallel workers can't cross-contaminate state or double-count coverage. Combined with the two recording invariants below, this is what lets the suite run fully parallel and still produce one coherent report.

**Two recording invariants keep this cheap and version-proof** (held from v0.1): every `if:` evaluation and step outcome is recorded on the `RunResult`, and every result is source-stamped and flushed to a coverage fragment. New executors/orchestrators get step + branch coverage for free by producing well-formed results; they only add a layer when they have *more* signal (JS lines, jobs).

### Workflow orchestration (v0.4)
A workflow (`.github/workflows/*.yml`) is a **superset of machinery we already have**: a job's `steps:` are identical in shape to a composite action's steps. So the expensive subsystems — expression engine, runner protocol, all three sandboxes, the mock resolver, the StepRunner — are reused **unchanged**. v0.4 is mostly additive.

What's genuinely new:
- **`WorkflowRunner` (the orchestrator).** Parses `jobs:`, resolves `needs:` into a DAG, topologically orders it, and runs jobs **sequentially** (parallelism is irrelevant for deterministic tests). Per job it drives the same `StepRunner` over that job's steps.
- **New contexts** the `ContextStore` must serve: `needs.<job>.outputs`/`.result`, `jobs`, `strategy`, workflow-scope `vars`/`secrets`, plus **matrix expansion** — one `strategy.matrix` job → N concrete instances, with `include` merged and `exclude` pruned per GitHub's rules, each instance its own context. `fail-fast`/`max-parallel` are modeled as an *effect* (a failing instance marks its siblings `cancelled`), since there's no real parallelism to manage. **Matrix job output aggregation (known simplification):** when a `needs:` edge targets a matrix job, the aggregate `conclusion` is `failure` if any instance failed; `needs.<id>.outputs` carries the **last successful instance's outputs** (or the last instance's outputs if all failed). The real runner's semantics for `needs.<matrix-job>.outputs` are undefined when multiple instances exist — this is a documented simplification, not a gap to resolve later.
- **Job execution environment.** A job may declare `container:` (the job's steps run inside it — routed through `ContainerSandbox`) and `services:` (sidecar containers like postgres/redis). Services are **mocked dependencies** by default (`mockService('postgres', { ports, env })`) so a hermetic suite needs no Docker; opt into real via the container backend. `environment:` surfaces as context (`environment.name/url`) — deployment **protection rules/approvals are out of scope** (they're human gates, not execution).
- **Reusable workflows, both directions.** A reusable workflow (`on: workflow_call`) can be the **unit under test** — `actharnessWorkflow('./.github/workflows/reusable.yml')` with typed `inputs`, `secrets` (including `secrets: inherit`), and workflow-level `outputs:` wired from job outputs — or a **mocked dependency** when called via `uses: …/x.yml` (`mockReusable`). Nesting honors GitHub's depth limit with cycle detection.
- **Wider mocking, same model.** The `MockResolver` extends from "mock a `uses:` action" to also "mock a **whole job**, a **reusable workflow**, or a **service**" — declare its `outputs`/`result` instead of running it. Same mental model, one scope up.
- **Trigger evaluation, not just injection.** Beyond injecting the event payload, `wouldTrigger(event)` **evaluates `on:` filters** (`branches`/`paths`/`tags` + their `-ignore` forms, `types`) and reports which workflow/jobs would actually fire — so "does my path filter catch this change?" is testable, not assumed. It also covers **`schedule`** (does a given cron fire at time T?) and **`workflow_run`** (would this workflow trigger given another's name + conclusion + branch?). A normal `run()` still targets a chosen job or the whole graph.
- **Metadata as context.** `permissions`, `concurrency`, and `defaults` (run `shell`/`working-directory`) plus workflow/job `env` are represented in the context/fixtures; `defaults.run` shaping is *enforced* during step execution, the rest are readable metadata.
- **A parallel entry + matchers** — `actharnessWorkflow('./ci.yml')`, `toHaveRunJob`/`toHaveJobConclusion`/`toHaveJobOutput`. The existing step/output matchers apply per job. The `actharness()` action surface is untouched.

The one structural reason this stays additive rather than a refactor: **a workflow is not an executor** (it has no `runs.using`). It's a sibling orchestrator above the executor registry that reuses everything from the `StepRunner` down — which is only possible because `StepRunner` and `ContextStore` are kept **action-agnostic** (they operate on a step list + a context store, never "a manifest"). That decoupling is a v0.1 invariant (see [Future-proofing invariants](#future-proofing-invariants)).

## Trust & developer experience

Correctness and ergonomics are what separate a library people *trust* from one they tolerate. Three pillars beyond raw execution:

### Trust: conformance against the real runner
The expression engine and runner protocol make a strong claim ("we match GitHub"), so we make it *falsifiable*:
- **Vendored test vectors** — the runner's own `Sdk/Expressions` test cases, mirrored as data fixtures (with attribution; see [License & attribution](#license--attribution)).
- **Golden captures** — for a set of real-world actions, record the *real* runner's observable output (outputs, env-file writes, annotations) from an actual GitHub run, commit them, and assert actharness reproduces them. This is the evidence behind every fidelity claim in [Fidelity & semantics](#fidelity--semantics).
- **Differential fuzzing** of the expression parser against the documented grammar.

A claim without a fixture proving it is treated as a bug. The v0.0 expression gate is the **full vendored vector set + parser/eval fuzz**; a live differential run against `nektos/act` is an **optional, non-blocking** extra — act is an imperfect oracle, so we follow the runner ([D5](DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)).

### Diagnostics that explain failures
For a *testing* tool, error quality is the product. Failures carry context, not stack traces:
- **Source-mapped errors** — a bad expression or schema error points at `action.yml:line:col` with a caret.
- **`run:` render view** — the exact script after `${{ }}` substitution, the resolved env, and the wrapper command, so "why did my step fail" is answerable.
- **Expression eval trace** — on demand, the AST + the value each subexpression produced.
- **Missing-mock errors** name the unmocked ref and show the one-line fix.

### Typed actions & fixtures
- **Typed inputs/outputs generated from `action.yml`** — a codegen step (`@actharness/gen`) turns a manifest into a typed `Action<Inputs, Outputs>`, so `run({ inputs })`, `result.outputs`, and mocks are checked against the action's real surface. No other tool offers this.
- **Context & event factories** (`@actharness/fixtures`) — realistic `github`/`runner` defaults and event builders (`events.pull_request({…})`, `events.push({…})`) so fixtures aren't hand-rolled.
- **Snapshot-friendly results** — `RunResult` is serializable and ships a snapshot serializer; with determinism frozen by default, `toMatchSnapshot()` of outputs/step sequence is stable.

### CLI (`actharness test` / `actharness run`)
`@actharness/cli` ships two commands. `actharness test` is the purpose-built test runner on top of Node's built-in `node:test` — it discovers test files, injects globals (`describe`, `it`, `test`, `before`, `after`, `beforeEach`, `afterEach`, `actharness`, `expect`) into `globalThis`, manages coverage lifecycle (`--coverage`), and runs each file in parallel workers. The injected `actharness` has `.mock()` and `.resetMocks()` already attached, so test files need no imports at all. Test files may also `import { actharness } from 'actharness'` directly; the import is typed as `ActharnessFn` (carrying the full mock surface) and refers to the same registered object. `actharness run` executes a single action outside a test — `actharness run ./action.yml --input name=World` — for local iteration. Both reuse the same runtime, so behavior matches in-test behavior exactly.

## Project

### License & attribution
**MIT.** Permissive, and aligned with GitHub's Actions runner (also MIT), which keeps mirroring its expression test vectors clean — provided we **attribute** the source in `NOTICE`/fixture headers and preserve its license text for any vendored data.

### Cross-platform
Tests run on contributors' machines and CI across OSes, so the runtime is explicit about it: `runner.os` is a fixture (default `'Linux'`, CI's common OS), overridable per run to exercise other-OS branches — which changes `${{ runner.os }}`, not the real shell — and real `run:` execution needs the declared `shell` to exist on the host (`cmd` only runs on Windows; `bash`/`pwsh`/`sh`/`python` are cross-platform). actharness also accepts `shell: powershell` as an alias for `shell: pwsh` — both invoke the `pwsh` binary and are treated identically in every code path (session pool / Runspace isolation, coverage, network proxy). This differs from the real GitHub Actions runner, where `shell: powershell` invokes the legacy Windows PowerShell 5.x binary, not `pwsh`. Where a shell is absent we fail with a clear, actionable message rather than silently mis-executing. The project's own CI matrix spans **Linux/macOS/Windows × supported Node versions**.

### API stability
The unified surface (`mock`/`run`/`expect`, `actharness()`/`actharnessWorkflow()`) is the contract and follows **semver with an explicit promise: no breaking changes to it across v0.1→v0.4**. New action types and scopes may *add* surface (new matchers, new entries) but never reshape what exists — enforced by `@arethetypeswrong`/API-extractor snapshots in CI.

### Threat model
Stated plainly so no one mistakes the isolation for security: actharness executes the real shell/JS in your `action.yml` under a scoped env in a temp workspace. That boundary exists for **hermeticity and determinism**, not containment — a malicious action could still touch the filesystem or network the sandbox doesn't explicitly block. **Test actions you trust.** Hardened isolation (full `vm`/container/network-deny) is an opt-in upgrade path, not the default promise.

## Package layout (pnpm monorepo)

**One repo, many independently-published packages** — pnpm workspaces + [changesets](https://github.com/changesets/changesets). A monorepo here is *not* a single package: each module below ships to npm with its own version and `package.json`, so consumers install exactly what they need. The plugin architecture maps 1:1 to packages, and the expression engine is independently valuable.

```
actharness                 meta package — re-exports the common surface
@actharness/core           parser · runtime · protocol · context · mock registry · executor registry
@actharness/expressions    standalone ${{ }} engine (lexer/parser/evaluator + fixtures)  (v0.0)
@actharness/shell          ShellSandbox (run:/shell: step executor)       (v0.1)
@actharness/composite      composite executor                            (v0.1)
@actharness/node           node executor + JsSandbox + net mock           (v0.2)
@actharness/docker         docker executor + ContainerSandbox             (v0.3)
@actharness/workflow       WorkflowRunner (job DAG · matrix · needs)      (v0.4)
@actharness/coverage       CoverageCollector + lcov/terminal reporters    (all versions)
@actharness/matchers       actharness's own expect() + result/mock matchers; no test-framework dependency
@actharness/fixtures       github/runner defaults + event payload factories
@actharness/types          zero-dep DAG root: all public interfaces + GITHUB_DEFAULTS/RUNNER_DEFAULTS
@actharness/gen            codegen: action.yml → typed Action<In, Out>          (post-v0.1)
@actharness/cli            `actharness test` (runner + globals + coverage) + `actharness run`
```

`@actharness/shell` ships ahead of `@actharness/workflow` (v0.4) because `run:`/`shell:` semantics are identical for a composite step and a workflow job step — splitting it out in v0.1, when composite was its only consumer, avoids a breaking move later when workflow needs it too.

Executors register themselves with `@actharness/core` via a dedicated **side-effectful registration entry** (the one module excepted from the package's `sideEffects: false`, so bundlers never prune it — [D25](DECISIONS.md#d25--sideeffects-false-with-the-registration-entry-excepted)); installing `@actharness/docker` is what teaches the runtime about `using: docker`, and `@actharness/workflow` adds the `actharnessWorkflow()` orchestrator. `@actharness/coverage` is a passive consumer of results — adding it never changes execution. The public API never changes shape as packages are added.

**Why monorepo, not polyrepo.** These packages are tightly coupled — they share core types (`ExecutionCall`, `RunResult`, `StepResult`, `ContextStore`). A single change often spans several (adding `phase` to `StepResult` touched core + composite + node + matchers + coverage). In a monorepo that's one atomic PR; across separate repos it's a publish-and-bump chain per change — daily friction during the churn-heavy early phase, plus harder cross-package integration tests and the conformance corpus. Polyrepo would only pay off if these were loosely coupled or team-owned on divergent cadences; they aren't. `@actharness/expressions` is the one package with a genuine standalone life — develop it here, split it out later *only* if it earns its own following.

## Roadmap → architecture mapping

| Version | Adds | New code | Coverage gained | API change |
|---------|------|----------|-----------------|------------|
| **v0.0** | `@actharness/expressions` standalone | `@actharness/expressions` — full engine, corpus (459 vectors), fuzz CI | none (no test framework yet) | — standalone package |
| **v0.1** | `using: composite` | `@actharness/{types,core,composite,coverage,matchers,fixtures,cli}`, ShellSandbox, conformance corpus | step · `if:`-branch · input/default · output | — baseline |
| **v0.2** | `using: node20/24/…` | `@actharness/node`, JsSandbox, net mock | + JS lines · branches · functions · statements (V8/Istanbul) · sh/bash/pwsh line · python statement/branch/line · node-shell line/statement/branch | none (same `mock/run/expect`) |
| **v0.3** | `using: docker` | `@actharness/docker`, ContainerSandbox | (Docker actions covered as steps) | none |
| **v0.4** | **workflows** | `@actharness/workflow`, WorkflowRunner (reuses `@actharness/shell` for job `run:` steps) | + job coverage · `needs:` edges | adds `actharnessWorkflow()` + job matchers; action surface untouched |
| **v0.5+** | future `using:` types | new executor package | inherits step + branch free | none — register an executor |

Two extension axes, neither touches the existing public API:
- **New action type → a new `ActionExecutor`** (composite, node, docker, future). Plugs into the executor registry.
- **New scope → a new orchestrator** (action today; workflow at v0.4). Sits above the executors and reuses the StepRunner down.

### Future-proofing invariants
Held from **v0.1** so the roadmap stays additive rather than a series of refactors:

1. **`StepRunner` and `ContextStore` are action-agnostic.** They operate on *a step list + a context store*, never on "an action manifest." This is what lets the v0.4 `WorkflowRunner` reuse them per job without rewrites.
2. **Every `RunResult` records each `if:` outcome and step result, is stamped with its source id, and is pushed to the `CoverageCollector`** — core notifies a process-global run sink (`registerRunListener`, keyed `globalThis[Symbol.for('actharness.runSink')]`) that coverage subscribes to, so **core never imports coverage** ([D1](DECISIONS.md#d1--coverage-observes-runs-via-a-global-run-sink)). This is what keeps coverage a thin, passive consumer — and gives every future executor/orchestrator step + branch coverage for free.
3. **The unified surface (`mock`/`run`/`expect`) is type- and scope-blind.** New executors and orchestrators may *add* entries (`actharnessWorkflow()`, job matchers) but never reshape what exists.

## Supported surface (the whole GitHub Actions environment)

The promise is *complete* coverage of what teams actually ship — not just the three `using:` types. This matrix is the source of truth for "is my thing testable," with the version it lands in. `Test` = can be the unit under test; `Mock` = can be stubbed as a dependency.

### Executable units
| Unit | `Test` | `Mock` | Ver | Notes |
|------|:------:|:------:|:---:|-------|
| Composite action (`using: composite`) | ✅ | ✅ | v0.1 | recursion into child `uses:` |
| JS action (`using: node20/24/…`, incl. legacy `node12/16`) | ✅ | ✅ | v0.2 | pre/main/post lifecycle |
| Docker action — `image: Dockerfile` (built) | ✅ | ✅ | v0.3 | built via `ContainerSandbox` backend |
| Docker action — `image: docker://registry/img` | ✅ | ✅ | v0.3 | prebuilt image |
| Docker action — `image: ./path` | ✅ | ✅ | v0.3 | local Dockerfile dir |
| Regular workflow (`jobs:`) | ✅ | — | v0.4 | whole-graph or single-job runs |
| Reusable workflow (`on: workflow_call`) | ✅ | ✅ | v0.4 | typed `inputs`, `secrets` (+`inherit`), `outputs` wiring |

### Reference / dependency forms (a `uses:` target)
| Form | Default policy | Ver |
|------|----------------|:---:|
| `owner/repo@ref`, `owner/repo/subdir@ref` | `noop` (remote) | v0.1 |
| `./local`, `../local` | `real` (local) | v0.1 |
| `docker://image` (step-level) | container backend / mock | v0.3 |
| `./.github/workflows/x.yml`, `owner/repo/.github/workflows/x.yml@ref` (reusable workflow call) | `mockReusable` | v0.4 |

### Workflow structure & environment
| Feature | Handling | Ver |
|---------|----------|:---:|
| `needs:` DAG + `needs.<job>.outputs/result` | scheduled sequentially, threaded | v0.4 |
| `strategy.matrix` + `include` / `exclude` | expanded (merge/prune semantics) | v0.4 |
| `fail-fast`, `max-parallel` | modeled as *effect* (cancel-siblings), not real parallelism | v0.4 |
| `jobs.<id>.container:` (job runs in a container) | `ContainerSandbox`, or mocked | v0.4 |
| `jobs.<id>.services:` (service containers) | **mocked** dependency (`mockService`) | v0.4 |
| `jobs.<id>.environment:` (deployment env) | context (`environment.name/url`); protection rules/approvals are out of scope | v0.4 |
| `on:` triggers — `push`/`pull_request` filters (branches/paths/tags), `types`, plus `schedule` (cron) and `workflow_run` | **evaluated** — `wouldTrigger(event)` reports whether + which jobs fire | v0.4 |
| `concurrency`, `permissions`, `defaults`, workflow/job `env` | represented as context/metadata (fixtures); `defaults.run` shaping is enforced | v0.4 |

### Contexts, protocol & lifecycle (all versions)
| Feature | Handling |
|---------|----------|
| Contexts: `github env runner job steps inputs secrets vars strategy matrix needs` | full defaults via `@actharness/types`, factories via `@actharness/fixtures` |
| Runner files: `GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}` | read/written, heredoc + `name=value` |
| Workflow commands: `::set-output:: ::save-state:: ::add-mask:: ::error/warning/notice:: ::group:: ::add-path::` | parsed from stdout |
| Action lifecycle `pre`/`main`/`post` (+ `pre-if`/`post-if`) | run, ordered, state-threaded |
| Expression language `${{ }}` | full engine + conformance corpus |

If a row here isn't yet true in the current version, it's a tracked gap with a fixture waiting — not an unknown.

### Coverage boundary
We claim complete coverage of one thing precisely, and explicitly decline another — saying both plainly is what makes the claim trustworthy.

**In scope — an action/workflow's own observable logic** (everything in the matrix above): steps, the `${{ }}` expression language, the runner-file protocol and workflow commands, inputs/outputs, `if:` conditions, the pre/main/post lifecycle, mockable dependencies, and `on:` trigger filters. Fidelity here is **conformance-tested** against the real runner (vendored vectors + golden captures), not asserted — "byte-identical including undocumented quirks" is something the corpus *converges on*, never something we promise on day one. Known soft spots we track openly: marginal expression coercion/case-folding, and `hashFiles()`'s exact algorithm (it ships its real algorithm in v0.0, overridable via the `functions` hook; [D6](DECISIONS.md#d6--hashfiles-ships-its-real-algorithm-in-v0.1)).

**Deliberately out of scope — the hosted substrate and live services.** Reproducing these would make actharness an *integration* runner (that's `act`/real CI) and break the hermetic, deterministic promise that makes it a *unit* tester:

| Not reproduced | Why it's correct to exclude | What you get instead |
|----------------|-----------------------------|----------------------|
| The **hosted runner image** (preinstalled `gh`/`docker`/language SDKs, exact OS) | it's a multi-GB VM image, not action logic | scoped env; a `run:` using a missing tool fails loudly, or you stub it |
| **Live backing services** — Actions cache, artifacts, OIDC `id-token`, GitHub API, real secrets, network egress | hermeticity forbids real network | mocked (`mockGitHubApi`, `mockService`, net mock) |
| **Human / infra gates** — environment approvals, required reviewers, wait timers, concurrency queueing, runner routing, billing | not execution of *your* logic | `environment.name/url` as context only |
| Real **timeouts/clock-driven cancellation** | determinism freezes the clock | `timeout-minutes` is enforced (SIGTERM/SIGKILL); job-level timeouts are not |

The line is the product: **unit test (us) vs integration run (`act`).** Anything in the left column is a thing you *mock*, by design — never a gap we're hiding.

## Risks, open questions & validation

This document is a strong *blueprint*, but a blueprint's confidence has a ceiling: several claims are demonstrated only when code exists. We name them so the plan is honest about what's settled vs. what's still a bet.

### Validate before building wide: the walking skeleton
The riskiest assumptions should be proven by a **thin vertical slice** before all packages are built — one composite action, end to end: `actharness('./action.yml').run()` → a real `bash` `run:` step → `$GITHUB_OUTPUT` parsed → one `${{ }}` expression evaluated → one matcher asserting the output. It exercises the protocol, a slice of the evaluator, and the API surface at once. It either validates the design or surfaces the needed change now — far cheaper than after 9 packages exist.

### The three highest-risk assumptions
1. **Expression-engine fidelity** — the single highest-risk component. "We match the C# runner" is aspiration until it runs green against the conformance corpus. *Mitigation:* build `@actharness/expressions` corpus-first.
2. **JS sandbox transparency (v0.2)** — "wire the protocol env-files and real `@actions/core` just works." Plausible, but ESM-vs-CJS entrypoints, bundled actions, `process.exit`, and Octokit interception are where it can break. *Mitigation:* a sandbox spike against 3–4 real published actions before committing the design.
3. **Unified-API ergonomics** — that `mock/run/expect` truly feels the same across composite/node/docker/workflow. *Mitigation:* write ~20 real tests by hand against existing public actions and feel the friction.

### Known design tension (resolved — D21)
The mock surface is slightly **two-headed**: `mock()` for `uses:` dependencies vs. `mockGitHubApi`/`mockNetwork` for a JS action's internal calls. **Decision ([D21](DECISIONS.md#d21--mock-surface-keep-the-split-not-unified)): keep the split** — they're genuinely different dependency kinds, honestly typed, rather than one overloaded `mock(target)` that would dispatch by sniffing the target string. Revisitable if a v0.2 sandbox spike reveals a clean unification, but it is **no longer an open question**; the v0.1 surface (`mock()`) is unaffected.

### Scope discipline — explicitly deferred past v0.1
Good ideas that are *not* v0.1, so the first release stays small, correct, and fast:
- `@actharness/gen` (typed-action codegen)
- CLI `--record`/replay
- Hardened `isolation: vm | container | deny-net`

These stay in the design (the seams support them) but ship after the core is validated and trusted. **A focused, conformance-proven v0.1 beats a broad, unproven one.**
