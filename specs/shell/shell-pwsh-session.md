# Spec: pwsh persistent session

## Goal

Replace the current per-step `pwsh` process spawn with a **session-per-run** model: one persistent `pwsh` host process is started once at the beginning of an action run and shared across all `shell: pwsh` steps in that run. Each step sends its script to the session over a stdin/stdout protocol; the session executes it, redirects stdout/stderr to temp files, and reports the exit code back. Most runs pay the ~500ms startup cost once.

---

## Why only pwsh (for now)

- `bash` / `sh`: ~5ms startup — no problem.
- `node`: already runs in-process via `runInSandbox`.
- `python`: ~50–150ms startup; meaningful but the isolation path is weaker. Will follow this spec as a model once it's validated.
- `cmd`: Windows-only; not targeted.

---

## The `exit` problem — resolved by spike

**Spiked result:** `exit N` inside a dot-sourced script (`. script.ps1`) does **not** kill the host process. The dot-source scope exits and returns to the host with `$LASTEXITCODE = N`. The host captures the code, writes the reply, and continues the loop. Direct `pwsh -Command "exit N"` does terminate the process — but that is irrelevant here since the host always uses dot-source.

The session-restart-on-exit logic originally described in this spec is therefore **not needed**. The session survives user `exit` automatically. `PwshSession.run()` will always receive a reply line; the premature-close path is only needed for genuine host crashes (bugs in `pwsh-host.ps1`), not for user `exit`.

`$LASTEXITCODE` **leaks between steps**: if a step sets `$LASTEXITCODE = 42` (via `exit 42` or an external process) and the next step runs only PS cmdlets, `$LASTEXITCODE` remains 42. The host script resets `$global:LASTEXITCODE = 0` before each dot-source to prevent this.

---

## Host script — `pwsh-host.ps1`

A PowerShell script bundled at `packages/shell/src/pwsh-host.ps1`. The `PwshSession` spawns `pwsh -NonInteractive -File pwsh-host.ps1` once per session.

The host loop:

1. Read one JSON line from stdin.
2. Parse: `{ scriptPath, stdoutPath, stderrPath, cwd, env, coverage }`.
3. Clear the current process env; set every key from `env`.
4. `Set-Location $cwd`.
5. Reset `$global:LASTEXITCODE = 0` (prevents leakage from the previous step).
6. If `coverage` is true: read line count from `scriptPath`; for each line, use `Set-PSBreakpoint` with `.GetNewClosure()` to register a hit counter in `$global:coverageHits`.
7. Execute: `. "$scriptPath" *> $stdoutPath 2> $stderrPath`
8. If breakpoints were set: `Remove-PSBreakpoint`.
9. Capture `$code = $LASTEXITCODE`.
10. Serialize `$global:coverageHits` to compact JSON (`ConvertTo-Json -Compress`); use `'{}'` when coverage is disabled.
11. Write sentinel: `[Console]::WriteLine("__ACTHARNESS_DONE__$code $coverageJson")`.
12. Loop.

**Why `Set-PSBreakpoint` instead of `Set-PSDebug -Trace 2`:** Spiked. `Set-PSDebug -Trace 2` traces go to `Console.Out` (fd 1), bypassing `*>`, contaminating the protocol channel. All approaches to isolate those traces were rejected (see spike results). `Set-PSBreakpoint` keeps coverage data in-memory; no output channel is involved. No false hits, no stream contamination.

**Why `.GetNewClosure()` per breakpoint:** PowerShell scriptblocks are not closures — they look up variables at call time. Without `.GetNewClosure()`, every action would capture the same `$ln` (the last loop value). `.GetNewClosure()` snapshots the current variable scope for each iteration, giving each breakpoint its own correct line number.

**Why `$global:coverageHits`:** Breakpoint actions run in their own scope; `$script:` does not reach the loop-body scope where `coverageHits` is defined. `$global:` is visible everywhere in the process.

**Why `Set-PSDebug -Off` is not called:** Not needed. Coverage is tracked by breakpoints, not by `Set-PSDebug`. If a user script calls `Set-PSDebug -Trace 2` themselves, its trace output appears on host stdout but Node reads only the sentinel line — trace noise is harmless and never misinterpreted.

**Comment and blank line coverage behavior:** `Set-PSBreakpoint` auto-promotes breakpoints on non-executable lines (comments, blank lines) to the next executable line and fires both. This matches V8 raw coverage behavior: blank and comment lines within executed code appear as covered. Spiked and confirmed consistent.

---

## `PwshSession`

A class in `packages/shell/src/pwsh-session.ts`.

```text
PwshSession
  spawn()    — starts pwsh with pwsh-host.ps1, pipes stdin/stdout/stderr
  run(opts)  — sends one step's JSON message, awaits the exit-code reply or process close
  isAlive()  — true if process is still running
  kill()     — SIGTERM + SIGKILL escalation (same pattern as current timeout handling)
```

