# `@actharness/network-mock`

The central network mocking package for all shell types. Owns both the **Node bootstrap mock layer** (currently in `packages/node`) and the **proxy-based mock layer** for bash / sh / python / pwsh. Exposes a single `mockNetwork` / `mockGitHubApi` API surface shared across all executors, with the same per-call precision: full `.calls` inspection, request headers, request body, and per-call response factories.

## Context

`@actharness/network-mock` centralises network interception across all executor types:

- **Node path** (`runs.using: node<N>`): fork + IPC + undici MockAgent + MSW interceptors. The Node bootstrap runs in a child process; `packages/node` delegates to this package. Function matchers are unsupported over IPC — rejected at drain time with a clear error.
- **Proxy path** (all shell steps — bash, sh, python, pwsh, `shell: node`, and any custom shell): a local HTTP/HTTPS CONNECT-capable MITM proxy running in-process (Node.js `http.Server`). Function matchers work natively.

The key distinction: the proxy path covers **all subprocess shell steps**, including `shell: node`. The Node executor path covers only `runs.using: node<N>` actions (matched by `/^node\d+$/`).

Both paths share the same pending mock registry, the same `NetworkMock` handle interface, and the same `mockNetwork` / `mockGitHubApi` API.

## Owns

- **Shared mock registry** — the pending queue that `mockNetwork` / `mockGitHubApi` push into; drained differently by each path
- **Node mock layer** — `JsSandboxNetworkScope`: drain → serialize → send via IPC → receive `apiHit` / `networkHit` messages back (moved from `packages/node`)
- **Node bootstrap fragment** — the network interception block of `sandbox-bootstrap.mjs` (undici MockAgent + MSW interceptors); moved here, imported by the bootstrap in `packages/node`
- **ProxyMockServer** — local HTTP/HTTPS server with CONNECT-tunnel MITM, URL matcher engine, and hit recording
- **CA cert generation** — per-session self-signed CA keypair (cert PEM + key PEM in temp files)
- **ShellNetworkScope** — drains pending mocks into the proxy before a shell step; records hits after
- **Per-shell env var bundles** (`HTTP_PROXY`, `HTTPS_PROXY`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`)
- **PowerShell wrapper injection** — prepends `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` to pwsh scripts
- `mockNetwork` / `mockGitHubApi` implementations, registered on the global `actharnessFn` mock surface

## Depends on

`@actharness/core` and `@actharness/types`. No other `@actharness/*` imports.

`packages/node` gains a dependency on `@actharness/network-mock` and removes its own network mock implementation.

## Behavior (MUST)

### 1. Shared mock registry

`mockNetwork(matcher, status, response)` and `mockGitHubApi(routes)` push entries into a module-level pending queue inside this package. The queue is drained by whichever path is active at step execution time — Node IPC path or proxy path. The same registered mock reaches the correct interceptor regardless of the step's shell.

`mockNetwork` returns a `NetworkMock` handle immediately. The handle is attached to the registry entry and receives hit records when the step runs.

### 2. Node path — JsSandboxNetworkScope

Behaviour unchanged from the current `packages/node` implementation:

1. `drainNetworkMocks()` serializes pending mocks (`RegExp → { source, flags }`, functions rejected with a clear error message — IPC boundary cannot carry them)
2. Serialized mocks sent to the forked child via IPC init message
3. Child bootstrap (see §3) intercepts HTTP and sends `{ type: 'apiHit' | 'networkHit', url, method, pattern }` back via `process.send()`
4. Parent receives messages and records to `.calls` on the corresponding handle

### 3. Node bootstrap fragment

The network interception block of `sandbox-bootstrap.mjs` moves to this package and is imported by `packages/node`'s bootstrap. No behavioral change:

- undici `MockAgent` resolved from the action's own `node_modules`
- `@mswjs/interceptors` BatchInterceptor with node preset
- Both interceptors disabled for unmatched requests (`throwIfNotMatched` equivalent)
- Hit events sent via `process.send()`

### 4. CA cert lifecycle (proxy path)

Generate a self-signed CA keypair **once per test session**. Store cert PEM and key PEM in OS temp files. Reuse across all shell steps in the session.

Tear down (delete temp files) when the test session ends.

**Required extensions (OpenSSL 3.x):** Python 3.14+ / OpenSSL 3.6+ enforces RFC 5280 strictly and rejects certs that lack the Authority Key Identifier extension. Both generated cert types must include:

- CA cert: `SubjectKeyIdentifierExtension`
- Host cert: `SubjectKeyIdentifierExtension` + `AuthorityKeyIdentifierExtension` (keyed to the CA's public key)

Without these, Python's `urllib.request` (and any OpenSSL 3.x client) fails with `SSL: CERTIFICATE_VERIFY_FAILED: Missing Authority Key Identifier`. curl on macOS uses LibreSSL/SecureTransport and does not enforce this.

### 5. ProxyMockServer — HTTP requests

Plain HTTP requests (`GET http://example.com/path HTTP/1.1`) carry the full URL in the request line. The proxy parses the URL, runs it through the matcher chain (§7), and returns the mock response. Unmatched: `502 Unmatched mock request` — no real network call is ever made.

### 6. ProxyMockServer — HTTPS CONNECT tunnel

HTTPS clients send `CONNECT hostname:443 HTTP/1.1`. The proxy:

1. Responds `200 Connection established`
2. Generates a TLS server cert for the requested hostname, signed by the session CA (cached per hostname within the session)
3. Negotiates TLS with the client
4. Reads the decrypted inner HTTP request and matches as in §5

### 7. Mock matching (proxy path)

Mocks are loaded into the proxy before each shell step and cleared after. `NetworkMatcher` semantics:

| Matcher type | Match condition |
|---|---|
| `string` | Exact URL match, or substring if no exact match |
| `RegExp` | `regex.test(url)` |
| `(url, method) => boolean` | Evaluated in-process — **supported** (unlike Node path) |

First-match wins.

### 8. Per-call response factories (both paths)

`mockNetwork` accepts either a static response or a factory `(url, method, body) => responseBody`. The factory is always called with the **actual request's** `url`, `method`, and `body` — on both paths. This is consistent and correct.

```ts
let n = 0
mockNetwork('https://example.com/api', 200, () => ({ attempt: ++n }))
```

Two requests → `{ attempt: 1 }`, then `{ attempt: 2 }`.

**Proxy path**: factory is called in-process when the request arrives. No special handling needed.

**Node path**: factory functions cannot be serialized over IPC. Instead, the bootstrap uses a **bidirectional IPC round-trip** per intercepted request:

1. Child intercepts a request, suspends it, sends `{ type: 'networkRequest', requestId, url, method, requestHeaders, requestBody }` to parent
2. Parent matches the mock, calls the factory (or uses the static response) with `(url, method, requestBody)`
3. Parent sends `{ type: 'networkResponse', requestId, status, response }` back to child
4. Child's async interceptor handler resolves with the received response

`@mswjs/interceptors` handlers support returning a `Promise`, making the async suspension feasible. `requestId` is a per-request UUID generated by the child.

Static responses bypass the round-trip: they are serialized at drain time and sent with the mock entry, so the child can respond immediately without contacting the parent.

### 9. Hit recording (both paths)

On each matched request (after the response is determined), the child sends `{ type: 'networkHit', requestId, url, method, requestHeaders, requestBody, response, matchedPattern }` to the parent. The parent records a `NetworkMockCall`:

```ts
interface NetworkMockCall {
  url: string
  method: string
  requestHeaders: Record<string, string>
  requestBody: string | null
  response: unknown
  matchedPattern: string  // original matcher stringified
}
```

On the proxy path, the same fields are recorded directly in-process (no IPC needed).

`NetworkMock` handle: `.calls`, `.called`, `.callCount`, `.clear()` — identical interface for both paths.

### 10. mockGitHubApi (both paths)

`mockGitHubApi(routes)` converts Octokit-style route strings (`'GET /repos/{owner}/{repo}'`) to matchers against `api.github.com`. Path params are extracted and passed to response factory functions.

Node path: existing serialization logic preserved (moved here from `packages/node`).
Proxy path: same route → RegExp conversion; hostname matched as `api.github.com`.

### 11. No real network

Both paths block all unmatched requests. Proxy path: `502`, no outbound connection. Node path: undici `MockAgent` in `throwIfNotMatched` mode.

### 12. Env var injection — proxy path

Injected into the subprocess env before spawning:

| Env var | Value | Covers |
|---|---|---|
| `HTTP_PROXY` | `http://127.0.0.1:{port}` | all |
| `HTTPS_PROXY` | `http://127.0.0.1:{port}` | all |
| `SSL_CERT_FILE` | CA cert PEM path | OpenSSL-linked tools |
| `CURL_CA_BUNDLE` | CA cert PEM path | curl |
| `NODE_EXTRA_CA_CERTS` | CA cert PEM path | Node.js (shell: node steps) |
| `REQUESTS_CA_BUNDLE` | CA cert PEM path | Python `requests`, `httpx` |

Python's `urllib.request` reads `SSL_CERT_FILE` or `CURL_CA_BUNDLE` (loaded manually into the SSL context). It also picks up `HTTPS_PROXY` / `https_proxy` automatically via `ProxyHandler`.

### 13. PowerShell wrapper injection

For `shell: pwsh` / `shell: powershell`, prepend to the script before writing the temp `.ps1` file:

```powershell
$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true
```

### 14. Integration with ShellSandbox (proxy path)

`packages/shell/src/shell-sandbox.ts` is the only integration point. When a shell step (any shell, including `shell: node`) runs:

1. Check pending mocks in the shared registry
2. If mocks exist: drain into proxy, start proxy if not running
3. Inject env vars (§12) into subprocess env
4. Apply pwsh wrapper if applicable (§13)
5. Run the shell step
6. After completion: clear proxy's active mocks, collect hit records into handles
7. Return handles to caller for assertion

If no mocks are registered, the proxy is not started.

### 15. Integration with packages/node (Node path)

`packages/node`'s `JsSandbox` calls `drainNetworkMocks()` from this package (instead of from its own `network-scope.ts`). The bootstrap imports the network interception fragment from this package. Everything else in `packages/node` is unchanged.

## Acceptance

### Fixture A — bash HTTP mock

```ts
mockNetwork('http://example.com/api', 200, { ok: true });
const result = await actharness('./bash-http.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"ok":true}');
```

Bash script: `curl http://example.com/api`. Without a matching mock the proxy returns 502 and curl exits non-zero.

### Fixture B — bash HTTPS mock

Same as A but `https://api.example.com/data`. Verifies CA cert + CONNECT tunnel for curl (`CURL_CA_BUNDLE`).

```ts
mockNetwork('https://api.example.com/data', 200, { value: 'secure' });
const result = await actharness('./bash-https.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"value":"secure"}');
```

### Fixture C — Python urllib.request mock

Python script uses `urllib.request` (stdlib). Reads `SSL_CERT_FILE` / `CURL_CA_BUNDLE` and loads it into an `ssl.create_default_context()`. `ProxyHandler` picks up `HTTPS_PROXY` automatically.

```ts
mockNetwork('https://api.example.com/data', 200, { value: 'from-python' });
const result = await actharness('./python-https.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"value":"from-python"}');
```

Note: `requests` is not used — it is a third-party library not guaranteed to be installed.

### Fixture D — PowerShell mock

pwsh script: `Invoke-RestMethod -Uri 'https://api.example.com/data'`.

Verifies `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` wrapper prepended automatically — no `-SkipCertificateCheck` needed in the user's script.

### Fixture E — sh curl mock

sh script uses `curl` (not wget — wget is not installed on macOS). `CURL_CA_BUNDLE` is set by the proxy env.

```ts
mockNetwork('https://api.example.com/data', 200, { value: 'from-sh' });
const result = await actharness('./sh-https.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"value":"from-sh"}');
```

### Fixture F — mockGitHubApi over proxy (bash)

```ts
mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'owner/repo' } });
const result = await actharness('./bash-github-api.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('full_name', 'owner/repo');
```

### Fixture G — function matcher (proxy path)

```ts
mockNetwork(
  (url, method) => url.includes('/api') && method === 'POST',
  200,
  { ok: true },
);
const result = await actharness('./bash-post.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"ok":true}');
```

Verifies in-process function matchers (unsupported on Node path due to IPC boundary).

### Fixture H — per-call response factory (proxy path)

```ts
let n = 0;
mockNetwork('https://example.com/api', 200, () => ({ attempt: ++n }));
const result = await actharness('./bash-factory.yml').run();
expect(result).toHaveSucceeded();
```

Bash fixture makes two curl calls; factory is invoked once per request in-process.

### Fixture I — requestHeaders and requestBody recorded

Same fixture as G (POST request). Verifies that request metadata is captured in the mock handle's `.calls`.

```ts
mockNetwork('https://example.com/api', 200, { ok: true });
const result = await actharness('./bash-post.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"ok":true}');
```

### Fixture J — unmatched request blocked (502)

A mock is registered for a different URL so the proxy starts, but the action hits an unregistered URL. The proxy returns 502; the step captures the status code.

```ts
mockNetwork('https://other.example.com/noop', 200, {});
const result = await actharness('./bash-unmatched.yml').run();
expect(result).toHaveSucceeded();
expect(result).toHaveOutput('status', '502');
```

The fixture uses `curl -s -o /dev/null -w "%{http_code}"` to capture the HTTP status without failing the step.

### Fixture K — Node path unaffected

Existing Node mock fixtures pass unchanged. The mock layer moved from `packages/node` to this package with no behavioral change on the Node path.

### Fixture L — shared registry across multiple runs

A single `mockNetwork` registration accumulates hits across multiple `run()` calls within the same test. `resetNetworkMocks()` is called in the global `afterEach` (not between runs).

```ts
mockNetwork('https://api.example.com/data', 200, { value: 'shared' });
const result1 = await actharness('./bash-https.yml').run();
const result2 = await actharness('./bash-https.yml').run();
expect(result1).toHaveSucceeded();
expect(result1).toHaveOutput('body', '{"value":"shared"}');
expect(result2).toHaveSucceeded();
expect(result2).toHaveOutput('body', '{"value":"shared"}');
```

## Done-when

All 12 fixtures green; Node path behavior unchanged (existing Node fixtures pass); proxy handles HTTP and HTTPS CONNECT; CA cert generated once per session, cleaned up after; env var bundles injected for curl / wget / Python / Node.js; pwsh wrapper injected; function matchers work on both paths; per-call response factories called with actual request `(url, method, body)` on both paths; Node path uses bidirectional IPC round-trip for factory evaluation; hit records include `url`, `method`, `requestHeaders`, `requestBody` on both paths; `NetworkMock` handle exposes `.calls` / `.called` / `.callCount` / `.clear()`; shared registry serves both paths; proxy not started when no mocks registered; no real outbound connections; `packages/node` mock layer removed and replaced with imports from this package; deps limited to `core` + `types`.
