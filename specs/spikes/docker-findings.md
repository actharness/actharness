# Docker Spike — Findings

> **Status: COMPLETE.** All 21 tests pass (5 files: A–E). H1–H8 confirmed. Gate met — `@actspec/docker` can be built from this spike's `ContainerSandbox` design.
>
> Run: `cd spike/docker && ACTSPEC_CONTAINER=docker npm run test:docker` (21/21 pass).
> Mock-only run: `cd spike/docker && npm test` (4/21; 17 correctly skipped).

---

## 1. H1–H8 verdict

| Hypothesis | Verdict | Evidence |
|------------|---------|---------|
| **H1 — Protocol file mounting** | ✅ | Bind-mount at exact host absolute path works on macOS with Docker Desktop. Container writes `echo "k=v" >> $GITHUB_OUTPUT`; host reads the value back after `docker run` exits. Confirmed in Scenario B (3 tests), C, and E. |
| **H2 — Prebuilt image (`docker://registry/img`)** | ✅ | `docker://alpine:3.19` → `alpine:3.19` after prefix strip. Container runs, reads `$INPUT_MESSAGE`, writes to `$GITHUB_OUTPUT`. Host reads correct value. First pull: ~18 s; subsequent runs with cached layer: ~1 s. |
| **H3 — Local Dockerfile build** | ✅ | `image: Dockerfile` builds from action directory as context. `image: ./subdir` builds from the resolved subdirectory. Both produce runnable images and protocol round-trips work. First build: ~10 s. |
| **H4 — Content-hash caching (hit + invalidation)** | ✅ | Same Dockerfile content → same SHA-256 → same tag → cache hit (2.1 s vs 10 s rebuild). Different Dockerfile content (`ENV VARIANT=alt`) → different hash → distinct image tag → separate `docker build` invocation. `getImageCacheSize()` advances from 1→2 when a second distinct Dockerfile is used; stays at 2 on re-run of the first action. |
| **H5 — `args:` expression evaluation + `entrypoint:` override** | ✅ | `${{ inputs.name }}` in `args:` is evaluated by `evaluateTemplate` before `docker run`. Multi-word input (`'Hello World'`) is passed as a single argument — no unexpected shell-splitting. `entrypoint: /bin/sh` with `args: [-c, ...]` overrides the image default correctly. |
| **H6 — pre-entrypoint / post-entrypoint lifecycle + `GITHUB_STATE`** | ✅ | Three `docker run` invocations in order. `pre.sh` writes `cache_key=abc` to `$GITHUB_STATE`; JS side reads it after phase exits, injects `STATE_cache_key=abc` into next phase's env; `post.sh` reads `$STATE_cache_key` and writes `restored=abc` to `$GITHUB_OUTPUT`. StepResult `phase` values are `'pre'` / `'main'` / `'post'`. |
| **H7 — Mock backend (no-daemon default)** | ✅ | 4 Scenario A tests pass without any Docker daemon. `MockRegistry.hasMock` intercepts the action; `container: 'mock'` (the default) never calls `spawnDocker`. Mock API is identical to composite/node — no new surface. |
| **H8 — Container user permissions** | ✅ | `FROM alpine:3.19 / USER 1000:1000` fixture writes to `$GITHUB_OUTPUT` via `chmod 0o666` pre-phase fix. The `chmodSync(p, 0o666)` call before each `docker run` is sufficient on both Linux and macOS Docker Desktop. |

---

## 2. Friction log

