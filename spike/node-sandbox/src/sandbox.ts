import { Worker } from 'worker_threads';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { rmSync } from 'fs';
import { allocateProtocolFiles, parseProtocolFile, parseAnnotations } from './protocol.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const BOOTSTRAP = join(__dir, 'worker-bootstrap.mjs');

export interface MockRoutes {
  // e.g. "GET /repos/{owner}/{repo}/issues/{issue_number}/comments" → response body
  [pattern: string]: unknown;
}

export interface SandboxOptions {
  entrypoint: string;
  env?: Record<string, string>;
  mockRoutes?: MockRoutes;
  // STATE_* env vars from a previous phase (pre → main → post threading).
  stateEnv?: Record<string, string>;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  envVars: Record<string, string>;
  state: Record<string, string>;
  annotations: Array<{ level: string; message: string }>;
  warnings: string[];
}

export async function runInSandbox(options: SandboxOptions): Promise<SandboxResult> {
  const protocol = allocateProtocolFiles();

  const env: Record<string, string> = {
    ...options.env,
    ...options.stateEnv,
    GITHUB_OUTPUT: protocol.output,
    GITHUB_ENV: protocol.env,
    GITHUB_STATE: protocol.state,
    GITHUB_PATH: protocol.path,
    GITHUB_STEP_SUMMARY: protocol.summary,
  };

  try {
    const { exitCode, stdout, stderr, warnings } = await spawnWorker(
      options.entrypoint,
      env,
      options.mockRoutes ?? {},
    );

    const outputs = parseProtocolFile(protocol.output);
    const envVars = parseProtocolFile(protocol.env);
    const state = parseProtocolFile(protocol.state);
    const annotations = parseAnnotations(stdout);

    return { exitCode, stdout, stderr, outputs, envVars, state, annotations, warnings };
  } finally {
    rmSync(protocol.dir, { recursive: true, force: true });
  }
}

interface WorkerOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  warnings: string[];
}

function spawnWorker(
  entrypoint: string,
  env: Record<string, string>,
  mockRoutes: Record<string, unknown>,
): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(BOOTSTRAP, {
      workerData: { entrypoint, env, mockRoutes },
      stdout: true,
      stderr: true,
    });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const warnings: string[] = [];

    worker.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    worker.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    worker.on('message', (msg: { type: string; code?: number; message?: string }) => {
      if (msg.type === 'done') exitCode = msg.code ?? 0;
      if (msg.type === 'warn') warnings.push(msg.message ?? '');
    });

    worker.on('exit', (code: number) => {
      // If the worker exited on its own (untrapped exit), use that code.
      resolve({ exitCode: exitCode || code || 0, stdout, stderr, warnings });
    });

    worker.on('error', reject);
  });
}
