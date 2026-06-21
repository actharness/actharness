// @actharness/core — public API

// Entry point
export { actharness } from './action-runner.js';
export type { Action } from './action-runner.js';

// Errors
export {
  ActharnessError,
  ParseError,
  MissingMockError,
  ExpressionError,
  ConfigError,
  CycleError,
  MaxDepthError,
} from './errors.js';

// Parser
export { parseAction, parseActionYaml } from './parser.js';

// Context
export type { ContextStore, StepContextEntry } from './context.js';
export {
  createContextStore,
  buildContexts,
  buildEnvVars,
  resolveInputValues,
  buildExpressionContexts,
  updateStoreStep,
  mergeStoreEnv,
  evalExpression,
  evalTemplate,
} from './context.js';

// Determinism
export type { JobStatus, ResolvedDeterminism } from './determinism.js';
export {
  createJobStatus,
  markJobFailure,
  markJobCancelled,
  resolveDeterminism,
  FROZEN_EPOCH,
  FROZEN_SEED,
  FROZEN_RUN_ID,
} from './determinism.js';

// Protocol
export type { ProtocolFiles, CommandParseResult } from './protocol.js';
export {
  allocateProtocolFiles,
  parseEnvFile,
  parseEnvFileContent,
  parseStdoutCommands,
  applyMasks,
} from './protocol.js';

// Mock registry
export type { MockResolution } from './mock-resolver.js';
export {
  MockRegistry,
  DEFAULT_MAX_DEPTH,
  checkCycle,
  checkMaxDepth,
} from './mock-resolver.js';

// Global mock scope
export type { ActionMockHandle } from './mock-scope.js';
export {
  ScopeRegistry,
  fileRootRegistry,
  scopeALS,
  currentScope,
  currentStack,
  lookupMock,
  runInDescribeScope,
  runInTestScope,
  globalMock,
  globalMockOnce,
  globalResetMocks,
} from './mock-scope.js';

// Executor registry
export type {
  SandboxFactory,
  ShellSandboxOptions,
  ShellSandboxResult,
  ExecutionCall,
  ExecutionResult,
  ActionExecutor,
} from './executor-registry.js';
export { registerExecutor, getExecutor } from './executor-registry.js';

// Step runner
export type { StepRunnerOptions, StepRunnerResult } from './step-runner.js';
export { runSteps } from './step-runner.js';

// Run sink
export type { RunListener, RunResultMeta } from './run-sink.js';
export { registerRunListener, notifyRunSink } from './run-sink.js';
