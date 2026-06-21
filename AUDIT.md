# actharness — Documentation Audit

Cross-reference of the codebase against README.md, docs/ARCHITECTURE.md, docs/API.md, docs/ROADMAP.md, and docs/DECISIONS.md. Three categories: **Discrepancies** (code does X; doc claims Y), **Undocumented Decisions** (code does X; no doc explains why), **Unknown Limitations** (user would hit this but can't learn it from the docs).

---

## Summary (ordered by priority to fix)

| ID | Category | Severity | Title |
|----|----------|----------|-------|
| [D1](#d1--architecturemd-mis-describes-pwsh-tls-handling) | Discrepancy | ✅ Fixed | pwsh TLS — "instead of CA cert injection" is wrong in both directions |
| [U1](#u1--persistent-pwsh-sessions-never-get-skipcertificatecheck) | Undocumented | ✅ Fixed | Persistent pwsh never gets SkipCertificateCheck |
| [L1](#l1--invoke-webrequestrestmethod-cant-intercept-https-in-composite-pwsh) | Limitation | ✅ Fixed | Invoke-WebRequest/RestMethod can't intercept HTTPS in composite pwsh steps |
| [D2](#d2--architecturemd-says-pwsh-coverage-uses-set-psbreakpoint--only-half-true) | Discrepancy | ✅ Fixed | pwsh coverage mechanism differs by path (PSDebug vs PSBreakpoint) |
| [U5](#u5--network-mock-registry-is-per-module-not-per-actharnesshandle) | Undocumented | ✅ Fixed | Network mocks are per-module, not per handle |
| [L3](#l3--pwsh-global-state-persists-across-steps-within-a-composite-run) | Limitation | ✅ Fixed | pwsh `$global:` state persists between composite steps (in ROADMAP, not in README/API) |
| [L4](#l4--network-mocks-leak-between-handles-action-mocks-dont) | Limitation | ✅ Fixed | Network mocks leak between handles; action mocks don't |
| [D4](#d4--python-coverage-auto-provisions-a-venv-and-needs-internet-docs-say-only-managed-venv) | Discrepancy | Medium | Python venv auto-provisions (needs internet); fallback warning message is wrong |
| [L2](#l2--python-coverage-fails-silently-on-air-gapped-ci) | Limitation | Medium | Python coverage fails silently on air-gapped CI; "binary not found" misreports cause |
| [D3](#d3--shell-powershell-is-accepted-but-never-documented) | Discrepancy | ✅ Fixed | `shell: powershell` alias is accepted but not documented anywhere |
| [U2](#u2--abnormal-pwsh-host-exit-injects-pwsh-host-error-into-step-stderr) | Undocumented | Low | `[pwsh host error]` prefix injected into step stderr on host crash |
| [U3](#u3--set-psdebug--trace-2-strips-debug-lines-from-returned-stdout-not-from-in-flight-output) | Undocumented | ✅ Fixed | Set-PSDebug strips DEBUG from returned stdout but not from in-flight execution |
| [U4](#u4--python-venv-lives-inside-the-installed-package-directory) | Undocumented | Low | Python venv lives inside node_modules |
| [U6](#u6--pwshsessionkill-schedules-an-uncancellable-sigkill-2-seconds-after-sigterm) | Undocumented | ✅ Fixed | kill() schedules uncancellable SIGKILL 2 seconds after SIGTERM |
| [L5](#l5--githubworkflow_ref-is-a-synthetic-fixed-string-not-in-user-facing-docs) | Limitation | ✅ Fixed | `github.workflow_ref` is a synthetic fixed string; doc fix needed in README/API.md; derivation tracked in [v0.4 spec](../specs/versions/v0.4.md) |
| [L6](#l6--empty-string-output-from-literal-value-counts-as-not-produced-in-coverage) | Limitation | Low | Empty-string output from literal `value: ""` counts as not produced in coverage |

---

## 1 — Discrepancies

### D1 — ARCHITECTURE.md mis-describes pwsh TLS handling

**Docs:** [docs/ARCHITECTURE.md:176](docs/ARCHITECTURE.md#L176)
**Code:** [packages/shell/src/shell-scope.ts:30-46](packages/shell/src/shell-scope.ts#L30-L46), [packages/shell/src/shell-sandbox.ts:152-155](packages/shell/src/shell-sandbox.ts#L152-L155) and [206-215](packages/shell/src/shell-sandbox.ts#L206-L215)

**What the doc says:**
> "TLS validation is disabled via `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` prefix prepended to the script **instead of** CA cert injection."

**What the code did (at audit time) — two different paths:**

- **Non-persistent pwsh** (standalone `shell: pwsh` step, no `runId`, now deleted): both `getProxyEnv()` and `getPwshPrefix()` were applied.
- **Persistent pwsh** (pwsh steps inside a composite action, `runId` is set): `getProxyEnv()` was called but `getPwshPrefix()` was **never called**. Persistent sessions received only the CA-cert env vars with no SkipCertificateCheck prefix.

**Why it mattered:** PowerShell's `Invoke-WebRequest` / `Invoke-RestMethod` use .NET's `HttpClient`, which reads from the OS/system certificate store — not from `SSL_CERT_FILE`. So for composite pwsh steps (the persistent path), the proxy's self-signed cert was never trusted and HTTPS network mocks would fail with a TLS error.

**Fix:** `getPwshPrefix()` is now called in the persistent path before writing the script file, and ARCHITECTURE.md updated to reflect that both CA cert env vars and SkipCertificateCheck are applied.

---

### D2 — ARCHITECTURE.md says pwsh coverage uses `Set-PSBreakpoint` — only half true

**✅ Fixed** — non-persistent pwsh path deleted. `Set-PSBreakpoint` (via `pwsh-host.ps1`) is now the only coverage mechanism.

**Docs:** [docs/ARCHITECTURE.md:207](docs/ARCHITECTURE.md#L207)
**Code:** [packages/shell/src/pwsh-host.ps1:23](packages/shell/src/pwsh-host.ps1#L23)

**What the doc says:**
> "Lines via `Set-PSBreakpoint` per line; line-only"

**What the code did — two different mechanisms (at audit time):**

- **Persistent sessions** (composite action, `runId` present): `pwsh-host.ps1` line 23 uses `Set-PSBreakpoint -Script ... -Line ... -Action`. Matched the doc.
- **Non-persistent sessions** (standalone `shell: pwsh`, no `runId`): `shell-sandbox.ts` prepended `Set-PSDebug -Trace 2`. After the process exited, `DEBUG:` lines were parsed from stdout for line hits and then stripped from the returned stdout.

**Fix:** Confirmed via the workflow spike (`spike/workflow/src/workflow.ts:228`) that `WorkflowRunner` will wrap job steps as synthetic composite actions — meaning `CompositeExecutor` always generates a `runId`, and the non-persistent path is permanently unreachable. The non-persistent path and its `pwsh-coverage-runner.ps1` wrapper were deleted. `Set-PSBreakpoint` (persistent path) is now the only pwsh coverage mechanism.

---

### D3 — `shell: powershell` is accepted but never documented

**Code:** [packages/shell/src/shell-sandbox.ts:105](packages/shell/src/shell-sandbox.ts#L105), [108](packages/shell/src/shell-sandbox.ts#L108)

Both `'pwsh'` and `'powershell'` are accepted as `shell:` values and treated identically throughout the codebase (`isPwsh`, `pwshCoverageEnabled`, coverage header, session pool). No doc — not README.md, API.md, or ARCHITECTURE.md — mentions `shell: powershell` as an accepted value.

**Why it matters:** Low severity, but a user migrating a real workflow that uses `shell: powershell` (the legacy Windows spelling) has no way to know whether actharness accepts it.

---

### D4 — Python coverage auto-provisions a venv (and needs internet); docs say only "managed venv"

**Docs:** [docs/ARCHITECTURE.md:208](docs/ARCHITECTURE.md#L208)
**Code:** [packages/shell/src/python-venv.ts:19-36](packages/shell/src/python-venv.ts#L19-L36), [packages/shell/src/shell-sandbox.ts:232-238](packages/shell/src/shell-sandbox.ts#L232-L238), [269-270](packages/shell/src/shell-sandbox.ts#L269-L270)

**What the doc says:**
> "Via `coverage.py` inside a managed venv"

**What the code actually does:**
1. Checks for `<packageDir>/.venv-<bin>/bin/python`
2. If absent: runs `python -m venv <packageDir>/.venv-<bin>` then `pip install coverage --quiet`
3. Caches the resolved path in a module-level `Map`

The phrase "managed venv" implies the venv is pre-existing or externally configured. Instead it is auto-provisioned on first use. If `resolveVenvPython()` throws for any reason (Python not installed, no internet, pip failure, permission error), the exception is caught silently, `warnNoVenv` is set, and the step appends `::warning::python coverage skipped — binary not found\n` to stdout. The warning says "binary not found" regardless of the actual root cause.

**Why it matters:** See [L2](#l2--python-coverage-fails-silently-on-air-gapped-ci) for the user-facing impact.

---

## 2 — Undocumented Decisions

### U1 — Persistent pwsh sessions never get SkipCertificateCheck

**Code:** [packages/shell/src/shell-sandbox.ts:140-198](packages/shell/src/shell-sandbox.ts#L140-L198)

The persistent pwsh execution path (triggered when `opts.runId !== undefined`) calls `scope.getProxyEnv(ca.certPath)` to inject CA cert env vars into the environment, but never calls `scope.getPwshPrefix()`. There is no `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` anywhere in that path.

No documentation distinguishes the persistent path (composite) from the non-persistent path (standalone) with respect to TLS handling. A user reading ARCHITECTURE.md would assume SkipCertificateCheck is applied to all pwsh steps. See [D1](#d1--architecturemd-mis-describes-pwsh-tls-handling) and [L1](#l1--invoke-webrequestrestmethod-cant-intercept-https-in-composite-pwsh).

---

### U2 — Abnormal pwsh host exit injects `[pwsh host error]` into step stderr

**Code:** [packages/shell/src/shell-sandbox.ts:178](packages/shell/src/shell-sandbox.ts#L178)

```ts
const stderrParts = [scriptStderr, stepResult.hostError ? `[pwsh host error] ${stepResult.hostError.trim()}` : ''].filter(Boolean);
```

When a persistent pwsh host process closes without producing the expected output line (e.g., the host script panics), `stepResult.hostError` is populated with the host's accumulated stderr. This string is prefixed with `[pwsh host error]` and concatenated into the step's returned `stderr`.

No documentation mentions this prefix. Tests asserting on `result.steps[n].stderr` will see it unexpectedly on host crashes, and the prefix itself gives no guidance on how to distinguish it from script-produced stderr.

---

### U3 — `Set-PSDebug -Trace 2` strips DEBUG lines from returned stdout, not from in-flight output

**✅ Fixed** — non-persistent pwsh path (which used `Set-PSDebug -Trace 2`) was deleted. This behaviour no longer exists.

The non-persistent pwsh coverage path prepended `Set-PSDebug -Trace 2`, which emitted `DEBUG: <line>` lines to stdout during execution, then stripped them from the returned `stdout` after the process exited. The in-flight output was not clean. The path was unreachable from any real actharness call and has been removed.

---

### U4 — Python venv lives inside the installed package directory

**Code:** [packages/shell/src/python-venv.ts:9](packages/shell/src/python-venv.ts#L9), [23](packages/shell/src/python-venv.ts#L23)

```ts
const pkgDir = fileURLToPath(new URL('..', import.meta.url));
const venvDir = join(pkgDir, `.venv-${bin}`);
```

The venv is created at `node_modules/@actharness/shell/.venv-python` (or `.venv-python3`). Consequences:
- Wiped and recreated on `npm ci` / `pnpm install --frozen-lockfile`
- Included in `node_modules` CI cache (carries pip-installed packages)
- Cannot be pre-warmed by the user at a project-controlled path
- No cleanup mechanism; grows if multiple Python binaries are used

No documentation of where the venv lives or how to manage it.

---

### U5 — Network mock registry is per-module, not per `actharness()` handle

**✅ Fixed** — network mocks now store entries in the current ALS scope (same mechanism as action mocks). `drainForProxy()`/`drainForNode()` walk the scope stack innermost-first. ARCHITECTURE.md updated to reflect the unified invariant.

**Code:** [packages/network-mock/src/registry.ts](packages/network-mock/src/registry.ts)
**Docs:** [docs/ARCHITECTURE.md:217](docs/ARCHITECTURE.md#L217)

ARCHITECTURE.md said: *"each `Action` handle owns a **per-instance mock registry** (never a global)"*

This was accurate for **action mocks** (`actharness.mock(...)`), which used a per-instance `MockScope` with a private `Map`. It was **not accurate for network mocks** (`mockGitHubApi(...)`, `mockNetwork(...)`), which pushed to module-level arrays. All `actharness()` handles in the same test file shared the same pending network mock arrays.

**Fix:** `mockGitHubApi`/`mockNetwork`/`*Once` now call `currentScope()` and store entries in a `WeakMap<ScopeRegistry, { apiEntries, networkEntries }>`. `drainForProxy()`/`drainForNode()` call `currentStack()` and merge entries innermost-first, giving inner-scope registrations priority over outer-scope ones — matching the action mock "inner overrides outer" model exactly.

---

### U6 — `PwshSession.kill()` schedules an uncancellable SIGKILL 2 seconds after SIGTERM

**Code:** [packages/shell/src/pwsh-session.ts:76-80](packages/shell/src/pwsh-session.ts#L76-L80)

```ts
kill(): void {
  this.alive = false;
  this.proc!.kill('SIGTERM');
  const p = this.proc!;
  setTimeout(() => p.kill('SIGKILL'), 2_000);
}
```

The `setTimeout` handle is never stored or cleared. If the host process exits cleanly within 2 seconds of receiving SIGTERM (the normal case), the SIGKILL fires into a closed process handle — harmless. But if a test framework's timeout fires `kill()` and the test runner immediately moves on, there is a deferred SIGKILL scheduled to fire 2 seconds after the test completes. Under high PID reuse on constrained systems (very unlikely), that SIGKILL could hit a new process.

---

## 3 — Unknown Limitations

### L1 — `Invoke-WebRequest`/`Invoke-RestMethod` can't intercept HTTPS in composite pwsh steps

This is the user-facing consequence of [D1](#d1--architecturemd-mis-describes-pwsh-tls-handling) and [U1](#u1--persistent-pwsh-sessions-never-get-skipcertificatecheck).

Composite actions that contain multiple `shell: pwsh` steps use the persistent session path. That path injects CA-cert env vars (`SSL_CERT_FILE`, `CURL_CA_BUNDLE`, etc.) but does not prepend `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true`. PowerShell's web cmdlets use .NET's `HttpClient`, which reads from the OS/system certificate store and ignores `SSL_CERT_FILE`. The proxy's self-signed CA cert is therefore never trusted, and any `Invoke-WebRequest` or `Invoke-RestMethod` call to an HTTPS target will throw a TLS certificate validation error.

**Practical impact:** a user who registers `mockGitHubApi()` and then runs a composite action whose pwsh steps call the GitHub API via PowerShell web cmdlets will see the mock never fire and the step fail with a TLS error. The same setup works if the step uses `curl` (which respects `CURL_CA_BUNDLE`).

**Undocumented workaround:** use `curl` in pwsh scripts rather than PowerShell web cmdlets when network mocks are active in composite actions.

---

### L2 — Python coverage fails silently on air-gapped CI; "binary not found" misreports the cause

**Code:** [packages/shell/src/shell-sandbox.ts:232-238](packages/shell/src/shell-sandbox.ts#L232-L238), [269-270](packages/shell/src/shell-sandbox.ts#L269-L270)

On a CI runner without PyPI access, the first test run that triggers Python coverage will call `pip install coverage`, which fails. The exception is caught silently (line 236), `warnNoVenv` is set, and after the step completes, `::warning::python coverage skipped — binary not found\n` is appended to stdout.

Problems:
- "binary not found" does not describe a pip network failure or a venv permission error
- The warning appears in stdout, mixed with the step's actual output, not in a structured warning position
- The test suite passes; coverage for all Python steps shows zero with no other indication

The venv is created once and cached in the module-level `Map`, so subsequent test runs in the same process succeed if the first run succeeded. But on fresh CI workers (a new `npm ci` wipes `node_modules`), every first run re-triggers the pip install.

---

### L3 — pwsh `$global:` state persists across steps within a composite run

**✅ Fixed** — implemented in `pwsh-host.ps1` via Runspace-per-step + rolling sessions on `Add-Type` detection.

Each step now runs in a fresh `[System.Management.Automation.Runspaces.Runspace]`, created and disposed within the host loop. `$global:` variables, defined functions, loaded modules, and `$PSDefaultParameterValues` are all Runspace-local and do not survive to the next step. When a step calls `Add-Type -TypeDefinition` (detected via assembly count delta on `Location -eq '' -and -not $_.IsDynamic`), the session process is rolled — the next step's Runspace is in a fresh process, clearing even in-memory compiled types.

**Known residual gap — static .NET state on pre-compiled DLLs:** mutation of static fields on types loaded from DLLs (`[SomeDll.Class]::_field = 1`) persists at the AppDomain level across Runspaces in the same process. This is not detectable without intercepting .NET reflection at the JIT/CLR level. Opt-in `pwshIsolation: 'process'` (fresh process per step) fully isolates this at the cost of ~500ms per step.

**Verified by:** `fixtures/pwsh-global-isolation/` — sets `$global:MyState` in step 1, asserts step 2 sees empty string.

---

### L4 — Network mocks leak between handles; action mocks don't

**✅ Fixed** — resolved by the same change as [U5](#u5--network-mock-registry-is-per-module-not-per-actharnesshandle). Network mocks registered inside a test body now live in the test-scope ALS entry and are discarded when the test scope exits, exactly like action mocks.

This was the user-facing consequence of [U5](#u5--network-mock-registry-is-per-module-not-per-actharnesshandle).

If a test file created two `actharness()` handles and called `mockGitHubApi()` for one scenario, those mocks remained in the module-level pending arrays when the second handle's `run()` executed — unless `resetNetworkMocks()` was called between them. By contrast, `actharness.mock('actions/checkout@v4', ...)` was scoped to the specific handle and did not leak.

---

### L5 — `github.workflow_ref` is a synthetic fixed string; not in user-facing docs

**Code:** [packages/types/src/index.ts:174](packages/types/src/index.ts#L174) — default: `'owner/repo/.github/workflows/ci.yml@refs/heads/main'`
**Documented in:** [docs/DECISIONS.md:394](docs/DECISIONS.md#L394) (mentions it follows from the synthetic `github.repository`).
**Not documented in:** README.md or API.md.

An action that branches on `${{ github.workflow_ref }}` will always see the synthetic default in tests unless the caller explicitly overrides the `github` context. Users are unlikely to look in DECISIONS.md for this; it belongs in the API reference alongside other synthetic context fields.

`workflow_ref` is only meaningful when a real workflow file is present — the value is the path to the workflow that triggered the run. For direct action tests (`actharness('./action.yml')`), no workflow file exists so a fixed synthetic string is the only option. Proper derivation (computing `owner/repo/.github/workflows/my.yml@refs/heads/main` from the workflow file path and context defaults) can only be done in `actharnessWorkflow()`, which is a **v0.4** feature. Doc fix (noting the field is synthetic and overridable) is the correct action now; derivation is tracked in [specs/versions/v0.4.md](../specs/versions/v0.4.md) under "The genuinely new parts".

---

### L6 — Empty-string output from literal `value: ""` counts as not produced in coverage

**Code:** [packages/coverage/src/collector.ts:130-139](packages/coverage/src/collector.ts#L130-L139)

Output coverage uses two different detection strategies depending on how the output's `value:` expression is written:

- **Step-sourced expression** (`${{ steps.<id>.outputs.<key> }}`): presence check — `outputKey in stepResult.outputs`. An empty string from the step is counted as produced.
- **All other expressions** (literals, other `${{}}` expressions, or no `value:` at all): truthiness check — `!!result.outputs[name]`. An empty string is falsy and is counted as **not produced**.

An action that intentionally produces an empty-string output via `value: ""` or via an expression that evaluates to `""` will report 0% output coverage even when the test exercises that output path. No documentation explains this asymmetry.