`run(opts)` behavior:

- Writes the JSON message to stdin.
- Reads one line from host stdout OR waits for the `close` event.
- If sentinel arrives (`__ACTHARNESS_DONE__<N> <json>`): parse `N` as exit code and `json` as coverage hits; read temp files; return `{ exitCode, timedOut: false, coverage }`.
- If `close` arrives first: use process exit code; mark session dead; call `pool.invalidate(runId)`; return result. On macOS pwsh 7.x (spiked) user `exit N` does not close the host — it returns normally. On other platforms this path is a defensive fallback for any case where the host does exit early (host crash or platform-specific `exit` behavior).
- Timeout: if `opts.timeout` elapses before either arrives, `kill()` the session; call `pool.invalidate(runId)`; return `timedOut: true, exitCode: 124`. After `kill()`, `isAlive()` returns false; the next `pool.getOrCreate(runId)` detects the dead session and starts a fresh one.

---

## `PwshSessionPool`

A class in `packages/shell/src/pwsh-session-pool.ts`. Lives as a field on `ShellSandbox` (created once, shared across all runs handled by that sandbox instance).

```text
PwshSessionPool
  getOrCreate(runId) — returns the live session for runId, or creates a new one
  invalidate(runId)  — marks session dead (host crash path only); next getOrCreate starts a new one
  endRun(runId)      — kills the session and removes it from the map
```

`invalidate` is called whenever `PwshSession.run()` detects a premature `close` — whether from a host crash or from platform-specific `exit` behavior. On macOS pwsh 7.x (spiked), user `exit` does not close the host, so this path is not triggered by user scripts. It is kept as a defensive fallback for other platforms and for host bugs.

---

## `ShellSandbox` changes

In `shell-sandbox.ts`, the `shell()` method adds a pwsh branch:

```text
if shell is pwsh or powershell AND opts.runId is set:
  1. write script to temp .ps1 file — no modification (no Set-PSDebug prepend)
  2. create temp stdoutPath and stderrPath
  3. start/stop the network proxy scope (same as today)
  4. inject proxy env vars into opts.env (same as today)
  5. get session from pool: pool.getOrCreate(opts.runId)
  6. call session.run({ scriptPath, stdoutPath, stderrPath, cwd, env, coverage: pwshCoverageEnabled, timeout })
     → returns { exitCode, timedOut, coverage: Record<number, number> }
  7. if session died (premature close): pool.invalidate(opts.runId)
  8. read stdout and stderr from temp files
  9. if pwshCoverageEnabled: convert session.run().coverage from Record<string,number> (JSON keys are always strings) to Record<number,number> for shellCoverage.lineHits — e.g. Object.fromEntries(Object.entries(coverage).map(([k, v]) => [Number(k), v]))
  10. clean up temp files and script dir
  11. return ShellSandboxResult
```

When `opts.runId` is absent (unit tests, or any caller that hasn't opted in): fall through to the current per-step spawn path. No regression.

---

## `ShellSandboxOptions` change

Add one optional field to the existing type in `@actharness/core`:

```typescript
runId?: string
```

An opaque identifier for the current action run. Presence enables session reuse; absence falls back to per-step spawn.

---

## Composite runner integration

In `packages/composite`:

- `run()` generates a UUID as the run's `runId` (using `node:crypto`'s `randomUUID()`).
- Every call to `sandbox.shell(opts)` from the step runner receives `runId`.
- After the run completes (success or failure), call `sandbox.endRun(runId)` to kill the session and free resources.

`sandbox.endRun()` is a new method on `ShellSandbox` that delegates to `pool.endRun(runId)`.

---

## Protocol

Request (one JSON line, written to host stdin per step):

```json
{
  "scriptPath": "/tmp/actharness-script-abc/script.ps1",
  "stdoutPath": "/tmp/actharness-step-xyz/stdout",
  "stderrPath": "/tmp/actharness-step-xyz/stderr",
  "cwd": "/tmp/actharness-workspace-123/subdir",
  "env": { "GITHUB_OUTPUT": "/tmp/...", "INPUT_NAME": "Alice", "TEST_ENV": "override" },
  "coverage": true
}
```

`env` is the **full** merged env dict for the step — exactly what the composite runner would pass to `spawn()` today. The host script replaces its entire process env with this dict on every step, ensuring complete isolation between steps.

`coverage` is `true` when `pwshCoverageEnabled`, `false` otherwise. The host sets up `Set-PSBreakpoint` instrumentation only when `true`.

Response (one sentinel line, written to host stdout):

```text
__ACTHARNESS_DONE__0 {"1":1,"2":1,"3":1}
```

