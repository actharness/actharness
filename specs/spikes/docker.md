# Spike — Docker container sandbox (`@actspec/docker`)

> **POC spike — proves the `ContainerSandbox` design before `@actspec/docker` is built.** Runs a set of real docker action scenarios through a minimal docker `ActionExecutor` wired on top of the workflow spike machinery. The spike validates protocol file mounting, all three image sources, content-hash caching, `args:`/`entrypoint:` wiring, and the pre-entrypoint/post-entrypoint lifecycle. The spike's `ContainerSandbox` implementation becomes the starting point for `@actspec/docker`.
>
> **COMPLETE — 21/21 tests pass.** All five scenarios (A–E) green against a real Docker daemon (v23.0.6, macOS). H1–H8 all confirmed. No design changes needed. See [docker-findings.md](docker-findings.md) for full outcomes.

## Why this spike

v0.3 adds the `ContainerSandbox` — the part of the runtime that builds/pulls/runs Docker images, mounts protocol files, and threads the lifecycle. [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) describes the design; [v0.3.md](../versions/v0.3.md) explicitly calls for a spike before committing:

> *"No dedicated container spike exists yet. When v0.3 is scheduled, run a spike in `spike/docker/` before committing to the `ContainerSandbox` design — then evolve that spike code into `@actspec/docker`. Do not design from scratch at implementation time."*

The docker executor rests on four unproven bets:

**1. Protocol file mounting.** The design assumes a container can write to `$GITHUB_OUTPUT` (and the other `GITHUB_*` env-file paths) via a bind-mounted host temp file — the host sets the env var to the temp file path, bind-mounts it into the container at that path, and reads it back after the container exits. Whether this round-trips correctly — especially with containers that run as a non-root user with different file-ownership — is unvalidated.

**2. Three image sources.** `image: Dockerfile`, `image: ./path`, and `image: docker://registry/img` are three different resolution strategies that must all normalize to a runnable image. Whether the build-on-demand path and content-hash caching actually work in practice (not just in theory) has not been confirmed.

**3. `args:` and `entrypoint:` wiring.** `args:` is a YAML list that may contain `${{ }}` expressions; it must be evaluated at run time and passed as positional arguments to `docker run`. `entrypoint:` is an optional override passed as `--entrypoint`. Getting both correct — including how they interact with the image's own `ENTRYPOINT`/`CMD` — requires validation.

**4. pre-entrypoint / post-entrypoint lifecycle.** A docker action's `pre-entrypoint:` and `post-entrypoint:` fields mirror the JS action's pre/main/post phases: they run before and after the main `entrypoint:`, thread `GITHUB_STATE` between them, and produce `StepResult`s with the correct `phase` discriminator. This has never been run.

Building `@actspec/docker` on unvalidated assumptions about any of these would mean discovering the hard cases after a full package — executor, sandbox backends, content-hash cache, three image sources, lifecycle — all exists. The spike catches them cheaply first.

## Prerequisite

**This spike builds directly on `spike/workflow/`** — the most evolved spike implementation, which has the composite executor, context building, protocol allocation, mock resolver, and types all working and tested. The docker spike adds a `package.json` local dependency on `spike/workflow/` and imports from it directly:

```json
{
  "dependencies": {
    "workflow-spike": "file:../workflow"
  }
}
```

The docker spike then imports the executor registry, protocol, context, parser, types, and mock machinery from `workflow-spike` — **never copying those files**. Only the docker `ActionExecutor` and `ContainerSandbox` are new code in `spike/docker/src/`.

This is structurally identical to how the coverage spike depended on the runner spike: import the substrate, extend it, don't reproduce it. See [specs/spikes/coverage.md](coverage.md#prerequisite) for the established pattern.

The workflow spike's `src/index.ts` must export the executor registry's `register()` and `dispatch()` surface, the `RunnerProtocol`, the `MockResolver`, and the core types (`ExecutionCall`, `ExecutionResult`, `RunResult`, `ActspecOptions`) — the same seam the real `@actspec/core` package exports. If gaps are found here, update the workflow spike's exports (not its internals) before starting the docker spike.

## The question it answers

When a `ContainerSandbox` backend:

