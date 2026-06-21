<div align="center">
  <img src="icon.png" width="96" alt="actharness">
  <h1><code>@actharness/network-mock</code></h1>
  <p>Network mocking for actharness — shells and Node actions.</p>
  <a href="https://www.npmjs.com/package/@actharness/network-mock"><img src="https://img.shields.io/npm/v/@actharness/network-mock?color=3fb950&label=npm" alt="npm"></a>
  <a href="https://github.com/actharness/actharness/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fb950" alt="license"></a>
</div>

<br>

Network interception for [actharness](https://github.com/theobassan/actharness). Provides `mockNetwork`, `mockGitHubApi`, and their `*Once` siblings — a single API that works across all shell types and Node actions, with no real outbound connections ever made.

## Usage

```ts
// Intercept any HTTP/HTTPS request from bash, sh, python, pwsh, curl, fetch, Octokit, …
mockNetwork('https://api.example.com/data', 200, { value: 'mocked' });

const result = await actharness('./action.yml').run();

expect(result).toHaveSucceeded();
expect(result).toHaveOutput('body', '{"value":"mocked"}');
```

```ts
// Match GitHub API routes (Octokit-style)
mockGitHubApi({
  'GET /repos/{owner}/{repo}': { full_name: 'owner/repo', stargazers_count: 42 },
});
```

```ts
// Function matcher — match by URL and method
mockNetwork(
  (url, method) => url.includes('/api') && method === 'POST',
  200,
  { ok: true },
);
```

```ts
// Custom content-type and raw body
mockNetwork('https://example.com/html', 200, '<h1>hello</h1>', { 'content-type': 'text/html' });
```

```ts
// Per-call response factory — return { status?, body, headers? }
let n = 0;
mockNetwork('https://example.com/api', 200, () => ({ body: { attempt: ++n } }));
```

```ts
// Factory overriding status per call
let first = true;
mockNetwork('https://example.com/api', 200, () => {
  if (first) { first = false; return { status: 429, body: '', headers: { 'retry-after': '1' } }; }
  return { body: { ok: true } };
});
```

Mocks are cleared automatically after each test via the global `afterEach` registered by `@actharness/cli`.

## How it works

Two interception paths, one registry:

- **Shell steps** (bash, sh, python, pwsh, `shell: node`, …) — an in-process HTTPS CONNECT proxy intercepts all traffic. The subprocess receives `HTTP_PROXY`, `HTTPS_PROXY`, and a per-session CA cert path. Function matchers and response factories run in-process.
- **Node executor** (`runs.using: node<N>`) — undici `MockAgent` + MSW interceptors inside the worker bootstrap, driven by bidirectional IPC. Function matchers are not supported on this path.

## Contents

- `mockNetwork(matcher, status, body, headers?)` — register a persistent network mock; `body` is a string (raw) or object (auto-JSON); `headers` sets custom response headers; `body` can also be a factory `(url, method, body) => { status?, body, headers? }` that controls all fields per call
- `mockNetworkOnce(matcher, status, body, headers?)` — one-shot variant: consumed on first match, then falls through to persistent mock or unmocked behaviour
- `mockGitHubApi(routes)` — register GitHub API route mocks
- `mockGitHubApiOnce(routes)` — one-shot variant: consumed on first match per route
- `resetNetworkMocks()` — clear all pending and active network mocks
- `ShellNetworkScope` — drain + proxy lifecycle for shell steps (used by `@actharness/shell`)
- `ProxyMockServer` — HTTPS CONNECT MITM proxy
- `NetworkMock`, `NetworkMockCall`, `NetworkMatcher` types
