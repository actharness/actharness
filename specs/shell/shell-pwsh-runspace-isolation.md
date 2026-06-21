# Spec: pwsh step isolation via Runspace-per-step + rolling sessions

Companion to `shell-pwsh-session.md`. That spec introduced the persistent `pwsh` host process (one per run) and solved the 500ms-per-step startup cost. This spec solves the remaining isolation gap (L3): `$global:` state, functions, modules, and `Add-Type`-created types leaking between steps within the same run.

---

## Problem

The current persistent session (one `PwshSession` per `runId`) runs every step in the host's **main runspace** via `. "$scriptPath"`. Because all steps share the same runspace:

- `$global:` variables set in step N are visible in step N+1.
- Functions defined in step N exist in step N+1.
- Loaded modules (`Import-Module`) persist.
- `$PSDefaultParameterValues` set in one step affects subsequent steps.
- `Add-Type -TypeDefinition` compiles a type into the AppDomain; a second step defining the same type name with a different body throws `"The type name 'Foo' already exists"`.

On the real GitHub Actions runner each step is a **separate process**, so none of this leaks. actharness currently diverges from real-runner behaviour in all the above ways.

The per-step-process approach fixes everything but costs ~500ms per step (measured: fixture went from 1m 30s to 2m 39s, +75%). This spec describes a better tradeoff.

---

## Approach overview

Two mechanisms combined:

1. **Runspace-per-step** — inside the persistent host process, each step runs in a freshly created and immediately disposed `[System.Management.Automation.Runspaces.Runspace]`. Runspaces are lightweight: creating and opening one takes ~5–20ms. Each Runspace has its own variable scope, function scope, module scope, and `$PSDefaultParameterValues`. Everything except AppDomain-level state is fully isolated.

2. **Rolling sessions on `Add-Type` detection** — `Add-Type -TypeDefinition` loads a dynamic assembly into the AppDomain, which is shared across all Runspaces in the same process. After each step the host checks whether new dynamic assemblies appeared (AppDomain snapshot diff). If yes, it includes `addTypeDetected: true` in the sentinel reply. `ShellSandbox` then calls `PwshSessionPool.roll(runId)`: the current session is killed and a fresh `pwsh` process is started for the next step. The next step runs in the new process's first Runspace — clean AppDomain, no contamination from the old session's `Add-Type` calls.

The result:

| Scenario | Mechanism | Per-step cost |
|---|---|---|
| No `Add-Type` ever | Runspace per step | ~5–20ms |
| Step N uses `Add-Type` | Runspace (succeeds); roll triggered | ~5–20ms for step N |
| Step N+1 (after roll) | New process, first Runspace | ~500ms one-time |
| Step N+2 (after roll, no `Add-Type` in N+1) | Same process, new Runspace | ~5–20ms |
| Step N+1 also uses `Add-Type` | New process, Runspace; roll triggered again | ~500ms + roll again |

The 500ms cost is proportional to the number of `Add-Type` occurrences in the action, not to the number of subsequent steps.

---

## Runspace-per-step

### What a Runspace provides

A `Runspace` is a PowerShell execution context within a process. It has:
- Its own variable scope (including `$global:`) — isolated from other Runspaces
- Its own function scope
- Its own module list
- Its own `$PSDefaultParameterValues`

