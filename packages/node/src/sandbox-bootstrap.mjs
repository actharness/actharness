/**
 * Sandbox bootstrap — runs inside a child_process.fork()'d process before the action.
 *
 * Responsibilities:
 *   1. Receive entrypoint/env/mocks via an IPC 'message' from the parent (the fork
 *      equivalent of worker_threads' workerData — child_process has no such option)
 *   2. Apply process.env from the init message
 *   3. Trap process.exit() so coverage can be flushed before the process really exits
 *   4. Mount network interceptors for apiMocks and networkMocks (optional):
 *      4a. undici MockAgent — covers npm undici-based clients (@actions/github Octokit)
 *      4b. @mswjs/interceptors — covers global fetch, http/https, axios, etc.
 *   5. Collect V8 line coverage via the inspector API
 *   6. Dynamic-import the action's entrypoint
 *   7. Report coverage + { type:'done', exitCode } via process.send, then exit
 */

import path from 'path';
import { realpathSync } from 'fs';
import { Session } from 'inspector';
import { mountNetworkInterceptors } from '@actharness/network-mock/bootstrap-network';

// ── 1. Receive init data over IPC ──────────────────────────────────────────────
const initData = await new Promise((resolve) => {
  process.once('message', resolve);
});

// Unref the IPC channel so it doesn't keep the event loop alive.
// The action's own async work controls when beforeExit fires.
process.channel?.unref();

// ── 2. Apply env ──────────────────────────────────────────────────────────────
for (const [k, v] of Object.entries(initData.env)) {
  process.env[k] = String(v);
}

// ── 3. Trap process.exit ──────────────────────────────────────────────────────
class SandboxExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = 'SandboxExitSignal';
    this.exitCode = code ?? 0;
  }
}

process.exit = function sandboxExit(code) {
  throw new SandboxExitSignal(code ?? 0);
};

// ── 4. Mount network interceptors ─────────────────────────────────────────────
await mountNetworkInterceptors({
  apiMocks: initData.apiMocks ?? [],
  networkMocks: initData.networkMocks ?? [],
  actionDir: path.dirname(initData.entrypoint),
});

// ── 5. Start V8 coverage ────────────────────────────────────────────────────
const session = new Session();
session.connect();

function startCoverage() {
  return new Promise((resolve, reject) => {
    session.post('Profiler.enable', (err) => {
      if (err) return reject(err);
      session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: true }, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

function takeCoverage() {
  return new Promise((resolve) => {
    session.post('Profiler.takePreciseCoverage', (err, result) => {
      resolve(!err && result ? result.result : []);
    });
  });
}

// ── 6. Run the action entrypoint ────────────────────────────────────────────
const actionDir = realpathSync(path.dirname(initData.entrypoint));
let _exitCode = 0;

async function runAction() {
  await startCoverage().catch(() => { /* non-fatal */ });

  try {
    await import(initData.entrypoint);
    _exitCode = process.exitCode ?? 0;
  } catch (err) {
    if (err instanceof SandboxExitSignal) {
      _exitCode = err.exitCode;
    } else {
      process.stderr.write(`\nUncaught error in action: ${err.stack ?? err.message}\n`);
      _exitCode = 1;
    }
  }
}

// ── 7. Stop coverage, filter, send — runs after async action work completes ───
// beforeExit fires only when the event loop is fully drained, meaning the
// action's fire-and-forget run() promise has resolved and core.setFailed /
// core.setOutput have had a chance to execute.
let _coverageSent = false;
process.on('beforeExit', async () => {
  if (_coverageSent) return;
  _coverageSent = true;

  const exitCode = (process.exitCode ?? 0) > 0 ? process.exitCode : _exitCode;

  const v8Data = await takeCoverage().catch(() => []);
  session.disconnect();

  const filtered = v8Data
    .filter((entry) => {
      const url = entry.url;
      if (!url.startsWith('file://')) return false;
      const filePath = url.slice(7);
      if (filePath.includes('node_modules')) return false;
      if (filePath.includes('sandbox-bootstrap')) return false;
      return filePath.startsWith(actionDir);
    })
    .map((entry) => ({ path: entry.url.slice(7), v8Data: entry }));

  process.send({ type: 'v8coverage', data: filtered });
  process.send({ type: 'done', exitCode });
  // Close the IPC channel so the process can exit naturally.
  process.disconnect();
});

runAction();
