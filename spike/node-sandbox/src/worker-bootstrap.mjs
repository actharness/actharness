/**
 * Worker bootstrap — runs inside the worker_thread before the action.
 *
 * Responsibilities:
 *   1. Apply process.env from workerData.env (protocol file paths + INPUT_* etc.)
 *   2. Trap process.exit() so it doesn't kill the test runner (H5)
 *   3. Mount undici MockAgent from the action's own undici instance (H6)
 *   4. Dynamic-import the action's entrypoint (handles both CJS and ESM)
 *   5. Report { type:'done', exitCode } back to the parent via parentPort
 */

import { workerData, parentPort } from 'worker_threads';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ── 1. Apply env ──────────────────────────────────────────────────────────────
for (const [k, v] of Object.entries(workerData.env)) {
  process.env[k] = String(v);
}

// ── 2. Trap process.exit (H5) ─────────────────────────────────────────────────
class WorkerExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = 'WorkerExitSignal';
    this.workerExitCode = code;
  }
}

process.exit = function workerExit(code) {
  throw new WorkerExitSignal(code ?? 0);
};

// ── 3. Mount undici MockAgent (H6) ────────────────────────────────────────────
const mockRoutes = workerData.mockRoutes ?? {};
const hasMocks = Object.keys(mockRoutes).length > 0;

if (hasMocks) {
  const actionDir = path.dirname(workerData.entrypoint);
  let undici = null;
  try {
    const undiciPath = require.resolve('undici', { paths: [actionDir] });
    undici = require(undiciPath);
  } catch {
    parentPort.postMessage({ type: 'warn', message: 'undici not found in action deps; MockAgent not mounted' });
  }

  if (undici) {
    const { MockAgent, setGlobalDispatcher } = undici;
    const agent = new MockAgent();
    agent.disableNetConnect();

    for (const [pattern, mockData] of Object.entries(mockRoutes)) {
      const spaceIdx = pattern.indexOf(' ');
      const method = pattern.slice(0, spaceIdx).toUpperCase();
      const pathTemplate = pattern.slice(spaceIdx + 1);
      const pathRegex = new RegExp('^' + pathTemplate.replace(/\{[^}]+\}/g, '[^/?]+') + '(\\?.*)?$');
      const pool = agent.get('https://api.github.com');
      pool
        .intercept({ method, path: (p) => pathRegex.test(p) })
        .reply(200, JSON.stringify(mockData), { headers: { 'content-type': 'application/json' } });
    }

    setGlobalDispatcher(agent);
  }
}

// ── 4. Run the action entrypoint ──────────────────────────────────────────────

async function runAction() {
  let exitCode = 0;
  try {
    await import(workerData.entrypoint);
    exitCode = process.exitCode ?? 0;
  } catch (err) {
    if (err instanceof WorkerExitSignal) {
      exitCode = err.workerExitCode;
    } else {
      process.stderr.write(`\nUncaught error in action: ${err.stack ?? err.message}\n`);
      exitCode = 1;
    }
  }
  parentPort.postMessage({ type: 'done', exitCode });
}

runAction();