- allocates per-run host temp files for `GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}` (reusing the protocol machinery from the workflow spike),
- bind-mounts each temp file into the container at the same absolute path,
- passes `INPUT_*`, `GITHUB_*`, and the protocol file paths as `-e` env vars on `docker run`,
- builds or pulls the image according to the declared `image:` source (`Dockerfile` / `./path` / `docker://registry/img`), with a content-hash cache for built images,
- wires `args:` (expression-evaluated) and `entrypoint:` override into the `docker run` command, and
- runs pre-entrypoint / entrypoint / post-entrypoint in order, threading `GITHUB_STATE` between them,

...can a **real, unmodified docker action** produce the correct `RunResult` through the same `mock` / `run` / `expect` surface that composite uses — with `container: 'mock'` working without any daemon for CI, and `container: 'docker'` running real containers when available?

## Hypotheses to prove

- **H1 — Protocol file mounting.** A temp file allocated by the host, bind-mounted into the container at its absolute path, and pointed to by the `GITHUB_OUTPUT` env var can be written by the container's entrypoint (via `echo "name=value" >> $GITHUB_OUTPUT`). After the container exits, the host reads the file and parses the correct output. The round-trip is intact.
- **H2 — Prebuilt image (`docker://registry/img`).** A docker action with `image: docker://alpine:3.19` is pulled and run with the protocol files mounted. The container writes to `$GITHUB_OUTPUT` and the host reads the correct output without requiring any local Dockerfile.
- **H3 — Local Dockerfile build (`image: Dockerfile` or `image: ./path`).** A docker action with a local `Dockerfile` is built on demand. The built image runs and the protocol round-trip works. The `./path` form (relative path to a Dockerfile directory) resolves correctly relative to the action directory.
- **H4 — Content-hash caching.** Running the same local-Dockerfile action twice: the second run skips the build and reuses the cached image. Modifying the Dockerfile invalidates the cache and triggers a rebuild.
- **H5 — `args:` expression evaluation + `entrypoint:` override.** An action with `args: ['${{ inputs.message }}', 'fixed-arg']` evaluates the expression before passing to `docker run`. An `entrypoint:` field is passed as `--entrypoint <value>` and overrides the image's default entrypoint.
- **H6 — pre-entrypoint / post-entrypoint lifecycle + `GITHUB_STATE`.** A docker action with `pre-entrypoint:` produces three `StepResult`s in the correct order (`phase: 'pre'`, `phase: 'main'`, `phase: 'post'`). A value written to `$GITHUB_STATE` in `pre-entrypoint:` is available as `STATE_<name>` to the `post-entrypoint:` container.
- **H7 — Mock backend (no-daemon default).** With `container: 'mock'` (the default), a `uses:` step targeting a docker action produces the declared mock outputs without any `docker` invocation. CI without a daemon runs the suite. The mock surface is identical to composite / node mocking — `action.mock(ref, { outputs: {...} })` — no new API.
- **H8 — Container user permissions.** A container that runs as a non-root user (e.g. `USER 1000:1000` in the Dockerfile) can still write to the bind-mounted protocol temp files. Confirm the fix (world-writable temp files, or chown, or a named volume workaround) and document the correct default.

## In scope

- **Minimal docker `ActionExecutor`** — `handles('docker')`; reads `runs.image`, `runs.entrypoint`, `runs.args`, `runs.pre-entrypoint`, `runs.post-entrypoint`, `runs.env`; dispatches to `ContainerSandbox`.
- **`ContainerSandbox` with two backends:**
  - **`mock`** — returns declared outputs, no docker. Integrates with the existing `MockResolver` so `action.mock(ref, def)` works unchanged.
  - **`docker`** — spawns real `docker run` via `child_process.spawn`; wires protocol files, env vars, and command structure as described in the hypotheses.
- **Three image source normalizers** — `docker://registry/img` (pull), `Dockerfile` (build in-place), `./path` (build from relative dir). Content-hash cache for built images (keyed on SHA-256 of the Dockerfile + `.dockerignore` if present).
- **`args:` + `entrypoint:` wiring** — expression-evaluated args list; `--entrypoint` flag.
- **Pre-entrypoint / post-entrypoint lifecycle** — run in order, `GITHUB_STATE` threaded.
- **Fixture docker actions** — one per scenario (see below); all handwritten, minimal, specific to the hard case being validated.
- **Test files** — run via the workflow spike's CLI (or equivalent), using `actspec()` globals injected by the runner, same zero-import format as all other spikes.

