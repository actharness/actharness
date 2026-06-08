// Worker thread bootstrap for running a node action's JS entrypoint in isolation.
// Plain ESM (.mjs) — no TypeScript needed; only uses Node.js built-in APIs.
// Loaded by node.ts via import.meta.url.

import { workerData, parentPort } from 'worker_threads';
import path from 'path';
import { Session } from 'inspector';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

for (const [k, v] of Object.entries(workerData.env)) {
  process.env[k] = String(v);
}

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
      pool.intercept({ method, path: (p) => pathRegex.test(p) })
        .reply(200, JSON.stringify(mockData), { headers: { 'content-type': 'application/json' } });
    }

    setGlobalDispatcher(agent);
  }
}

// H9: collect V8 line coverage via the inspector API.
// NODE_V8_COVERAGE fires on process exit, not thread exit — use inspector directly.
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

async function runAction() {
  let exitCode = 0;

  await startCoverage().catch(() => { /* non-fatal */ });

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

  const v8CoverageData = await takeCoverage().catch(() => []);
  session.disconnect();

  parentPort.postMessage({ type: 'v8coverage', data: v8CoverageData });
  parentPort.postMessage({ type: 'done', exitCode });
}

runAction();
