# Spike results: pwsh persistent session

Companion to `shell-pwsh-session.md`. Records empirical findings from spikes run before implementation.

Environment: pwsh 7.6.2, macOS (Apple Silicon).

---

## Spike 1 — `*>` and `Set-PSDebug -Trace 2` stream capture

**Question:** Do `Set-PSDebug -Trace 2` DEBUG: lines appear in the stdout file when using `*> $stdoutPath` inside the host script?

**Result: No.**

`Set-PSDebug -Trace 2` does not write to any PowerShell output stream (1–6). It writes directly through the PowerShell ConsoleHost to fd 1 (the process's raw stdout). The `*>` redirect only captures PS streams, so it has no effect on Set-PSDebug traces.

Observed in the spike:

- The stdout **file** (`*> $stdoutPath`) contained only clean user output (`Write-Output`, etc.).
- DEBUG: trace lines appeared on the **host process's stdout** — the same channel the session protocol uses for exit-code replies.

**Implication for the spec:** The spec's claim "the two channels never mix" is wrong when coverage is enabled. DEBUG: trace lines from the user script contaminate the protocol channel (host stdout), making it impossible to naively read one line and parse it as an integer exit code.

The current coverage parser (`parsePwshCoverage`) reads `raw.stdout` for `DEBUG:\s+(\d+)\+` patterns. In the session model, those traces are on the host's stdout pipe, not in the stdout file.

**Resolution — sentinel protocol (see Spike 1c):**
Node reads host stdout lines until the sentinel `__ACTHARNESS_DONE__<N>`, collecting `DEBUG:` lines along the way. `Console.SetOut` was tested (Spike 1b) and rejected (Spike 1c — crashes on second step).

See Spike 1b for the initial `Console.SetOut` attempt and Spike 1c for why it was rejected.

---

## Spike 1b — `Console.SetOut` captures Set-PSDebug traces

**Question:** Does `[Console]::SetOut(writer)` in the host script redirect `Set-PSDebug -Trace 2` traces to the writer, preventing them from reaching the protocol channel?

**Result: Yes — confirmed.**

Protocol channel (host stdout) received only the clean integer reply `0`. The debug file captured all `DEBUG:` trace lines from the user script. User stdout file was clean.

**Issue found:** the initial design appended `Set-PSDebug -Off` to the user script file to stop tracing before the host's post-dot-source code ran. This approach fails when a user script calls `exit` mid-run — the dot-source scope exits immediately and the appended line never executes, leaving tracing on when the host continues.

---

## Spike 1c — `Console.SetOut` rejected; sentinel approach confirmed

**Question:** Does `Console.SetOut` + host-script `Set-PSDebug -Off` work correctly across multiple steps?

**Result: `Console.SetOut` is broken for multi-step loops — rejected.**

`[Console]::SetOut()` called inside a `while` loop causes the host to crash during the dot-source on the second step, regardless of script content or whether `exit` was called. The `*>` redirect on its own works fine across multiple steps.

**Resolution — sentinel-based protocol (confirmed working):**

- No `Console.SetOut` at all.
- `Set-PSDebug -Trace 2` traces go to host stdout naturally (they always bypass `*>` and write to fd 1).
- After the dot-source, host calls `Set-PSDebug -Off` (its own trace appears on host stdout, then tracing stops).
- Host writes `__ACTHARNESS_DONE__<code>` as the step sentinel.
- Node reads host stdout lines until the sentinel, collecting `DEBUG:` lines for coverage.

**Spiked with three steps (normal-coverage, exit-42-coverage, plain):**

- All three steps completed; host survived `exit 42`; correct exit codes (0, 42, 0).
- Stdout files clean (no DEBUG: lines).
- Coverage hits correct for executed user lines.
- One known false hit per coverage step at user line ~14 (from the host's `Set-PSDebug -Off` trace at host script line ~15). Harmless for scripts shorter than 14 lines; documented and accepted for longer scripts.

---

## Spike 2 — Env replacement cost

**Question:** Is clearing and resetting the entire process env on every step too slow for large envs?

**Result: Acceptable.**

Measured: 5 steps, 200 env vars each, total 492ms (~98ms per step). This includes step execution time, not just env replacement. For typical action env sizes (30–50 vars), env replacement cost will be well under 20ms per step — negligible compared to the 500ms startup cost being amortized.

---

## Spike 3 — `exit` behavior in dot-sourced scripts

### Finding A: `exit N` does NOT kill the host process

**Question:** When a user script calls `exit N`, does the pwsh host process die?

**Result: No — the session survives.**

The spec assumed `exit N` would terminate the host unconditionally. This is true when pwsh runs a script directly (`pwsh -File script.ps1`), but NOT when the script is dot-sourced (`. script.ps1`). In the dot-source case, `exit N` returns to the calling scope with `$LASTEXITCODE = N`. The host script then captures that code, writes the reply, and continues the loop.

Verified: sending two messages in sequence — step 1 calls `exit 42`, step 2 runs normally — both steps complete, host exits cleanly after stdin closes.

**Implication:** The entire "exit kills session / session restart on exit" section of the spec is unnecessary. The session survives user `exit` automatically. This simplifies the implementation significantly: no `invalidate()` path needed for the `exit` case, no restart logic, no `isAlive()` check after `run()`.

### Finding B: `$LASTEXITCODE` leaks between steps

**Question:** Does `$LASTEXITCODE` from one step affect the next?

**Result: Yes — must reset before each step.**

If step 1 sets `$LASTEXITCODE = 42` (via `exit 42` or an external process) and step 2 runs only PS cmdlets (no external processes), `$LASTEXITCODE` remains 42 when the host captures it for step 2. Step 2's exit code would be incorrectly reported as 42.

**Fix:** Add `$global:LASTEXITCODE = 0` at the top of each step's handling block in the host script, before the dot-source. Confirmed working: step 1 reports 42, step 2 reports 0.

---

## Spike 4 — `Set-PSBreakpoint` as coverage mechanism

**Question:** Can `Set-PSBreakpoint` replace `Set-PSDebug -Trace 2` for coverage in the session model? Three unknowns: scoping of the action scriptblock, behavior on blank/comment lines, performance overhead.

**Finding A — scoping:** `$script:` does not reach the loop-body scope from inside a breakpoint action. Must use `$global:coverageHits`. Also requires `.GetNewClosure()` on each iteration's action scriptblock to capture the correct `$ln` per line (without it, all actions capture the last value of `$ln`). Both fixes confirmed working.

**Finding B — blank and comment lines:** `Set-PSBreakpoint` auto-promotes breakpoints on non-executable lines (blank lines, comments) to the next executable line and fires both. Non-executable lines appear as "covered" in the output. This matches raw V8 coverage behavior: blank and comment lines within executed code appear as covered. Spiked with Node `NODE_V8_COVERAGE` — V8 marks all lines in covered source ranges as covered, including blanks and comments. Behavior is consistent; no special handling needed.

**Finding C — performance:** ~18ms overhead per step for a 50-line script (50 breakpoints). Baseline without coverage: ~49ms/step. Acceptable relative to the 500ms startup cost being amortized.

**Correctness confirmed:**

- All executed lines hit correctly; unexecuted lines absent from output.
- `exit 42` mid-script: only lines that ran appear in coverage (`{"1":1,"2":1}` for a 3-line script exiting on line 2).
- Multiple steps: all correct, no leakage between steps.
- No DEBUG: lines on host stdout.
- No false hits from host script.
- Clean stdout and stderr files.

**Rejected alternative:** Sentinel protocol collecting `DEBUG:` lines from `Set-PSDebug -Trace 2` — produces an unfixable false hit at user line ~14 from the host's `Set-PSDebug -Off` trace (PowerShell traces before execution; there is no way to turn off tracing without that turnoff itself being traced). `Set-PSBreakpoint` eliminates this class of problem entirely.

---

## Revised spec implications

| Spec assumption | Reality | Impact |
| --- | --- | --- |
| `exit` kills the session; Node detects premature close | `exit N` in dot-sourced script does NOT kill host | Premature-close path retained only as defensive fallback for host crashes |
| "The two channels never mix" | DEBUG: traces appear on host stdout when coverage enabled | Resolved via sentinel protocol — Node reads until sentinel, collecting DEBUG: lines |
| Coverage: parse DEBUG: from `stdoutPath` | DEBUG: traces are on host stdout, not in stdout file | `session.run()` returns collected DEBUG: lines; `parsePwshCoverage` called on those |
| `$LASTEXITCODE` is clean per step | Leaks between steps | Reset `$global:LASTEXITCODE = 0` before each dot-source |

---

## Final host script design

```powershell
while ($true) {
    $line = [Console]::ReadLine()
    if ($null -eq $line) { break }

    $msg = $line | ConvertFrom-Json

    $keysToRemove = [System.Environment]::GetEnvironmentVariables().Keys | ForEach-Object { $_ }
    foreach ($k in $keysToRemove) { [System.Environment]::SetEnvironmentVariable($k, $null) }
    foreach ($entry in $msg.env.PSObject.Properties) {
        [System.Environment]::SetEnvironmentVariable($entry.Name, $entry.Value)
    }

    Set-Location $msg.cwd
    $global:LASTEXITCODE = 0
    $global:coverageHits = [System.Collections.Generic.Dictionary[string,int]]::new()
    $bps = @()

    if ($msg.coverage) {
        $lineCount = (Get-Content $msg.scriptPath).Length
        $bps = 1..$lineCount | ForEach-Object {
            $ln = "$_"
            $action = { $global:coverageHits[$ln]++ }.GetNewClosure()
            Set-PSBreakpoint -Script $msg.scriptPath -Line ([int]$ln) -Action $action -ErrorAction SilentlyContinue
        } | Where-Object { $_ -ne $null }
    }

    . "$($msg.scriptPath)" *> $msg.stdoutPath 2> $msg.stderrPath

    if ($bps.Count -gt 0) { $bps | Remove-PSBreakpoint }

    $code = $LASTEXITCODE
    $coverageJson = if ($msg.coverage -and $global:coverageHits.Count -gt 0) {
        $global:coverageHits | ConvertTo-Json -Compress -Depth 1
    } else { '{}' }
    [Console]::WriteLine("__ACTHARNESS_DONE__$code $coverageJson")
}
```

Node side: read one line from host stdout; split on first space to get exit code and coverage JSON.

When coverage enabled: `JSON.parse(coverageJson)` gives `Record<string, number>` — convert string keys to integers for `shellCoverage.lineHits`. `parsePwshCoverage` is not used in the session path.
