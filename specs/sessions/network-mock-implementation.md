# `@actharness/network-mock` — implementation handoff

## Task

Implement the `@actharness/network-mock` package per the spec at [specs/modules/network-mock.md](../modules/network-mock.md).

Read that file fully before doing anything. All decisions are already made — do not invent new ones, ask if anything is unclear.

## What exists today

| File | Role |
|---|---|
| [packages/node/src/network-scope.ts](../../packages/node/src/network-scope.ts) | Current mock registry + hit recording — moves to new package |
| [packages/node/src/sandbox-bootstrap.mjs](../../packages/node/src/sandbox-bootstrap.mjs) | Network interception block (undici MockAgent + MSW interceptors) — moves to new package |
| [packages/node/src/js-sandbox.ts](../../packages/node/src/js-sandbox.ts) | Drains mocks + handles IPC messages — update to import from new package |
| [packages/shell/src/shell-sandbox.ts](../../packages/shell/src/shell-sandbox.ts) | Integration point for the proxy path |
| [packages/types/src/index.ts](../../packages/types/src/index.ts) | `NetworkMock`, `NetworkMatcher`, `NetworkMockCall` types — add `requestHeaders` and `requestBody` to `NetworkMockCall` |

## New package

`packages/network-mock` — follow the same structure as `packages/node` (own `package.json`, `tsconfig.json`, `src/`, `test/`).

## Implementation order

1. Create `packages/network-mock`; move shared registry + `mockNetwork` / `mockGitHubApi` surface here
2. Update `packages/node` to import from it — Node path must use the bidirectional IPC round-trip for response factories (§8 of spec)
3. Build `ProxyMockServer` (HTTP + HTTPS CONNECT MITM) + per-session CA cert generation
4. Wire `ShellNetworkScope` into `packages/shell/src/shell-sandbox.ts`
5. Add fixtures per the acceptance criteria in the spec

## Key decisions already made

- **Response factories on Node path**: bidirectional IPC round-trip — child suspends intercepted request, sends `{ type: 'networkRequest', requestId, url, method, requestHeaders, requestBody }` to parent, parent calls factory, sends `{ type: 'networkResponse', requestId, status, response }` back, child resumes. Static responses skip the round-trip (serialized at drain time).
- **`requestHeaders` / `requestBody`**: included on both paths now, not deferred.
- **Function matchers**: work on proxy path (in-process); rejected on Node path (IPC boundary).
- **PowerShell**: prepend `$PSDefaultParameterValues['*:SkipCertificateCheck'] = $true` to script before writing temp file.
- **Shared registry**: move pending queue to `packages/network-mock`; both Node and proxy paths drain from it. `packages/node` gains a dep on `@actharness/network-mock`.
- **Proxy is in-process**: a Node.js `http.Server` running inside the test process — no separate subprocess.
- **CA cert**: generated once per test session, stored in OS temp files, cleaned up on session end.

## Do not start writing code without confirming the plan with the user first.
