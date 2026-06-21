<div align="center">
  <img src="icon.png" width="96" alt="actharness">
  <h1><code>@actharness/shell</code></h1>
  <p>Shell sandbox for actharness.</p>
  <a href="https://www.npmjs.com/package/@actharness/shell"><img src="https://img.shields.io/npm/v/@actharness/shell?color=3fb950&label=npm" alt="npm"></a>
  <a href="https://github.com/actharness/actharness/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fb950" alt="license"></a>
</div>

<br>

Shell execution sandbox for [actharness](https://github.com/theobassan/actharness). Spawns `run:` steps in isolated subprocesses with faithful shell wrappers, scoped env, and optional network interception.

Used internally by `@actharness/composite` — not typically imported directly.

## Shells supported

| `shell:` | Invocation |
|---|---|
| `bash` (default) | `bash --noprofile --norc -eo pipefail` |
| `sh` | `sh -e` |
| `pwsh` / `powershell` | `pwsh -NonInteractive -command` |
| `python` / `python3` | `python3 <script>` |
| `node` | `node <script>` |
| custom | `{0}` placeholder expansion |

## Network mocking

When `mockNetwork` or `mockGitHubApi` mocks are registered before a shell step runs, the sandbox starts an in-process HTTPS CONNECT proxy and injects proxy env vars into the subprocess:

| Env var | Covers |
|---|---|
| `HTTP_PROXY` / `HTTPS_PROXY` | all HTTP clients |
| `CURL_CA_BUNDLE` | curl |
| `SSL_CERT_FILE` | OpenSSL-linked tools |
| `NODE_EXTRA_CA_CERTS` | `shell: node` steps |
| `REQUESTS_CA_BUNDLE` | Python `requests`, `httpx` |

For `shell: pwsh`, `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` is prepended automatically.

No proxy is started when no mocks are registered — zero overhead for steps that don't need network interception.

## Contents

- `ShellSandbox` — main sandbox class; `shell()` method runs one step
- `ShellSandboxResult` — `{ exitCode, stdout, stderr, timedOut, shellCoverage? }`