## Explicitly out of scope

- `podman` backend (same interface as `docker`; add as a second backend when building the real package).
- Rootless Docker / Docker-in-Docker / remote Docker daemon.
- Real published actions from the registry (fixture actions are handwritten — the same reasoning as the node-sandbox spike: real published actions often require system tools that test the wrong thing).
- Full `@actspec/docker` package build (dual ESM/CJS, API Extractor, publication).
- `services:` (sidecar containers, v0.4 scope).
- `jsLines` / V8 coverage (not applicable to docker actions).

## Success criteria (the spike's gate)

1. **All five scenarios pass** — Scenarios A–E (see below) all run green. A failing scenario is a finding; the spike is not complete until it resolves to either a design change or a documented design gap.
2. **Mock backend is daemon-free** — Scenario A passes on a machine with no Docker daemon installed.
3. **Protocol round-trip is intact** — for every real-docker scenario, at least one output written inside the container is read back correctly by the host via the bind-mounted file.
4. **Content-hash cache works** — H4 confirmed: second run of Scenario C uses the cached image (observable via build log or timing).
5. **H8 is resolved** — container user permissions are either a non-issue (confirmed) or a documented fix is implemented and working.
6. **No new API surface required** — the `mock`/`run`/`expect` surface is unchanged. If any design gap forces a surface change, it is proposed explicitly and the exit decision is escalated before `@actspec/docker` starts.

## The five scenarios (must all pass)

### Scenario A — Mock backend (no daemon required)

**Profile:** A `using: docker` action with `image: docker://alpine:3.19` and a handwritten entrypoint that reads an input and writes an output. Run with `container: 'mock'` (the default). No Docker daemon needed.

**Validates:** H7.

**Test shape:**
```ts
test('docker action is mocked by default — no daemon required', async () => {
  const action = actspec('./action.yml');   // using: docker
  action.mock('./action.yml', { outputs: { result: 'mocked' } });
  const result = await action.run({ inputs: { message: 'hello' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('result', 'mocked');
});

test('docker uses: in a composite is intercepted the same way as any uses:', async () => {
  const composite = actspec('./composite/action.yml');
  composite.mock('./docker-child', { outputs: { scanned: 'clean' } });
  const result = await composite.run({ inputs: { path: './src' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveStepOutput('scan', 'scanned', 'clean');
});
```

### Scenario B — Prebuilt image (`docker://registry/img`)

**Profile:** A `using: docker` action with `image: docker://alpine:3.19`. The entrypoint is a shell script that reads `$INPUT_MESSAGE` and appends `message=$INPUT_MESSAGE` to `$GITHUB_OUTPUT`. Run with `container: 'docker'`.

**Validates:** H1, H2, H8.

**Test shape:**
```ts
test('prebuilt image: input reaches container and output is returned', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const result = await action.run({ inputs: { message: 'hello from docker' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('message', 'hello from docker');
});

test('container running as non-root can still write to $GITHUB_OUTPUT', async () => {
  // fixture Dockerfile has USER 1000:1000
  const action = actspec('./nonroot/action.yml', { container: 'docker' });
  const result = await action.run({ inputs: { value: 'x' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('echoed', 'x');
});
```

### Scenario C — Local Dockerfile build and content-hash caching

**Profile:** A `using: docker` action with `image: Dockerfile` in the action directory. The Dockerfile installs nothing (minimal `FROM alpine:3.19`) and the entrypoint writes an output. Run twice; confirm the second run uses the cache.

**Validates:** H1, H3, H4.

**Test shape:**
```ts
test('local Dockerfile is built and action produces outputs', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const result = await action.run({ inputs: { value: 'built' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('value', 'built');
});

test('second run uses the content-hash cache — no rebuild', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const first  = await action.run({ inputs: { value: 'a' } });
  const second = await action.run({ inputs: { value: 'b' } });
  // both succeed; the second run's StepResult should carry a cache-hit annotation
  // or the build log should be absent — confirm whichever signal is implemented
  expect(first).toHaveSucceeded();
  expect(second).toHaveSucceeded();
});
```

### Scenario D — `args:` expression evaluation and `entrypoint:` override

