// Public API entry points: actspec() and actspecWorkflow().
// Implements the surface from docs/API.md §1-§2 and §10.

import { resolve, dirname, isAbsolute } from 'path';
import { parseAction, parseWorkflow } from './parser.js';
import { runComposite, makeRunResult } from './composite.js';
import { runNode } from './node.js';
import { runWorkflow } from './workflow.js';
import { MockRegistry } from './mock.js';
import type {
  ActspecOptions,
  RunInput,
  RunResult,
  WorkflowResult,
  ActionMock,
  ActionMockDef,
  ActionMockImpl,
  GitHubApiRoutes,
} from './types.js';

// ── Action handle ─────────────────────────────────────────────────────────────

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
  const actionPath = resolveSource(source);
  const actionDir = actionPath.endsWith('.yml') || actionPath.endsWith('.yaml')
    ? dirname(actionPath)
    : actionPath;
  const action = parseAction(actionPath);
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
      // Single-ref unmock not implemented in this spike.
    },

    clearMocks(): void {
      registry.clearCalls();
    },

    resetMocks(): void {
      registry.reset();
    },

    async run(input: RunInput = {}): Promise<RunResult> {
      if (action.runs.using === 'composite') {
        return runComposite({ actionDir, action, input, mocks: registry });
      } else if (action.runs.using.startsWith('node')) {
        return runNode({ actionDir, action, input, mocks: registry });
      }
      // Unsupported type: return empty success result.
      return makeRunResult({ conclusion: 'success', outputs: {}, steps: [], env: {}, annotations: [], stdout: '', stderr: '' });
    },
  };
}

// ── Workflow handle ───────────────────────────────────────────────────────────

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

    resetMocks(): void {
      registry.reset();
      mockedJobs.clear();
    },

    async run(input: RunInput = {}): Promise<WorkflowResult> {
      return runWorkflow({ workflowPath, workflow, input, mocks: registry, mockedJobs });
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSource(source: string): string {
  return isAbsolute(source) ? source : resolve(process.cwd(), source);
}
