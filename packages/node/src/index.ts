// Side-effect: registers NodeExecutor with @actharness/core
import './node-executor.js';

import { runInSandbox } from './js-sandbox.js';

export { mockGitHubApi, mockGitHubApiOnce, mockNetwork, mockNetworkOnce, resetNetworkMocks, drainForNode as drainNetworkMocks, NetworkMockHandle } from '@actharness/network-mock';
export { runInSandbox } from './js-sandbox.js';
export type { SandboxOptions, SandboxResult } from './js-sandbox.js';

/** Convenience wrapper: runs a node script through the full sandbox (mocks + coverage). */
export async function runShellNode(
  scriptPath: string,
  env: Record<string, string>,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; jsCoverage: { path: string; v8Data: unknown }[] }> {
  const result = await runInSandbox({ entrypoint: scriptPath, env, cwd });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, jsCoverage: result.jsCoverage };
}