**Profile:** A `using: docker` action with:
```yaml
runs:
  using: docker
  image: docker://alpine:3.19
  entrypoint: /bin/sh
  args:
    - -c
    - echo "greeting=${{ inputs.name }}" >> $GITHUB_OUTPUT
```
The `args:` list contains a `${{ }}` expression. The `entrypoint:` overrides the image default.

**Validates:** H5.

**Test shape:**
```ts
test('args: expression is evaluated before docker run', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const result = await action.run({ inputs: { name: 'World' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('greeting', 'World');
});
```

### Scenario E — pre-entrypoint / post-entrypoint lifecycle

**Profile:** A `using: docker` action with:
```yaml
runs:
  using: docker
  image: docker://alpine:3.19
  pre-entrypoint: /pre.sh     # writes to $GITHUB_STATE
  entrypoint: /main.sh        # writes an output
  post-entrypoint: /post.sh   # reads STATE_cache-key, writes an output
```
Each script is baked into the image. `pre.sh` does `echo "cache-key=abc" >> $GITHUB_STATE`; `post.sh` does `echo "restored=$STATE_cache_key" >> $GITHUB_OUTPUT`.

**Validates:** H6.

**Test shape:**
```ts
test('pre/main/post phases run in order with correct phase discriminators', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const result = await action.run({});

  const pre  = result.steps.find(s => s.phase === 'pre')!;
  const main = result.steps.find(s => s.phase === 'main')!;
  const post = result.steps.find(s => s.phase === 'post')!;

  expect(pre.conclusion).toBe('success');
  expect(main.conclusion).toBe('success');
  expect(post.conclusion).toBe('success');
});

test('GITHUB_STATE threads from pre-entrypoint to post-entrypoint', async () => {
  const action = actspec('./action.yml', { container: 'docker' });
  const result = await action.run({});
  expect(result).toHaveOutput('restored', 'abc');  // value set in pre, echoed by post
});
```

## Friction scenarios to probe (write at least one test for each)

| # | Probe | What would constitute friction |
|---|---|---|
| 1 | Protocol file bind-mount round-trip | Container's `echo "k=v" >> $GITHUB_OUTPUT` writes to the bind-mount but host reads an empty file — mount is one-way or path mismatch |
| 2 | Absolute path identity | Host temp path differs from container mount path (e.g. macOS `/var/folders/...` vs Docker-visible `/tmp/...`) — path mismatch causes a write to a non-mounted location |
| 3 | Non-root user write permission (H8) | Container user can't write to the mounted file — `Permission denied`; action fails with no output |
| 4 | `docker://registry/img` format | The `docker://` prefix confuses the image reference — `docker pull` rejects it or pulls the wrong tag |
| 5 | Dockerfile content-hash cache key | Cache key computed incorrectly — same Dockerfile triggers a rebuild; different Dockerfile uses the stale cache |
| 6 | `./path` resolution | Relative Dockerfile path not resolved relative to the action directory — build context points to the wrong directory or `docker build` fails |
| 7 | `args:` with expression containing spaces | `args: ['echo ${{ inputs.message }}']` evaluated with a multi-word message — shell splitting produces unexpected arguments |
| 8 | `entrypoint:` override with `args:` | `--entrypoint` and positional `args` interact with the image's `CMD` in a surprising way — wrong effective command |
| 9 | pre-entrypoint / post-entrypoint ordering | If any phase fails: does the next phase still run (analogous to `post-if` and `pre-if` defaults)? Does `phase: 'post'` always appear even when `phase: 'main'` failed? |
| 10 | GITHUB_STATE container path | `$GITHUB_STATE` env var points to the host path, but `post-entrypoint` needs to read the value written in `pre-entrypoint` — both containers must mount the **same** state file |

## Required deliverable — findings document

Findings are written to [`specs/spikes/docker-findings.md`](docker-findings.md) alongside the implementation (location: `spike/docker/`):

