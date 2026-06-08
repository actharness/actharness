// Docker spike entry point: actspec() for docker and composite actions.

import { resolve as resolvePath, dirname, extname, isAbsolute } from 'path';
import {
  parseAction,
  runComposite,
  makeRunResult,
  MockRegistry,
} from 'workflow-spike';
import type {
  RunInput,
  RunResult,
  ActionMock,
  ActionMockDef,
  ActionMockImpl,
} from 'workflow-spike';
import { runContainerAction, type ContainerBackend } from './container.js';

export interface DockerAction {
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  resetMocks(): void;
  run(input?: RunInput): Promise<RunResult>;
}

export function actspec(source: string, options?: { container?: ContainerBackend }): DockerAction {
  const sourcePath = isAbsolute(source) ? source : resolvePath(process.cwd(), source);
  const actionDir = (sourcePath.endsWith('.yml') || sourcePath.endsWith('.yaml'))
    ? dirname(sourcePath)
    : sourcePath;
  const action = parseAction(sourcePath);
  const registry = new MockRegistry();
  const backend: ContainerBackend = options?.container ?? 'mock';

  return {
    mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock {
      return registry.mock(ref, def);
    },

    resetMocks(): void {
      registry.reset();
    },

    async run(input: RunInput = {}): Promise<RunResult> {
      if (action.runs.using === 'docker') {
        return runContainerAction({
          actionDir,
          action,
          input,
          mocks: registry,
          backend,
          actionRef: source,
        });
      }
      if (action.runs.using === 'composite') {
        return runComposite({ actionDir, action, input, mocks: registry });
      }
      return makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
    },
  };
}