It shares with the host process:
- The .NET AppDomain (loaded assemblies — the `Add-Type` problem addressed below)
- Environment variables at the OS level (`[System.Environment]::GetEnvironmentVariable`) — but these are explicitly set per step via env replacement (see below)
- Any static .NET state on non-dynamic types — see [Known gap](#known-gap)

### Runspace lifecycle inside `pwsh-host.ps1`

For each step request, the host:

1. Creates a new Runspace: `$rs = [runspacefactory]::CreateRunspace()`
2. Opens it: `$rs.Open()`
3. Creates a PowerShell invocation: `$ps = [powershell]::Create(); $ps.Runspace = $rs`
4. Adds the step wrapper script (see below) via `$ps.AddScript($stepScript)`
5. Synchronously invokes: `$result = $ps.Invoke()`
6. Reads `addTypeDetected` from AppDomain snapshot diff (done at host level — see below)
7. Disposes: `$ps.Dispose(); $rs.Close(); $rs.Dispose()`
8. Writes the sentinel reply

### Step wrapper script

The script added to `$ps` (built by the host for each step, not the user script itself):

```powershell
param($scriptPath, $stdoutPath, $stderrPath, $cwd, $env, $coverage, $lineCount)

# 1. Replace env
[System.Environment]::GetEnvironmentVariables([System.EnvironmentVariableTarget]::Process).Keys |
  ForEach-Object { [System.Environment]::SetEnvironmentVariable($_, $null) }
foreach ($pair in $env.GetEnumerator()) {
  [System.Environment]::SetEnvironmentVariable($pair.Key, $pair.Value)
}

# 2. Set working directory
Set-Location $cwd

# 3. Reset $LASTEXITCODE
$global:LASTEXITCODE = 0

# 4. Coverage setup — register breakpoints in THIS runspace
$hits = @{}
if ($coverage) {
  for ($ln = 1; $ln -le $lineCount; $ln++) {
    $capturedLn = $ln
    Set-PSBreakpoint -Script $scriptPath -Line $ln -Action {
      if ($hits.ContainsKey($capturedLn)) { $hits[$capturedLn]++ } else { $hits[$capturedLn] = 1 }
    }.GetNewClosure() | Out-Null
  }
}

# 5. Execute user script
# *> redirects all PS streams (1-7) to stdoutPath; 2>> then redirects stream 2
# to stderrPath instead. Inside a [PowerShell]::Create() Runspace, explicit
# per-stream redirects (1> 4>> 5>> 6>>) lose streams 1, 4, and 5 — *> is required.
. "$scriptPath" *> $stdoutPath 2>> $stderrPath

# 6. Capture exit code
$code = $LASTEXITCODE

# 7. Cleanup breakpoints
if ($coverage) { Get-PSBreakpoint | Remove-PSBreakpoint }

# 8. Return result object (pipeline output — not captured by file redirection)
[pscustomobject]@{ ExitCode = $code; Coverage = $hits }
```

The host reads `$result[0].ExitCode` and `$result[0].Coverage` from `$ps.Invoke()`.

### Why env replacement uses `[System.Environment]` not `$env:`

Inside a Runspace, `$env:FOO = 'bar'` sets a **Runspace-scoped** env variable — it doesn't change the process env. The user script runs inside the Runspace so it sees `$env:FOO`. But `[System.Environment]::GetEnvironmentVariable('FOO')` reads the process env, which `$env:FOO` also reads. Runspace-scoped env vars shadow the process env for PS accesses within that Runspace. The two mechanisms don't conflict.

However, the existing approach (replace the entire process env) is kept for consistency with the current host and because child processes spawned by user scripts (`Start-Process`, `Invoke-Expression` via external commands) read the process env — not the Runspace-scoped variables. Runspace-scoped env vars would not propagate to child processes.

The same process-level env replacement from the current `pwsh-host.ps1` is used. It runs at the start of the wrapper script inside the Runspace.

### Coverage inside Runspaces

`Set-PSBreakpoint` with no `-Runspace` parameter registers the breakpoint in the **current runspace** (the one the command runs in). Since the wrapper script runs inside the newly created Runspace, breakpoints are registered there and fire when `. "$scriptPath"` executes. No `-Runspace` parameter needed.

Coverage hits are stored in `$hits` (a hashtable local to the wrapper script). The result object carries them back to the host via `$ps.Invoke()` return value. The sentinel encodes them as compact JSON, same as today.

Breakpoints are removed at the end of each wrapper script execution. They do not accumulate across steps.

---

## Add-Type detection

### Mechanism

`Add-Type -TypeDefinition` compiles C# via Roslyn and loads the result into the AppDomain as an assembly with an **empty `Location`** and `IsDynamic = false`. This is the distinguishing signal on .NET 5+ / pwsh 7.x.

> **Note — `.NET 5+ behaviour`:** On .NET Framework, `Add-Type -TypeDefinition` produced `IsDynamic = true` assemblies. On .NET 5+ (which pwsh 7.x uses), Roslyn emits the compiled assembly differently: `IsDynamic` is `false`, but `Location` is an empty string (no backing file). Pre-compiled assemblies loaded from disk always have a non-empty `Location`. This property is the reliable cross-platform signal.

The detection runs at the **host process level** (not inside the Runspace) because `AppDomain` is shared across all Runspaces:

```powershell
# Before invoking the Runspace:
$preCount = ([System.AppDomain]::CurrentDomain.GetAssemblies() |
  Where-Object { $_.Location -eq '' -and -not $_.IsDynamic } | Measure-Object).Count

# ... invoke Runspace (synchronous $ps.Invoke()) ...

$postCount = ([System.AppDomain]::CurrentDomain.GetAssemblies() |
  Where-Object { $_.Location -eq '' -and -not $_.IsDynamic } | Measure-Object).Count

$addTypeDetected = $postCount -gt $preCount
```

### What this catches

Because the check is on AppDomain assembly load (not textual), it catches all forms:

- `Add-Type -TypeDefinition "class Foo { ... }"` — direct call ✓
- `Invoke-Expression "Add-Type -TypeDefinition '...'"` — runs in current scope, same AppDomain ✓
- `$cmd = 'Add-Type'; & $cmd -TypeDefinition "..."` — command resolution finds the cmdlet, same AppDomain ✓
- Any PowerShell code path that ultimately calls `Add-Type -TypeDefinition` ✓

What it does NOT catch (not a concern for rolling):

- `Add-Type -Path "foo.dll"` / `Add-Type -AssemblyName "..."` — loads pre-compiled assemblies, non-empty `Location`. These do not cause type-name conflicts (two steps loading the same DLL get the same types). No roll needed.
- `[System.Reflection.Assembly]::LoadFrom(...)` — same: pre-compiled, non-empty `Location`.

---

## Rolling sessions

### Trigger

After each step, if `addTypeDetected` is `true` in the sentinel reply, `ShellSandbox` calls `pool.roll(opts.runId)`.

### `PwshSessionPool.roll(runId)`

```text
roll(runId):
  1. Kill the current session for runId (SIGTERM + SIGKILL escalation, same as endRun)
  2. Remove it from the internal map
  3. Do NOT create a new session immediately — let getOrCreate() do it on demand
```

The next call to `pool.getOrCreate(runId)` (from the next step) finds no session, starts a fresh `pwsh` process, and returns the new session. The new session has a clean AppDomain — no dynamic assemblies from the old session.

### What the next step sees

Step N uses `Add-Type` → roll triggered → step N+1 gets a new `PwshSession`:
- New `pwsh` process → clean AppDomain
- Step N+1 runs in the first Runspace of the new process
- `$global:` / functions / modules: clean (new Runspace)
- `$env:` variables: injected fresh from `opts.env` (same as every step)
- Protocol files (`GITHUB_OUTPUT`, `GITHUB_ENV`, etc.): values are in the file contents, not in the session — unchanged

Step N+1 that does NOT use `Add-Type` → no roll → step N+2 runs in a new Runspace within the same new process (fast). ✓

Step N+1 that ALSO uses `Add-Type` → another roll → step N+2 gets yet another fresh process.

---

## IPC protocol changes

### Request — unchanged

```json
{
  "scriptPath": "...",
  "stdoutPath": "...",
  "stderrPath": "...",
  "cwd": "...",
  "env": { ... },
  "coverage": true
}
```

### Response — extended sentinel

Current format:
```
__ACTHARNESS_DONE__<exitCode> <coverageJson>
```

Extended format (new third field):
```
__ACTHARNESS_DONE__<exitCode> <coverageJson> <addTypeDetected>
```

Where `<addTypeDetected>` is `true` or `false`.

`PwshSession.run()` splits the sentinel on spaces, reads field 0 as exit code, field 1 as coverage JSON, field 2 as boolean. Backwards compatibility: if the third field is absent (old host script), treat as `false`.

---

## `pwsh-host.ps1` changes

Replaces the current dot-source execution loop with a Runspace-per-step loop:

1. Parse request JSON (same as today).
2. Record pre-step dynamic assembly count.
3. Build the wrapper script string (parameterized with scriptPath, stdoutPath, stderrPath, cwd, env hashtable, coverage, lineCount).
4. Create Runspace, open it.
5. Create `[powershell]` instance, set its Runspace, add the wrapper script.
6. Synchronously invoke; read `ExitCode` and `Coverage` from result.
7. Dispose Runspace.
8. Compute `addTypeDetected` from post-step assembly count.
9. Write sentinel: `__ACTHARNESS_DONE__$exitCode $($coverage | ConvertTo-Json -Compress) $addTypeDetected`.
10. Loop.

The `$global:coverageHits` variable and the explicit `Remove-PSBreakpoint` loop in the current host are replaced by the wrapper script's local `$hits` hashtable and per-Runspace breakpoint cleanup. The host's main runspace no longer holds any per-step state.

---

## `PwshSession` changes

Minimal. `PwshSession` speaks the IPC protocol; the Runspace mechanism is inside `pwsh-host.ps1`. One change:

- `run()` return type gains `addTypeDetected: boolean` (parsed from sentinel field 2).

---

## `PwshSessionPool` changes

- Add `roll(runId: string): void` — kills and removes the session without creating a replacement.

---

## `ShellSandbox` changes

After `session.run()` returns, check `stepResult.addTypeDetected`:

```text
if (stepResult.addTypeDetected) {
  this.pool.roll(opts.runId);
}
```

The pwsh branch entry condition also changes to account for `pwshIsolation`:

```text
// Before (current):
if (isPwsh && opts.runId !== undefined)

// After:
if (isPwsh && opts.runId !== undefined && opts.pwshIsolation !== 'process')
```

When `pwshIsolation === 'process'`, the pwsh step falls through to `spawnAndCapture` — the same path used today for all non-node shells and for pwsh steps without a `runId`. No session pool, no IPC, fresh `pwsh` process per step.

---

## `pwshIsolation` option

### API

Added to `ShellSandboxOptions` in `@actharness/core`:

```typescript
pwshIsolation?: 'runspace' | 'process'
```

Default: `'runspace'` (when absent or `undefined`).

### Values

| Value | Mechanism | Per-step cost | Isolation |
| --- | --- | --- | --- |
| `'runspace'` (default) | Runspace-per-step + rolling on `Add-Type` | ~5–20ms | Full PS-level; static .NET gap remains |
| `'process'` | Fresh `pwsh` process per step via `spawnAndCapture` | ~500ms | Complete — matches real GitHub Actions runner |

### Where it is set

The composite action runner reads a `pwsh-isolation` field from the composite action's `runs:` configuration and passes it as `opts.pwshIsolation` to `ShellSandbox.shell()`. The field is per-run, not per-step — all steps in the same run share the same isolation mode.

### Documentation

ARCHITECTURE.md and API.md must document:

- Default mode (`'runspace'`): static .NET fields on pre-compiled types are not isolated between steps within the same run. The pattern of mutating `[SomeDll.Class]::_staticField` between steps is not covered.
- `'process'` mode: complete isolation, +75% per-step overhead.

---

## Feature preservation

| Feature | Current mechanism | Preserved how |
|---|---|---|
| `$global:` isolation | Not isolated (shared runspace) | Runspace per step — each step gets a clean global scope |
| Function isolation | Not isolated | Runspace per step |
| Module isolation | Not isolated | Runspace per step |
| `$PSDefaultParameterValues` | Not isolated | Runspace per step |
| `Add-Type` type conflict | Broken (shared AppDomain) | Rolling sessions — next step after `Add-Type` runs in fresh process |
| `$LASTEXITCODE` leakage | Reset by host before each dot-source | Reset inside wrapper script |
| Per-step env vars | Process env replacement by host | Same: wrapper script replaces process env |
| `GITHUB_ENV` threading | Composite reads file, builds next step's env dict | Unchanged — env dict injected per step |
| `working-directory` | `cwd` in JSON; host calls `Set-Location` | Same: wrapper script calls `Set-Location` |
| Coverage | `Set-PSBreakpoint` per line; hits in `$global:coverageHits`; sentinel JSON | `Set-PSBreakpoint` in Runspace; hits in local `$hits`; same sentinel encoding |
| Annotations (`::warning::`) | Parsed from stdoutPath | Unchanged |
| Network proxy | Proxy env vars in `opts.env` | Unchanged — injected via env replacement |
| Timeout | Node kills host process; `timedOut: true` | Unchanged — `$ps.Invoke()` blocks; host process is killed by Node on timeout |
| Host crash / premature close | `pool.invalidate(runId)` | Unchanged |
| No `runId` (unit tests) | Falls through to `spawnAndCapture` | Unchanged |

---

## Known gap — static .NET state on pre-compiled types

### What it is

A .NET class loaded from a pre-compiled DLL (via `Import-Module`, `Add-Type -Path`, or `Add-Type -AssemblyName`) can have **static fields or properties** — values that live on the class itself, not on any instance. In PowerShell these are accessed as `[Namespace.ClassName]::FieldName`.

If step N mutates one of these:

```powershell
[SomeDll.Class]::_retryCount = 5
```

that value persists at the **AppDomain level** for the life of the host process. Step N+1, running in a new Runspace, sees `[SomeDll.Class]::_retryCount` as `5` — not the type's original default. On the real GitHub Actions runner, step N+1 is a fresh process with a clean AppDomain, so it sees the default.

### Why Runspace isolation does not help

A Runspace isolates PowerShell-level state: variables, functions, modules, `$PSDefaultParameterValues`. It does not reset .NET static state — static fields live on the `System.Type` object in the AppDomain, which all Runspaces in the same process share. Creating a new Runspace gives you a clean `$global:` scope but the same static .NET heap.

### Why rolling sessions do not help

Rolling sessions are triggered by the empty-`Location` assembly signal — the `Add-Type -TypeDefinition` indicator. DLL-based types loaded via `Import-Module` or `Add-Type -Path`/`-AssemblyName` are pre-compiled and have a non-empty `Location`. No roll is triggered, so the same session (same process, same AppDomain) continues for all subsequent steps.

### How realistic is this in practice

This requires a step to:
1. Load a module or DLL that exposes a mutable static field (not all do — many are constants or read-only)
2. Deliberately mutate that field (an unusual pattern in typical action scripts)
3. A subsequent step in the same action relying on that field being at its default value

Common action patterns (`$global:` vars, `$env:`, functions, modules) are all handled by Runspace isolation. This gap only applies to the specific pattern of mutating static .NET type state on pre-compiled types — uncommon in real composite actions.

### Resolution — `pwshIsolation: 'process'`

The default isolation mode (`pwshIsolation: 'runspace'`) does not cover this gap. For actions that need complete isolation matching the real GitHub Actions runner, the `pwshIsolation: 'process'` mode is available:

- Every step spawns a **fresh `pwsh` process** with no shared state of any kind.
- The session pool is bypassed entirely for that run — no `PwshSession`, no IPC, no Runspace.
- `ShellSandbox` falls through to `spawnAndCapture` for every pwsh step.
- Cost: ~500ms per step (measured: +75% overhead vs persistent session). Proportional to step count.

This mode is documented in ARCHITECTURE.md and API.md. The default remains `'runspace'`.

---

## What this does NOT fix

The `pwsh-host.ps1` approach wraps only `shell: pwsh` steps in composite actions. Standalone `shell: pwsh` steps (no `runId`) continue to use `spawnAndCapture` — a fresh process per step, already fully isolated. No change there.

---

## Acceptance

### Unit tests — `packages/shell/test/`

Extend existing `pwsh-session.test.ts` and `shell-sandbox-edge.test.ts` (or new file `pwsh-runspace.test.ts`):

1. **Runspace isolation — `$global:`** — step 1 sets `$global:FOO = 'leaked'`; step 2 checks `$global:FOO`; verify step 2 does not see it.
2. **Runspace isolation — functions** — step 1 defines `function MyFn { 'hi' }`; step 2 calls `MyFn`; verify step 2 errors (function not found).
3. **Runspace isolation — modules** — step 1 `Import-Module`s something; step 2 checks `Get-Module`; verify module is not present.
4. **Runspace isolation — `$PSDefaultParameterValues`** — step 1 sets `$PSDefaultParameterValues['Write-Host:ForegroundColor'] = 'Red'`; step 2 checks; verify empty.
5. **Add-Type detection — direct** — step 1 has `Add-Type -TypeDefinition "public class Spike1 {}"` ; verify sentinel returns `addTypeDetected: true`.
6. **Add-Type detection — no Add-Type** — step with no `Add-Type`; verify sentinel returns `addTypeDetected: false`.
7. **Add-Type detection — dynamic only** — step uses `Add-Type -AssemblyName "System.Web"` (loads pre-compiled, non-empty `Location`); verify `addTypeDetected: false`.
8. **Rolling session** — step 1 uses `Add-Type`; verify `pool.roll()` is called; step 2 gets a new session (new process); step 2 can define the same type name without conflict.
9. **Rolling is not permanent** — after roll, step 2 has no `Add-Type`; step 3 runs on step 2's session (no further roll); verify only one extra process spawned.
10. **Consecutive Add-Types** — steps 1, 2, 3 all use `Add-Type`; verify three process startups total (one per Add-Type step).
11. **Coverage in Runspace** — pwshCoverageEnabled step; verify breakpoints fire; sentinel returns hit counts; `lineHits` in result is correct.
12. **Coverage does not leak between steps** — step 1 coverage; step 2 coverage on different script; verify each step's `lineHits` contains only its own lines.
13. **Timeout kills host** — step hangs; timeout fires; `kill()` called; result `timedOut: true`; next step gets new session.

### Integration — `fixtures/pwsh/`

All 13 existing fixture tests must pass unchanged. The fixture exercises env threading, working-directory, continue-on-error, if: conditions, Write-Warning, annotations — all must be preserved.

No new fixture test needed for isolation specifically (unit tests above cover it) unless a real multi-step `Add-Type` scenario is later added to `fixtures/pwsh/action.yml`.

---

## Spike findings — all questions resolved

All spikes were run on Apple Silicon / pwsh 7.x prior to implementation. Results recorded here for reference.

1. **`$ps.Invoke()` and file redirection** — **resolved.** `*> $stdoutPath 2>> $stderrPath` works correctly inside a Runspace: all PS streams (1, 3–7) land in stdoutPath; stream 2 lands in stderrPath. The current host's explicit `1> 4>> 5>> 6>>` form loses streams 1, 4, and 5 inside a Runspace and must not be used in the wrapper script.

2. **`$ps.Invoke()` and `exit`** — **resolved, safe.** `exit N` inside a Runspace does not kill the host process. PowerShell converts it to a terminating `ExitException`; `$ps.Invoke()` surfaces `HadErrors=True` but returns normally. The try/catch wrapper captures `$LASTEXITCODE` correctly.

3. **Runspace startup cost** — **resolved.** Measured: Create+Open+Close avg **5.4ms** (min 3ms, max 15ms); full Create+Open+AddScript+Invoke+Dispose avg **6.6ms** (min 3.5ms, max 19ms). Spec estimate of 5–20ms confirmed accurate.

4. **`Add-Type -TypeDefinition` detection signal** — **resolved, spec corrected.** `IsDynamic` is always `false` on .NET 5+. The correct signal is `Location -eq '' -and -not IsDynamic`: compiled assemblies have an empty `Location` (no backing file); pre-compiled assemblies always have a non-empty path. Detection mechanism updated throughout this spec.

5. **`Set-PSBreakpoint` inside a Runspace** — **resolved.** Breakpoints registered without `-Runspace` fire in the current runspace. `$hits` populates correctly via `.GetNewClosure()`. All expected lines hit. No bleed-over between steps (each Runspace's breakpoints are scoped to that Runspace; `Get-PSBreakpoint | Remove-PSBreakpoint` at end of wrapper cleans up).
