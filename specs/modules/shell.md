# `@actharness/shell`

The `ShellSandbox` — spawns a real shell process for a `run:`/`shell:` step's script and captures its result. Originally built inside `@actharness/composite` (v0.1); split into its own package so `@actharness/workflow` (v0.4) can reuse it for workflow job `run:` steps without a breaking dependency move later — `run:`/`shell:` semantics are identical in both contexts on the real runner.

## Owns
- `ShellSandbox`, a `SandboxFactory` shell provider (`@actharness/core`'s `SandboxFactory`/`ShellSandboxOptions`/`ShellSandboxResult` types).

Callers get back `{ exitCode, stdout, stderr, timedOut, shellCoverage? }`. The `shellCoverage` field carries `{ lineHits: Record<number, number> }` when coverage is enabled for sh/bash — **line coverage only**; branch, statement, and function coverage is not yet solved.

## Depends on
`@actharness/core` (for the `SandboxFactory`/`ShellSandboxOptions`/`ShellSandboxResult` type contracts only — no behavioral dependency) and `@actharness/types`. No others.

## Behavior (MUST)

1. **Shell resolution.** Map the declared `shell:` string to a real binary + argv, matching the real runner's wrapper per shell:
   - `bash` → `bash --noprofile --norc -eo pipefail <script>`
   - `sh` → `sh -e <script>`
   - `pwsh` / `powershell` → `pwsh -NonInteractive -command ". '<script>'"`
   - `cmd` → `cmd /D /E:ON /V:OFF /S /C "CALL "<script>""` (with a `.cmd` script extension) — only meaningfully testable on Windows; on this repo's (non-Windows) dev/CI machines the argv-building is verified via a mocked `child_process.spawn`, not a real `cmd.exe` invocation (see Acceptance below)
   - `python` / `python3` → `python3 <script>` (with a `.py` script extension)
   - `node` → `node <script>` (with a `.js` script extension)
   - Custom shell containing `{0}` → expand `{0}` to the script path (e.g. `bash {0}`)
   - Anything else → used as-is, script path appended as the final arg
2. **Script file.** Write `opts.script` to a fresh temp file (`mode 0o700`) in a per-invocation temp dir; clean up the temp dir once the process exits.
3. **Process spawn.** `cwd: opts.cwd`; env is the caller-provided `opts.env` merged onto the *inherited* `process.env` (not a replacement) — callers that want strict scoping build that allowlist themselves before calling in (composite's step-runner does this).
4. **stdout/stderr capture.** UTF-8 streamed and accumulated for the full result.
5. **Timeout.** If `opts.timeout` is set and exceeded, send `SIGTERM`; if the process hasn't exited within 2s, escalate to `SIGKILL`. Report `timedOut: true` and `exitCode: 124` (matching the conventional shell timeout exit code) regardless of what the process actually returned.
6. **Exit code.** `code ?? 1` when the process exits abnormally (e.g. killed by signal, `code` is `null`) and it wasn't a timeout.

## Acceptance
Fixtures under `packages/shell/test/`:
- **shell type mapping** — `bash`, `sh`, `python3`, `node`, custom `{0}` shells, and an unrecognized shell name (used as-is) all spawn the right binary/argv and return real output (`unit.test.ts`).
- **pwsh / powershell / python / cmd** (not assumed available on every dev machine — `cmd` specifically is Windows-only) — covered via mocked `child_process.spawn` rather than real processes (`mock-shells.test.ts`).
- **timeout** — a script that ignores `SIGTERM` is escalated to `SIGKILL`; a script that exits cleanly on `SIGTERM` reports `timedOut: true, exitCode: 124` either way.
- **signal exit** — `code === null` (process died by signal, not timeout) falls back to `exitCode: 1`.
- **stderr capture** — a script writing to stderr has it captured separately from stdout.

## Done-when
All acceptance scenarios green at 100% coverage; package has zero behavioral dependencies beyond `@actharness/core`'s type contracts; `@actharness/composite` consumes it without re-implementing any shell-mapping logic; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
