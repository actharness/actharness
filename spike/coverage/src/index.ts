import { resolve, dirname, isAbsolute } from 'path';
import { parseAction, parseWorkflow, resolveActionPath, resolveActionDir } from './parser.js';
import { runComposite, makeRunResult } from './composite.js';
import { runNode } from './node.js';
import { runWorkflow } from './workflow.js';
import { MockRegistry } from './mock.js';
import { notifyRunSink } from './run-sink.js';
import type {
  ActspecOptions, RunInput, RunResult, WorkflowResult,
  ActionMock, ActionMockDef, ActionMockImpl, GitHubApiRoutes,
} from './types.js';

export interface Action {
  readonly type: string;
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  mockGitHubApi(routes: GitHubApiRoutes): void;
  unmock(ref?: string): void;
  clearMocks(): void;
  resetMocks(): void;
  run(input?: RunInput): Promise<RunResult>;
}

export function actspec(source: string, _options?: ActspecOptions): Action {
  const rawPath = resolveSource(source);
  const sourceFile = resolveActionPath(rawPath);
  const actionDir = resolveActionDir(rawPath);
  const action = parseAction(rawPath);
  const registry = new MockRegistry();

  return {
    get type() { return action.runs.using; },

    mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock {
      return registry.mock(ref, def);
    },

    mockGitHubApi(routes: GitHubApiRoutes): void {
      registry.mockGitHubApi(routes);
    },

    unmock(ref?: string): void {
      if (ref === undefined) registry.reset();
    },

    clearMocks(): void { registry.clearCalls(); },
    resetMocks(): void { registry.reset(); },

    async run(input: RunInput = {}): Promise<RunResult> {
      let result: RunResult;
      let jsLineCoverage = undefined;

      if (action.runs.using === 'composite') {
        result = await runComposite({ actionDir, action, input, mocks: registry });
      } else if (action.runs.using.startsWith('node')) {
        const nodeOut = await runNode({ actionDir, action, input, mocks: registry });
        result = nodeOut.result;
        jsLineCoverage = nodeOut.jsLineCoverage;
      } else {
        result = makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
      }

      // D1: notify the process-global run sink so coverage can observe without importing us.
      notifyRunSink({ kind: 'action', result, sourceFile, actionDir, jsLineCoverage });

      return result;
    },
  };
}

export interface Workflow {
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  mockJob(id: string, def?: { outputs?: Record<string, string>; result?: string }): void;
  resetMocks(): void;
  run(input?: RunInput): Promise<WorkflowResult>;
}

export function actspecWorkflow(source: string, _options?: ActspecOptions): Workflow {
  const workflowPath = resolveSource(source);
  const workflow = parseWorkflow(workflowPath);
  const registry = new MockRegistry();
  const mockedJobs = new Map<string, { outputs?: Record<string, string>; result?: string }>();

  return {
    mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock {
      return registry.mock(ref, def);
    },

    mockJob(id: string, def?: { outputs?: Record<string, string>; result?: string }): void {
      mockedJobs.set(id, def ?? {});
    },

    resetMocks(): void { registry.reset(); mockedJobs.clear(); },

    async run(input: RunInput = {}): Promise<WorkflowResult> {
      // Workflow runner notifies the sink per-job inside runWorkflow.
      return runWorkflow({ workflowPath, workflow, input, mocks: registry, mockedJobs });
    },
  };
}

function resolveSource(source: string): string {
  return isAbsolute(source) ? source : resolve(process.cwd(), source);
}
