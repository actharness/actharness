// Custom Vitest matchers registered via expect.extend.
// Implements all matchers from docs/API.md §6.

import { expect } from 'vitest';
import type { RunResult, StepResult, JobResult, WorkflowResult, ActionMock, Annotation } from './types.js';

function isRunResult(v: unknown): v is RunResult {
  return typeof v === 'object' && v !== null && 'conclusion' in v && 'steps' in v && 'outputs' in v;
}

function isWorkflowResult(v: unknown): v is WorkflowResult {
  return typeof v === 'object' && v !== null && 'conclusion' in v && 'jobs' in v;
}

function isActionMock(v: unknown): v is ActionMock {
  return typeof v === 'object' && v !== null && 'calls' in v && 'callCount' in v;
}

expect.extend({
  // ── RunResult matchers ────────────────────────────────────────────────────

  toHaveSucceeded(received: unknown) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const pass = received.conclusion === 'success';
    return {
      pass,
      message: () => pass
        ? `Expected result NOT to have succeeded`
        : `Expected result to have succeeded but conclusion was '${received.conclusion}'`,
    };
  },

  toHaveFailed(received: unknown) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const pass = received.conclusion === 'failure';
    return {
      pass,
      message: () => pass
        ? `Expected result NOT to have failed`
        : `Expected result to have failed but conclusion was '${received.conclusion}'`,
    };
  },

  toHaveRunStep(received: unknown, stepId: string) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const step = received.step(stepId);
    const pass = step !== undefined && step.ran && step.conclusion !== 'skipped';
    const ranIds = received.steps.filter(s => s.ran).map(s => s.id).join(', ');
    return {
      pass,
      message: () => pass
        ? `Expected step '${stepId}' NOT to have run`
        : `Expected step '${stepId}' to have run. Steps that ran: [${ranIds}]`,
    };
  },

  toHaveSkippedStep(received: unknown, stepId: string) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const step = received.step(stepId);
    const pass = step !== undefined && !step.ran;
    return {
      pass,
      message: () => pass
        ? `Expected step '${stepId}' NOT to have been skipped`
        : step === undefined
          ? `Expected step '${stepId}' to be skipped but no step with that id was found`
          : `Expected step '${stepId}' to be skipped but it ran with conclusion '${step.conclusion}'`,
    };
  },

  toHaveStepConclusion(received: unknown, stepId: string, expected: string) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const step = received.step(stepId);
    const pass = step !== undefined && step.conclusion === expected;
    return {
      pass,
      message: () => pass
        ? `Expected step '${stepId}' NOT to have conclusion '${expected}'`
        : step === undefined
          ? `Expected step '${stepId}' to have conclusion '${expected}' but step was not found`
          : `Expected step '${stepId}' to have conclusion '${expected}' but was '${step.conclusion}'`,
    };
  },

  toHaveOutput(received: unknown, key: string, expected?: string) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const actual = received.outputs[key];
    const pass = expected === undefined
      ? actual !== undefined
      : actual === expected;
    return {
      pass,
      message: () => pass
        ? `Expected output '${key}' NOT to ${expected === undefined ? 'be present' : `equal '${expected}'`}`
        : expected === undefined
          ? `Expected output '${key}' to be present. Available outputs: [${Object.keys(received.outputs).join(', ')}]`
          : `Expected output '${key}' to equal '${expected}' but was '${actual}'`,
    };
  },

  toHaveStepOutput(received: unknown, stepId: string, key: string, expected: string) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const step = received.step(stepId);
    const actual = step?.outputs[key];
    const pass = actual === expected;
    return {
      pass,
      message: () => pass
        ? `Expected step '${stepId}' output '${key}' NOT to equal '${expected}'`
        : step === undefined
          ? `Expected step '${stepId}' to exist but it was not found`
          : `Expected step '${stepId}' output '${key}' to equal '${expected}' but was '${actual}'`,
    };
  },

  toHaveAnnotation(received: unknown, level: string, messagePattern: string | RegExp) {
    if (!isRunResult(received)) {
      return { pass: false, message: () => 'Expected a RunResult' };
    }
    const pass = received.annotations.some((a: Annotation) => {
      if (a.level !== level) return false;
      if (typeof messagePattern === 'string') return a.message.includes(messagePattern);
      return messagePattern.test(a.message);
    });
    return {
      pass,
      message: () => pass
        ? `Expected no ${level} annotation matching ${messagePattern}`
        : `Expected a ${level} annotation matching ${messagePattern}. Got: ${JSON.stringify(received.annotations)}`,
    };
  },

  // ── ActionMock matchers ───────────────────────────────────────────────────

  toHaveBeenCalled(received: unknown) {
    if (!isActionMock(received)) {
      return { pass: false, message: () => 'Expected an ActionMock' };
    }
    const pass = received.called;
    return {
      pass,
      message: () => pass
        ? 'Expected mock NOT to have been called'
        : 'Expected mock to have been called but it was not',
    };
  },

  toHaveBeenCalledTimes(received: unknown, times: number) {
    if (!isActionMock(received)) {
      return { pass: false, message: () => 'Expected an ActionMock' };
    }
    const pass = received.callCount === times;
    return {
      pass,
      message: () => pass
        ? `Expected mock NOT to have been called ${times} time(s)`
        : `Expected mock to have been called ${times} time(s) but was called ${received.callCount} time(s)`,
    };
  },

  toHaveBeenCalledWith(received: unknown, expectedWith: Record<string, string>) {
    if (!isActionMock(received)) {
      return { pass: false, message: () => 'Expected an ActionMock' };
    }
    const pass = received.calls.some(c => {
      return Object.entries(expectedWith).every(([k, v]) => c.with[k] === v);
    });
    const actualCalls = received.calls.map(c => JSON.stringify(c.with)).join('\n  ');
    return {
      pass,
      message: () => pass
        ? `Expected mock NOT to have been called with ${JSON.stringify(expectedWith)}`
        : `Expected mock to have been called with ${JSON.stringify(expectedWith)}.\nActual calls:\n  ${actualCalls}`,
    };
  },

  // ── WorkflowResult matchers ───────────────────────────────────────────────

  toHaveRunJob(received: unknown, jobId: string) {
    if (!isWorkflowResult(received)) {
      return { pass: false, message: () => 'Expected a WorkflowResult' };
    }
    const job = received.job(jobId);
    const pass = job !== undefined && job.conclusion !== 'skipped';
    return {
      pass,
      message: () => pass
        ? `Expected job '${jobId}' NOT to have run`
        : `Expected job '${jobId}' to have run`,
    };
  },

  toHaveJobConclusion(received: unknown, jobId: string, expected: string) {
    if (!isWorkflowResult(received)) {
      return { pass: false, message: () => 'Expected a WorkflowResult' };
    }
    const job = received.job(jobId);
    const pass = job !== undefined && job.conclusion === expected;
    return {
      pass,
      message: () => pass
        ? `Expected job '${jobId}' NOT to have conclusion '${expected}'`
        : job === undefined
          ? `Expected job '${jobId}' to exist but it was not found`
          : `Expected job '${jobId}' conclusion to be '${expected}' but was '${job.conclusion}'`,
    };
  },

  toHaveJobOutput(received: unknown, jobId: string, key: string, expected: string) {
    if (!isWorkflowResult(received)) {
      return { pass: false, message: () => 'Expected a WorkflowResult' };
    }
    const job = received.job(jobId);
    const actual = job?.outputs[key];
    const pass = actual === expected;
    return {
      pass,
      message: () => pass
        ? `Expected job '${jobId}' output '${key}' NOT to equal '${expected}'`
        : job === undefined
          ? `Expected job '${jobId}' to exist but it was not found`
          : `Expected job '${jobId}' output '${key}' to equal '${expected}' but was '${actual}'`,
    };
  },
});

// TypeScript augmentation for Vitest's expect.
declare module 'vitest' {
  interface Assertion<T> {
    toHaveSucceeded(): void;
    toHaveFailed(): void;
    toHaveRunStep(stepId: string): void;
    toHaveSkippedStep(stepId: string): void;
    toHaveStepConclusion(stepId: string, conclusion: string): void;
    toHaveOutput(key: string, value?: string): void;
    toHaveStepOutput(stepId: string, key: string, value: string): void;
    toHaveAnnotation(level: string, message: string | RegExp): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(times: number): void;
    toHaveBeenCalledWith(expectedWith: Record<string, string>): void;
    toHaveRunJob(jobId: string): void;
    toHaveJobConclusion(jobId: string, conclusion: string): void;
    toHaveJobOutput(jobId: string, key: string, value: string): void;
  }
}