1. **H1–H8 verdict** — `✅` / `❌` / `⚠️` per hypothesis, with the observed failure for any `❌`.
2. **Friction log** — for each probe: what was wanted, what the implementation revealed, classification (`no change needed` / `design gap` / `API change needed`).
3. **Protocol mounting assessment** — exactly how files are mounted (bind-mount flags, path strategy, permissions fix for H8). Document the `docker run` command shape that produced a working round-trip.
4. **Image source assessment** — how each of the three sources is normalised to an image reference; content-hash cache key construction and invalidation.
5. **`args:` / `entrypoint:` wiring assessment** — the exact `docker run` command structure; interaction between `--entrypoint`, positional args, and the image's own `ENTRYPOINT`/`CMD`.
6. **Lifecycle assessment** — how pre-entrypoint / post-entrypoint are invoked; how `GITHUB_STATE` is shared between phases (same file, same mount in both containers); correct `phase` values on `StepResult`s.
7. **Mock backend integration** — confirm it requires zero new mock API. Note whether `container: 'mock'` uses the existing `MockResolver` path unchanged or needs a thin shim.
8. **Proposed changes** — table of any design changes before building `@actspec/docker`: `change`, `ARCHITECTURE.md / v0.3.md / API.md section`, `why`, `priority`.

## Exit — what we decide after

- **If all five scenarios pass, no design gaps:** the spike's `ContainerSandbox` and docker executor are promoted as the starting point for `@actspec/docker`. The design is confirmed as-is.
- **If protocol mounting fails (H1/probe #1/probe #2):** the entire ContainerSandbox design premise is wrong — escalate as a design question. Options: use named volumes instead of bind mounts; pass outputs via container stdout + a sentinel protocol; run the container with `--user $(id -u)`. Record findings and update [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) before any `@actspec/docker` work begins.
- **If container user permissions are unresolvable (H8/probe #3):** record the constraint and a workaround (e.g. always create protocol temp files as world-writable, `0o666`). Update [ARCHITECTURE → Sandboxes](../../docs/ARCHITECTURE.md#sandboxes) and [CONVENTIONS](../../docs/CONVENTIONS.md) with the invariant.
- **If content-hash caching is unreliable (H4):** document what cache key works in practice; update [ARCHITECTURE → ContainerSandbox](../../docs/ARCHITECTURE.md#sandboxes). The cache is a performance optimisation, not a correctness requirement — its failure doesn't block v0.3.
- **If pre-entrypoint / post-entrypoint lifecycle is structurally wrong (H6):** determine whether GitHub's actual `pre-entrypoint` semantics differ from the JS action `pre:`/`post:` model already in `StepResult.phase`. Update [API.md §4](../../docs/API.md) and [ARCHITECTURE → Fidelity](../../docs/ARCHITECTURE.md#fidelity--semantics) before building.
- **If any gap forces a public API surface change:** update [API.md](../../docs/API.md) and all affected module specs, and re-validate the change against the existing api-ergonomics and workflow spike tests to confirm no regression.

## References

- [specs/spikes/workflow.md](workflow.md) + [spike/workflow/](../../spike/workflow/) — the substrate this spike builds on. Must be run; its exports are this spike's direct dependency.
- [specs/spikes/workflow-findings.md](workflow-findings.md) — confirms `StepResult.phase`, the mock surface, and `ExecutionCall` shape. All apply unchanged to docker steps.
- [specs/spikes/api-ergonomics-findings.md](api-ergonomics-findings.md) — confirms `RunResult` shape and `mock()` API are type-agnostic. H7 here validates the same claim for docker.
- [specs/spikes/node-sandbox-findings.md](node-sandbox-findings.md) — companion executor spike (JS sandbox). The pre/main/post lifecycle pattern (H6) is directly analogous to what was proven for JS actions there; the difference is `worker_thread` vs `docker run`.
- [docs/ARCHITECTURE.md → ContainerSandbox](../../docs/ARCHITECTURE.md#sandboxes) — the design this spike validates.
- [docs/ARCHITECTURE.md → Fidelity & semantics](../../docs/ARCHITECTURE.md#fidelity--semantics) — pre/main/post lifecycle spec for docker actions.
- [specs/versions/v0.3.md](../versions/v0.3.md) — the version this spike gates.
- [docs/API.md §1](../../docs/API.md) — `ActspecOptions.container` (`'mock'` | `'docker'` | `'podman'`).
- [D15](../../docs/DECISIONS.md#d15--real-shelljS-execution-not-emulation) — real execution is the product; the spike validates this extends naturally to containers.
- [D16](../../docs/DECISIONS.md#d16--unmocked-uses-policy-local-real-remote-noop) — default mock policy for remote docker refs.
