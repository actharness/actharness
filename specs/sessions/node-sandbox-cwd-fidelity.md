# Node sandbox cwd fidelity (worker_threads → child_process) — handoff spec

**Status: IMPLEMENTED.** `packages/node/src/js-sandbox.ts` now uses `child_process.fork` with `cwd` set to the run's workspace; `packages/node/src/sandbox-bootstrap.mjs` (renamed from `worker-bootstrap.mjs`) replaces `parentPort`/`workerData` with `process.send`/an init IPC message. See [specs/modules/node.md](../modules/node.md) for the current architecture description. `fixtures/checkout-workspace/node-reader-relative/` validates a bare-relative-path node action now resolves correctly. `inspector.Session` coverage was verified to work unmodified in a plain child process, and `fork()` startup overhead was measured as negligible (~1.5s for the `fixtures/node-api` suite, same as the worker_threads baseline) — no fallback worker mode was added.

## The gap

On the real GitHub Actions runner, `GITHUB_WORKSPACE` *is* the process's actual working directory by default ("the working directory of your runner ... the equivalent of `pwd`, assuming no directory changes are made" — confirmed via web search during the session that found this, see Sources below). So a real `node20`/`node22` action can do `fs.readFileSync('./some-file.txt')` (a bare relative path) and have it resolve against the repo checkout, with no explicit `GITHUB_WORKSPACE` handling needed.

This harness's node-action sandbox does not reproduce that. `packages/node/src/js-sandbox.ts` runs the action's entrypoint inside a `worker_threads.Worker` (`js-sandbox.ts:89`), and **nothing in `packages/node/src/*` ever sets that worker's cwd** — confirmed via full grep, zero `cwd`/`chdir` hits in the package. A worker thread inherits the host process's cwd (wherever `actharness test`/the test process itself was launched from), not `GITHUB_WORKSPACE`.

## Why this can't be fixed with a small patch (tested, not assumed)

The obvious fix — call `process.chdir(workspace)` early in `packages/node/src/worker-bootstrap.mjs` — **does not work**. Verified directly:

```js
// inside a worker_threads.Worker:
process.chdir('/tmp'); // throws
// TypeError [ERR_WORKER_UNSUPPORTED_OPERATION]: process.chdir() is not supported in workers
```

Node disallows `process.chdir()` unconditionally inside worker threads. The next idea — monkey-patch the JS-visible `process.cwd` function to return the workspace path, without really calling `chdir` — **also does not work**. Verified directly: overriding `process.cwd = () => '/some/dir'` inside a worker and then calling `fs.readFileSync('relative/path')` still fails with `ENOENT`, resolving against the real OS-level cwd. `fs`'s relative-path resolution goes through a native binding that reads the actual process cwd, not the overridable JS function.

**Conclusion: there is no way to give a node action script in this harness a different effective cwd for plain relative-path `fs` calls while the sandbox is a `worker_threads.Worker`.** The only way to truly fix this is to stop using `worker_threads` for node actions and use a real child process instead (`child_process.fork`/`spawn`, which do support a `cwd` option).

## Why this matters (the user's stated reasoning)

This was almost dropped as "just document GITHUB_WORKSPACE, real actions should use it anyway" — but the user explicitly pushed back: *"if we have bad developers, I want to also be able to test bad code, and not limit the library, if GitHub Actions also dont limit."* I.e.: real GitHub Actions does NOT require an action author to use `GITHUB_WORKSPACE` explicitly — relying on bare relative paths actually works on the real runner (sloppy as that may be), and a test harness whose entire job is faithfully reproducing action behavior shouldn't impose a stricter discipline than the real platform does. An action that happens to work in production via cwd-relative paths should also work (or be testably reproduced, bugs included) under this harness.

So: **the workaround of "just use `process.env.GITHUB_WORKSPACE`" is an acceptable stopgap for now, not an accepted permanent answer.** The user wants this properly fixed via the sandbox change, just scoped as its own session rather than folded into the workspace-seeding feature.

## What "switch to child_process" would actually involve (not designed yet — scoping notes only)

Two things `worker_threads` currently provides that a child process would need an equivalent for:

1. **V8 coverage collection.** `worker-bootstrap.mjs` uses the `inspector` module's `Session` (`new Session(); session.connect();` — in-process inspector API) to call `Profiler.startPreciseCoverage`/`takePreciseCoverage`. A child process can use the same `inspector` module the same way internally (it's just a different OS process running the same bootstrap script) — this part likely ports over close to as-is, since `inspector.Session` works the same inside any Node process, not just worker threads. Needs verification, not assumed.
2. **IPC (`parentPort.postMessage` → `worker.on('message', ...)`).** `packages/node/src/js-sandbox.ts` listens on `worker.on('message', ...)` for `'v8coverage'`/`'done'`/`'apiHit'`/`'networkHit'` events (see `js-sandbox.ts:110-120`), and `worker-bootstrap.mjs` sends them via `parentPort.postMessage`. A child process would use `child.send(...)`/`process.send(...)` (Node's built-in `child_process` IPC channel, available when spawned with `{ stdio: [...,'ipc'] }` or via `child_process.fork`) instead of `parentPort`. Conceptually a straightforward swap, but every call site in both files needs updating and testing.
3. **`stdout`/`stderr` capture.** Already works similarly for both (`worker.stdout`/`worker.stderr` vs a child process's `stdout`/`stderr` streams) — `js-sandbox.ts:107-108` already reads `worker.stdout.on('data', ...)`. Likely no behavior change needed here.
4. **`cwd`.** The actual point of this change — `child_process.fork(BOOTSTRAP, [], { cwd: workspace, ... })` directly supports what's needed; `worker_threads.Worker` has no equivalent option at all.
5. **Startup cost.** Spawning a real OS process per node-action run (today: per `worker_threads.Worker`, which is cheaper) — worth measuring before/after on the existing `fixtures/node-api` test suite, since this could meaningfully slow down test runs with many node-action fixtures. Not a blocker, but should be measured, not assumed negligible.

## Open questions for the implementing session

1. Confirm with the user this is still wanted before starting (per `CLAUDE.md` — this spec exists to be read first, not executed first).
2. Decide: full replacement of `worker_threads` with `child_process` for all node actions, or only as a fallback/option? (The spec-writing session has no opinion recorded yet — wasn't discussed in enough depth to default either way.)
3. Validate the `inspector.Session` coverage mechanism actually works unmodified in a plain child process before assuming point 1 above "just ports over."
4. Once switched, the original ask this all stemmed from becomes testable: a fixture/integration test where a node action does `fs.readFileSync('./checked-out-file.txt')` (bare relative path, no `GITHUB_WORKSPACE`) and it resolves correctly when seeded via `options.workspace` + a checkout step (see `specs/sessions/workspace-seeding.md`, which this depends on / complements).

## In the meantime

The workspace-seeding feature (`specs/sessions/workspace-seeding.md`) ships independently of this. Its integration test for "a node script can access a seeded file" should be written using `process.env.GITHUB_WORKSPACE` to build the path, with a comment noting that a bare-relative-path variant is blocked on this spec.

## Sources

- [Understanding GitHub Actions Working Directory](https://dev.to/jajera/understanding-github-actions-working-directory-550o)
- [Get the Absolute Path of the Default Working Directory in GitHub Actions](https://en.bioerrorlog.work/entry/github-actions-default-workspace)