Always exactly one line per step. The sentinel encodes the exit code and a compact JSON object of line hit counts (`lineNumber → hitCount`). When coverage is disabled or no lines were hit, the JSON is `{}`. Node reads the sentinel, splits on the first space, and parses both parts.

---

## Feature preservation

| Feature | Current mechanism | Preserved how |
| --- | --- | --- |
| Per-step env vars | `spawn()` env | Full env dict in `env` field; host replaces process env each step |
| Step-level `env:` overrides | Merged into `spawn()` env | Same: composite merges before building the dict |
| `GITHUB_ENV` threading | Composite reads file, adds to next step's env | Unchanged — composite still builds env dict |
| `GITHUB_PATH` | Composite reads file, prepends to next step's PATH | Unchanged |
| `working-directory` | `cwd` on `spawn()` | `cwd` in JSON; host calls `Set-Location` |
| `exit` / continue-on-error | Process exits; code captured from `close` event | On macOS pwsh 7.x (spiked): `exit N` returns to host via dot-source scope exit; session survives; host writes exit code as normal reply. Premature-close fallback kept for other platforms. |
| `timeout` | Kill process; `timedOut: true, exitCode: 124` | Kill session; same `timedOut`/`exitCode` |
| Coverage (`Set-PSDebug -Trace 2`) | Prepended to script file; parse stdout | `Set-PSBreakpoint` per line; no script modification; hit counts in sentinel JSON; `parsePwshCoverage` not used in session path |
| Annotations (`::warning::`) | Parsed from captured stdout | Read from stdoutPath |
| Network proxy | Proxy env vars injected into `spawn()` env | Same vars included in the `env` dict |

---

## Acceptance

### Unit tests — `packages/shell/test/pwsh-session.test.ts`

New unit test file (mocks `child_process.spawn`):

1. **Session reuse** — three consecutive pwsh steps with the same `runId`; `spawn` is called exactly once.
2. **`exit` survives session** — step 2 script calls `exit 42`; host returns `42` as a normal reply; step 3 runs on the same session (no restart); all three return correct exit codes.
3. **Premature close restarts session** — simulate premature `close` event (host crash or platform exit); `pool.invalidate` is called; step 3 gets a new process.
4. **Env replacement** — step 1 has `env.TEST_ENV = "a"`; step 2 has `env.TEST_ENV = "b"`; verify the JSON messages sent to stdin contain the correct full env each time (no leakage).
5. **CWD per step** — two steps with different `cwd` values; verify both JSON messages contain the correct `cwd`.
6. **Coverage** — when `coverage: true`, the `.ps1` file written to disk is unchanged; `session.run()` receives `coverage: true`; the host instruments with `Set-PSBreakpoint`; sentinel returns hit counts as JSON; `session.run()` returns `coverage: Record<number,number>`; `parsePwshCoverage` is not called in the session path.
7. **Timeout** — session process is slow to respond; after `opts.timeout` ms, `kill()` is called; result has `timedOut: true, exitCode: 124`; subsequent step gets a fresh session.
8. **No runId → per-step spawn** — calling `shell()` without `runId` falls through to the existing `spawnAndCapture` path; no `PwshSessionPool` involved.

### Integration tests

`fixtures/pwsh/` — all existing tests pass without modification.

---

## Packages to change

| Package | Change |
| --- | --- |
| `packages/shell` | New `PwshSession`, `PwshSessionPool`, `pwsh-host.ps1`; modify `shell-sandbox.ts`; export `endRun` via `ShellSandbox` |
| `packages/core` | Add optional `runId?: string` to `ShellSandboxOptions`; add `endRun(runId: string): void` to `SandboxFactory` (optional method — callers that don't implement it are unaffected) |
| `packages/composite` | Generate `runId` per `run()` call; pass to step runner; call `sandbox.endRun(runId)` in the run's `finally` block |

---

## Open questions — resolved by spikes

All three open questions have been resolved. See `shell-pwsh-session-spike-results.md` for full details.

1. **Coverage mechanism** — `Set-PSDebug -Trace 2` traces bypass `*>` and go to `Console.Out` (fd 1). All approaches to isolate them were spiked and rejected (`Console.SetOut` crashes on second step; sentinel + DEBUG: collection produces an unfixable false hit from the host's `Set-PSDebug -Off` call). Final resolution: abandon `Set-PSDebug -Trace 2` for the session path entirely. Use `Set-PSBreakpoint` per line instead — coverage data stays in-memory, serialized to JSON in the sentinel. No stream contamination, no false hits. Spiked and confirmed.

2. **Env replacement cost** — ~98ms per step with 200 env vars (includes all per-step overhead). Negligible vs the 500ms startup cost being amortized.

3. **Host crash vs user `exit`** — moot. `exit N` in a dot-sourced script does not close the host; it returns normally. The premature-`close` path in `PwshSession.run()` now unambiguously signals a host crash (not a user action).