| # | Probe | What was wanted | What the implementation revealed | Classification |
|---|---|---|---|---|
| 1 | Protocol file bind-mount round-trip | Container writes to bind-mounted file; host reads it after exit | Works on macOS: Docker Desktop shares `/tmp` via its VM; `/tmp/actspec-<id>/output` is accessible inside the container at the same absolute path. No path translation needed. | **no change needed** |
| 2 | Absolute path identity | Host path == container path | Confirmed. `os.tmpdir()` returns `/tmp` on macOS under Docker Desktop, not `/var/folders/...`. Bind-mount with `-v /tmp/actspec-id/f:/tmp/actspec-id/f` works as-is. | **no change needed** |
| 3 | Non-root user write permission (H8) | `USER 1000:1000` can write to `$GITHUB_OUTPUT` | `chmod 0o666` applied before each `docker run` is sufficient. No chown or named volume workaround needed. | **no change needed** |
| 4 | `docker://registry/img` format | `docker://` prefix doesn't confuse `docker run` | `image.slice('docker://'.length)` → `alpine:3.19` passed directly to `docker run`. Works. | **no change needed** |
| 5 | Dockerfile content-hash cache key | Same content → same key; different content → different key | SHA-256 of `Dockerfile + .dockerignore` content (16 hex chars) is stable and correct. Confirmed by `getImageCacheSize()` advancing only when Dockerfile content changes. | **no change needed** |
| 6a | `image: Dockerfile` resolution | Build context is the action directory | `image === 'Dockerfile'` → `contextDir = actionDir`. Confirmed. | **no change needed** |
| 6b | `image: ./path` resolution | Build context is relative to action directory | `resolvePath(actionDir, './subdir')` resolves correctly regardless of `process.cwd()`. Confirmed by `scenario-c-path` fixture. | **no change needed** |
| 7 | `args:` with multi-word expression | Multi-word input passed as one argument | `evaluateTemplate` returns a single string per arg entry; passed as one positional arg to `docker run`. `'Hello World'` stays as one arg. | **no change needed** |
| 8 | `entrypoint:` override with `args:` | `--entrypoint <value>` placed correctly | `dockerArgs.push('--entrypoint', entrypoint)` before the image name. `args` become positional after the image. Confirmed with `/bin/sh -c echo...`. | **no change needed** |
| 9 | Post-entrypoint runs after main failure | `post-entrypoint` runs unconditionally | `execPhase('main', ...)` returns a step with `conclusion: 'failure'` — it does NOT throw. `execPhase('post', ...)` runs regardless. Confirmed by `scenario-e-fail` fixture: main exits 1, post still writes `post_ran=true`. | **no change needed** |
| 10 | `GITHUB_STATE` container path | Pre writes state; post reads it across separate containers | Each phase gets a fresh `allocateProtocolFiles()`. After phase exits, JS parses state and injects `STATE_<key>` env vars into next phase. Containers never share a file path — state flows via the JS-side accumulator. | **no change needed** |

---

## 3. Protocol mounting assessment

**`docker run` command shape (per phase):**
```
docker run --rm \
  -e INPUT_<NAME>=<value> \
  -e GITHUB_OUTPUT=/tmp/actspec-<id>/output \
  -e GITHUB_ENV=/tmp/actspec-<id>/env \
  -e GITHUB_STATE=/tmp/actspec-<id>/state \
  -e GITHUB_PATH=/tmp/actspec-<id>/path \
  -e GITHUB_STEP_SUMMARY=/tmp/actspec-<id>/summary \
  -e GITHUB_REPOSITORY=... \
  [... other context env vars ...] \
  [... STATE_<key>=<value> for each accumulated state entry ...] \
  -v /tmp/actspec-<id>/output:/tmp/actspec-<id>/output \
  -v /tmp/actspec-<id>/env:/tmp/actspec-<id>/env \
  -v /tmp/actspec-<id>/state:/tmp/actspec-<id>/state \
  -v /tmp/actspec-<id>/path:/tmp/actspec-<id>/path \
  -v /tmp/actspec-<id>/summary:/tmp/actspec-<id>/summary \
  [--entrypoint <entrypoint>] \
  <image> [args...]
```

**Permission invariant (H8):** `chmodSync(p, 0o666)` on all five protocol files before every `docker run` invocation. Applied per-phase, not at creation time.

**Path strategy:** exact host path = container path. Works on macOS via Docker Desktop's `/tmp` VM share. The `tmpdir()` call returns `/tmp` on macOS under Docker Desktop — not `/var/folders/...`. No path translation needed.

**State threading:** each phase gets its own fresh `allocateProtocolFiles()`. After each phase, `parseProtocolFile(protocol.state)` accumulates state entries into a JS-side `Map`. Next phase receives `STATE_<key>` env vars from that Map. The `$GITHUB_STATE` path is different in each container — they never share a file.

---

## 4. Image source assessment

| Source | Detection | Resolution | Cache |
|--------|-----------|------------|-------|
| `docker://alpine:3.19` | `image.startsWith('docker://')` | Strip prefix → `alpine:3.19` passed to `docker run` | None (Docker layer cache handles it) |
| `image: Dockerfile` | literal string `'Dockerfile'` | Build context = action directory | In-process `Map`, key = SHA-256(Dockerfile content + .dockerignore content)[:16] |
| `image: ./subdir` | anything else | `resolve(actionDir, image)` — resolved relative to action directory | Same in-process `Map` |

**Cache key construction:** `createHash('sha256').update(dockerfileContent + dockerignoreContent).digest('hex').slice(0, 16)`. Empty `.dockerignore` → absent (key input is empty string).

**Cache scope:** module-level `Map<string, string>`. Persists across `actspec().run()` calls within one process. Cleared between Vitest test files (each worker gets a fresh module graph). `clearImageCache()` exported for explicit control.

**Invalidation confirmed:** `scenario-c` (bare `FROM alpine:3.19`) and `scenario-c-alt` (adds `ENV VARIANT=alt`) produce distinct cache keys. `getImageCacheSize()` grows from 1 → 2 when both are run; stays at 2 when the first is re-run (cache hit).

