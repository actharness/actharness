// Custom Vitest matchers for docker spike tests.

import { expect } from 'vitest';
import type { RunResult, ActionMock, Annotation } from 'workflow-spike';

function isRunResult(v: unknown): v is RunResult {
  return typeof v === 'object' && v !== null && 'conclusion' in v && 'steps' in v && 'outputs' in v;
}

function isActionMock(v: unknown): v is ActionMock {
  return typeof v === 'object' && v !== null && 'calls' in v && 'callCount' in v;
}

expect.extend({
  toHaveSucceeded(received: unknown) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const pass = received.conclusion === 'success';
    return { pass, message: () => pass ? `Expected result NOT to have succeeded` : `Expected result to have succeeded but conclusion was '${received.conclusion}'` };
  },

  toHaveFailed(received: unknown) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const pass = received.conclusion === 'failure';
    return { pass, message: () => pass ? `Expected result NOT to have failed` : `Expected result to have failed but conclusion was '${received.conclusion}'` };
  },

  toHaveRunStep(received: unknown, stepId: string) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const step = received.step(stepId);
    const pass = step !== undefined && step.ran && step.conclusion !== 'skipped';
    const ranIds = received.steps.filter(s => s.ran).map(s => s.id).join(', ');
    return { pass, message: () => pass ? `Expected step '${stepId}' NOT to have run` : `Expected step '${stepId}' to have run. Steps that ran: [${ranIds}]` };
  },

  toHaveStepConclusion(received: unknown, stepId: string, expected: string) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const step = received.step(stepId);
    const pass = step !== undefined && step.conclusion === expected;
    return { pass, message: () => pass ? `Expected step '${stepId}' NOT to have conclusion '${expected}'` : step === undefined ? `Expected step '${stepId}' to have conclusion '${expected}' but step was not found` : `Expected step '${stepId}' to have conclusion '${expected}' but was '${step.conclusion}'` };
  },

  toHaveOutput(received: unknown, key: string, expected?: string) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const actual = received.outputs[key];
    const pass = expected === undefined ? actual !== undefined : actual === expected;
    return { pass, message: () => pass ? `Expected output '${key}' NOT to ${expected === undefined ? 'be present' : `equal '${expected}'`}` : expected === undefined ? `Expected output '${key}' to be present. Available: [${Object.keys(received.outputs).join(', ')}]` : `Expected output '${key}' to equal '${expected}' but was '${actual}'` };
  },

  toHaveStepOutput(received: unknown, stepId: string, key: string, expected: string) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const step = received.step(stepId);
    const actual = step?.outputs[key];
    const pass = actual === expected;
    return { pass, message: () => pass ? `Expected step '${stepId}' output '${key}' NOT to equal '${expected}'` : step === undefined ? `Expected step '${stepId}' to exist but it was not found` : `Expected step '${stepId}' output '${key}' to equal '${expected}' but was '${actual}'` };
  },

  toHaveAnnotation(received: unknown, level: string, messagePattern: string | RegExp) {
    if (!isRunResult(received)) return { pass: false, message: () => 'Expected a RunResult' };
    const pass = received.annotations.some((a: Annotation) => {
      if (a.level !== level) return false;
      return typeof messagePattern === 'string' ? a.message.includes(messagePattern) : messagePattern.test(a.message);
    });
    return { pass, message: () => pass ? `Expected no ${level} annotation matching ${messagePattern}` : `Expected a ${level} annotation matching ${messagePattern}. Got: ${JSON.stringify(received.annotations)}` };
  },

  toHaveBeenCalled(received: unknown) {
    if (!isActionMock(received)) return { pass: false, message: () => 'Expected an ActionMock' };
    const pass = received.called;
    return { pass, message: () => pass ? 'Expected mock NOT to have been called' : 'Expected mock to have been called but it was not' };
  },

  toHaveBeenCalledTimes(received: unknown, times: number) {
    if (!isActionMock(received)) return { pass: false, message: () => 'Expected an ActionMock' };
    const pass = received.callCount === times;
    return { pass, message: () => pass ? `Expected mock NOT to have been called ${times} time(s)` : `Expected mock to have been called ${times} time(s) but was called ${received.callCount} time(s)` };
  },

  toHaveBeenCalledWith(received: unknown, expectedWith: Record<string, string>) {
    if (!isActionMock(received)) return { pass: false, message: () => 'Expected an ActionMock' };
    const pass = received.calls.some(c => Object.entries(expectedWith).every(([k, v]) => c.with[k] === v));
    const actualCalls = received.calls.map(c => JSON.stringify(c.with)).join('\n  ');
    return { pass, message: () => pass ? `Expected mock NOT to have been called with ${JSON.stringify(expectedWith)}` : `Expected mock to have been called with ${JSON.stringify(expectedWith)}.\nActual calls:\n  ${actualCalls}` };
  },
});

declare module 'vitest' {
  interface Assertion<T> {
    toHaveSucceeded(): void;
    toHaveFailed(): void;
    toHaveRunStep(stepId: string): void;
    toHaveStepConclusion(stepId: string, conclusion: string): void;
    toHaveOutput(key: string, value?: string): void;
    toHaveStepOutput(stepId: string, key: string, value: string): void;
    toHaveAnnotation(level: string, message: string | RegExp): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(times: number): void;
    toHaveBeenCalledWith(expectedWith: Record<string, string>): void;
  }
}
