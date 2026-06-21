import { fork } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { allocateProtocolFiles, parseEnvFile, parseStdoutCommands } from '@actharness/core';
import type { ProtocolFiles } from '@actharness/core';
import type { Annotation } from '@actharness/types';
import type { DrainedForNode } from '@actharness/network-mock';
import { drainForNode, recordApiHit, recordNetworkHit, matchNetworkEntry, pruneConsumedOnce } from '@actharness/network-mock';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'sandbox-bootstrap.mjs');

export interface SandboxOptions {
  entrypoint: string;
  env: Record<string, string>;
  cwd: string;
  /** Pre-existing protocol file paths from the composite executor. When provided,
   *  runInSandbox uses them as-is and skips cleanup (the caller owns the files). */
  protocolFiles?: Omit<ProtocolFiles, 'dir'>;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
  envVars: Record<string, string>;
  state: Record<string, string>;
  annotations: Annotation[];
  masks: string[];
  jsCoverage: { path: string; v8Data: unknown }[];
}

/** Public API — drains network mocks internally. Single-invocation callers use this. */
export async function runInSandbox(options: SandboxOptions): Promise<SandboxResult> {
  return _runInSandboxWithMocks(options, drainForNode());
}

/** Package-internal — accepts pre-drained mocks. Used by node-executor for multi-phase runs. */
export async function _runInSandboxWithMocks(
  options: SandboxOptions,
  drained: DrainedForNode,
): Promise<SandboxResult> {
  const ownProtocol = !options.protocolFiles;
  const protocol: ProtocolFiles = options.protocolFiles
    ? { ...options.protocolFiles, dir: '' }
    : allocateProtocolFiles();

  const env: Record<string, string> = {
    ...options.env,
    GITHUB_OUTPUT: protocol.output,
    GITHUB_ENV: protocol.env,
    GITHUB_STATE: protocol.state,
    GITHUB_PATH: protocol.path,
    GITHUB_STEP_SUMMARY: protocol.summary,
  };

  try {
    const { exitCode, stdout, stderr, jsCoverage } = await spawnChild(
      options.entrypoint,
      env,
      options.cwd,
      drained,
    );
    pruneConsumedOnce();

    const outputs = parseEnvFile(protocol.output);
    const envVars = parseEnvFile(protocol.env);
    const state = parseEnvFile(protocol.state);
    const { annotations, masks } = parseStdoutCommands(stdout);

    return { exitCode, stdout, stderr, outputs, envVars, state, annotations, masks, jsCoverage };
  } finally {
    if (ownProtocol) rmSync(protocol.dir, { recursive: true, force: true });
  }
}

interface ChildMessage {
  type: 'done' | 'v8coverage' | 'apiHit' | 'networkHit' | 'networkRequest' | 'matchRequest';
  exitCode?: number;
  data?: unknown[];
  // apiHit
  pattern?: string;
  // networkHit
  matchedPattern?: string;
  response?: unknown;
  // shared (apiHit / networkHit / networkRequest / matchRequest)
  url?: string;
  method?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string | null;
  // networkRequest / matchRequest
  requestId?: string;
  // matchRequest
  mockIndex?: number;
}

interface ChildOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
  jsCoverage: { path: string; v8Data: unknown }[];
}

function spawnChild(
  entrypoint: string,
  env: Record<string, string>,
  cwd: string,
  drained: DrainedForNode,
): Promise<ChildOutcome> {
  const { apiMocks, networkMocks, apiEntries, networkEntries } = drained;
  return new Promise((resolve, reject) => {
    const child = fork(BOOTSTRAP, [], {
      cwd,
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    child.send({
      entrypoint,
      env,
      apiMocks,
      networkMocks,
    });

    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    const jsCoverage: { path: string; v8Data: unknown }[] = [];

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('message', (msg: ChildMessage) => {
      if (msg.type === 'done') {
        exitCode = msg.exitCode as number;
      } else if (msg.type === 'v8coverage') {
        jsCoverage.push(...msg.data as { path: string; v8Data: unknown }[]);
      } else if (msg.type === 'apiHit') {
        recordApiHit(
          apiEntries,
          msg.pattern as string,
          msg.url as string,
          msg.method as string,
          msg.requestHeaders!,
          msg.requestBody ?? null,
        );
      } else if (msg.type === 'networkHit') {
        recordNetworkHit(
          networkEntries,
          msg.url as string,
          msg.method as string,
          msg.requestHeaders!,
          msg.requestBody ?? null,
          msg.response,
          msg.matchedPattern as string,
        );
      } else if (msg.type === 'matchRequest') {
        // Child is asking the parent to evaluate a function matcher (and factory if applicable).
        const requestId = msg.requestId as string;
        const url = msg.url as string;
        const method = msg.method as string;
        const requestBody = msg.requestBody ?? null;
        const requestHeaders = msg.requestHeaders as Record<string, string>;
        const mockIndex = msg.mockIndex as number;

        const entry = networkEntries[mockIndex]!;

        let matched: boolean;
        try {
          matched = (entry.matcher as (url: string, method: string) => boolean)(url, method);
        } catch {
          child.send({ type: 'matchResponse', requestId, matched: false });
          return;
        }

        if (!matched) {
          child.send({ type: 'matchResponse', requestId, matched: false });
          return;
        }

        let status = entry.status;
        let body: unknown;
        let headers: Record<string, string> | undefined;

        if (entry.responseFactory) {
          try {
            const result = entry.responseFactory(url, method, requestBody as string | null);
            body = result.body;
            if (result.status !== undefined) status = result.status;
            headers = result.headers;
          } catch {
            child.send({ type: 'matchResponse', requestId, matched: true, status: 500, body: { error: '[actharness] factory threw' } });
            return;
          }
        } else {
          body = entry.response;
          headers = entry.responseHeaders;
        }

        // Record the hit in the parent (function matchers never send networkHit from child).
        if (entry.once) entry.consumed = true;
        entry.handle._record({
          url,
          method,
          requestHeaders: requestHeaders as Record<string, string>,
          requestBody: requestBody as string | null,
          response: body,
          matchedPattern: `[fn:${mockIndex}]`,
        });

        child.send({ type: 'matchResponse', requestId, matched: true, status, body, headers, matchedPattern: `[fn:${mockIndex}]` });
      } else {
        // Bidirectional IPC: child suspended a factory-backed request — evaluate factory in parent.
        const requestId = msg.requestId as string;
        const url = msg.url as string;
        const method = msg.method as string;
        const requestBody = msg.requestBody ?? null;

        const netEntry = matchNetworkEntry(networkEntries, url, method)!;

        let status = netEntry.status;
        let body: unknown;
        let headers: Record<string, string> | undefined;

        try {
          const result = netEntry.responseFactory!(url, method, requestBody);
          body = result.body;
          if (result.status !== undefined) status = result.status;
          headers = result.headers;
        } catch {
          body = { error: '[actharness] factory threw' };
          status = 500;
        }

        child.send({ type: 'networkResponse', requestId, status, body, headers });
      }
    });

    child.on('exit', (code) => {
      resolve({ exitCode: code && code > 0 ? code : exitCode, stdout, stderr, jsCoverage });
    });

    child.on('error', reject);
  });
}