---

## 5. `args:` / `entrypoint:` wiring assessment

Each entry in `args:` is evaluated independently via `evaluateTemplate(arg, ctx)` where `ctx` is built from the action's full input context. The evaluated string is passed as a single positional argument to `docker run` — **no shell-splitting of the result**. A multi-word input value (`'Hello World'`) passes as one argument.

`entrypoint:` → `--entrypoint <value>` placed in `dockerArgs` before the image name. Positional `args` follow the image name. This correctly overrides the image's `ENTRYPOINT`; args replace `CMD`.

**Confirmed `docker run` structure:**
```
docker run --rm [env flags] [mount flags] --entrypoint /bin/sh alpine:3.19 -c 'echo "greeting=World" >> $GITHUB_OUTPUT'
```
The `-c` and the shell command are two distinct positional args (two entries in the YAML `args:` list).

---

## 6. Lifecycle assessment

**Phase order:** `pre-entrypoint` → `entrypoint` → `post-entrypoint`. Each is a separate `docker run` invocation against the same resolved image.

**Unconditional post execution (probe #9):** `execPhase('main', ...)` returns a `StepResult` with `conclusion: 'failure'` when the container exits non-zero — it does NOT throw. The `execPhase('post', ...)` call is therefore always reached. Confirmed: `scenario-e-fail` fixture has main exit 1; post runs and writes `post_ran=true`.

**Phase discriminators:** `StepResult.phase` values are `'pre'` / `'main'` / `'post'` matching the invocation order. All present in `RunResult.steps`.

**Output merging:** outputs from all phases are merged into `RunResult.outputs` (last-write-wins per key). Docker `post-entrypoint` is a first-class output producer.

**Overall conclusion:** `steps.some(s => s.conclusion === 'failure') ? 'failure' : 'success'`. If main fails but post succeeds, `RunResult.conclusion` is `'failure'`. This matches GitHub's behavior.

---

## 7. Mock backend integration

`container: 'mock'` (default) → `runContainerAction` checks `mocks.hasMock(actionRef)` at the top. If a mock is registered: returns declared outputs as a synthetic `RunResult`. If unmocked: returns stub success with empty outputs. Zero Docker invocations.

`action.mock(ref, { outputs: {...} })` is the same call as for composite/node actions — no new API. H7 confirmed: 4 Scenario A tests pass on a machine with Docker installed but daemon not invoked.

**`uses:` interception in composites:** handled by `execUsesStep` checking `MockRegistry` before dispatching — the docker executor never runs for mocked child actions.

---

## 8. Proposed changes

| Change | Where | Why | Priority |
|--------|-------|-----|----------|
| Document `chmod 0o666` invariant | `docs/CONVENTIONS.md` | H8 confirmed; implementors must not remove it | ✅ Done |
| Update `ContainerSandbox` description | `docs/ARCHITECTURE.md → Sandboxes` | Spike findings add concrete details | ✅ Done |
| Document `post-entrypoint` unconditional execution | `docs/ARCHITECTURE.md → Fidelity` | Probe #9 confirmed: no `post-if` analog for docker actions | ✅ Done |
| Document macOS `/tmp` path behavior | `docs/ARCHITECTURE.md → Sandboxes` | Probe #2 resolved: Docker Desktop maps `/tmp` correctly; no `/var/folders` issue | Done in this document |
| State key hyphen limitation | `docs/API.md` or `docs/ARCHITECTURE.md` | Keys with hyphens in `$GITHUB_STATE` produce `STATE_cache-key` which is not a valid shell variable name — action authors should use underscores | **Nice-to-have doc note** |
| Export `getImageCacheSize()` for test instrumentation | `spike/docker/src/container.ts` | Required to assert H4 invalidation test | ✅ Done (spike only; not promoted to `@actspec/docker`) |

---

## Exit decision

**All 21 tests pass. No design gaps. Gate met.**

The spike's `ContainerSandbox` and docker executor are the starting point for `@actspec/docker`. The design is confirmed as-is:

- **Bind-mount protocol:** exact host path = container path. Works on Linux and macOS Docker Desktop. `chmod 0o666` before each `docker run` handles non-root containers.
- **Three image sources:** normalized and working. Content-hash cache correct.
- **`args:`/`entrypoint:` wiring:** correct. No shell-splitting surprise.
- **Pre/main/post lifecycle:** correct. Post unconditional. State threading via JS accumulator.
- **Mock backend:** zero daemon dependency by default.

Proceed to build `@actspec/docker` per [v0.3.md](../versions/v0.3.md) once v0.2 is validated. Evolve `spike/docker/src/` into the package — do not start from scratch.
