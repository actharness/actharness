<div align="center">
  <img src="icon.png" width="96" alt="actharness">
  <h1><code>@actharness/node</code></h1>
  <p>Node.js action executor for actharness.</p>
  <a href="https://www.npmjs.com/package/@actharness/node"><img src="https://img.shields.io/npm/v/@actharness/node?color=3fb950&label=npm" alt="npm"></a>
  <a href="https://github.com/actharness/actharness/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fb950" alt="license"></a>
</div>

<br>

Node.js executor for [actharness](https://github.com/theobassan/actharness). Handles `runs.using: node<N>` actions (`node20`, `node22`, …) — runs the entrypoint in an isolated worker thread with full runner protocol support and network mocking.

Registers itself into `@actharness/core`'s executor registry on import. No public API — just import it.

## Usage

```ts
import '@actharness/node'; // registers the executor
import { actharness } from '@actharness/core';

const result = await actharness('./action.yml').run({ inputs: { token: 'ghp_…' } });

expect(result).toHaveSucceeded();
expect(result).toHaveOutput('result', 'ok');
```

If you use the `actharness` meta-package, this is already included.

## Network mocking

`mockNetwork` and `mockGitHubApi` from `@actharness/network-mock` work inside Node actions. Interception uses undici `MockAgent` + MSW interceptors loaded in the worker bootstrap. Function matchers work via a parent IPC round-trip per request. They do not work for undici-based clients (undici bypasses MSW); use string or RegExp matchers for those.

```ts
mockNetwork('https://api.example.com/data', 200, { value: 'mocked' });

const result = await actharness('./action.yml').run();
expect(result).toHaveSucceeded();
```

## What it provides

- **Worker isolation** — each action run gets its own worker thread with a clean `process.env`
- **Runner protocol** — `@actions/core` `setOutput`, `exportVariable`, `addPath`, `setFailed`, workflow commands — all work without patching
- **Network interception** — undici `MockAgent` + `@mswjs/interceptors` driven by bidirectional IPC with `@actharness/network-mock`
- **JS line coverage** — V8 inspector API inside the worker; results sent back to the host and converted with v8-to-istanbul
- **Pre/post lifecycle** — `pre:`, `main:`, `post:` phases with `pre-if`/`post-if` condition evaluation
