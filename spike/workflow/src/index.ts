// Public API entry points for the workflow spike.
// The re-exports below expose internals needed by the docker spike.

export { MockRegistry } from './mock.js';
export { allocateProtocolFiles, parseProtocolFile, parseAnnotations } from './protocol.js';
export type { ProtocolFiles } from './protocol.js';
export { buildContexts, buildEnvVars, resolveInputValues } from './context.js';
export type { JobStatus } from './context.js';
export { parseAction } from './parser.js';
export { makeRunResult, runComposite } from './composite.js';
export type {
  ParsedAction, RunInput, RunResult, StepResult, ActspecOptions,
  ActionMock, ActionMockDef, ActionMockImpl, ActionMockCall,
  Annotation, RunnerContext, GitHubContext,
} from './types.js';

import { resolve, isAbsolute } from 'path';
import { parseWorkflow } from './parser.js';
import { runWorkflow, wouldTrigger as evalTrigger } from './workflow.js';
import { MockRegistry } from './mock.js';
import type {
  RunInput, WorkflowResult, ActionMock, ActionMockDef, ActionMockImpl,
  TriggerInput, TriggerResult, JobMockDef,
} from './types.js';

export interface Workflow {
  mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock;
  mockJob(id: string, def?: JobMockDef): void;
  resetMocks(): void;
  wouldTrigger(input: TriggerInput): TriggerResult;
  run(input?: RunInput): Promise<WorkflowResult>;
}

export function actspecWorkflow(source: string): Workflow {
  const workflowPath = isAbsolute(source) ? source : resolve(process.cwd(), source);
  const workflow = parseWorkflow(workflowPath);
  const registry = new MockRegistry();
  const mockedJobs = new Map<string, JobMockDef>();

  return {
    mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock {
      return registry.mock(ref, def);
    },

    mockJob(id: string, def?: JobMockDef): void {
      mockedJobs.set(id, def ?? {});
    },

    resetMocks(): void {
      registry.reset();
      mockedJobs.clear();
    },

    wouldTrigger(input: TriggerInput): TriggerResult {
      return evalTrigger(workflow, input);
    },

    async run(input: RunInput = {}): Promise<WorkflowResult> {
      return runWorkflow({ workflowPath, workflow, input, mocks: registry, mockedJobs });
    },
  };
}
