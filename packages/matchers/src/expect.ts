// Own expect() — no Jest/Vitest peer dependency.
// Returns a chainable assertion handle.

import type { RunResult, ActionMock, StepResult } from '@actharness/types';
import { runResultMatchers } from './run-matchers.js';
import { mockMatchers } from './mock-matchers.js';
import { fail } from './errors.js';

// ── Assertion handle ──────────────────────────────────────────────────────────

export interface AssertionHandle<T> {
  readonly value: T;
  // negation
  readonly not: AssertionHandle<T>;
}

export interface RunResultAssertionHandle extends AssertionHandle<RunResult> {
  toHaveSucceeded(): RunResultAssertionHandle;
  toHaveFailed(): RunResultAssertionHandle;
  toHaveOutput(name: string, value: string): RunResultAssertionHandle;
  toHaveStep(id: string): RunResultAssertionHandle;
  toHaveStepSucceeded(id: string): RunResultAssertionHandle;
  toHaveStepFailed(id: string): RunResultAssertionHandle;
  toHaveStepSkipped(id: string): RunResultAssertionHandle;
  toHaveStepOutput(stepId: string, outputName: string, value: string): RunResultAssertionHandle;
  toHaveAnnotation(opts?: { level?: 'error' | 'warning' | 'notice' | 'debug'; message?: string | RegExp }): RunResultAssertionHandle;
  readonly not: RunResultAssertionHandle;
}

export interface StepResultAssertionHandle extends AssertionHandle<StepResult> {
  toHaveSucceeded(): StepResultAssertionHandle;
  toHaveFailed(): StepResultAssertionHandle;
  toHaveBeenSkipped(): StepResultAssertionHandle;
  toHaveOutput(name: string, value: string): StepResultAssertionHandle;
  toHaveAnnotation(opts?: { level?: 'error' | 'warning' | 'notice' | 'debug'; message?: string | RegExp }): StepResultAssertionHandle;
  toHaveStdoutContaining(substring: string): StepResultAssertionHandle;
  toHaveStderrContaining(substring: string): StepResultAssertionHandle;
  readonly not: StepResultAssertionHandle;
}

export interface MockAssertionHandle extends AssertionHandle<ActionMock> {
  toHaveBeenCalled(): MockAssertionHandle;
  toHaveBeenCalledTimes(n: number): MockAssertionHandle;
  toHaveBeenCalledWith(inputs: Record<string, string>): MockAssertionHandle;
  readonly not: MockAssertionHandle;
}

// ── expect() overloads ────────────────────────────────────────────────────────

export function expect(value: RunResult): RunResultAssertionHandle;
export function expect(value: StepResult | undefined): StepResultAssertionHandle;
export function expect(value: ActionMock): MockAssertionHandle;
export function expect(value: RunResult | StepResult | ActionMock | undefined): RunResultAssertionHandle | StepResultAssertionHandle | MockAssertionHandle;
export function expect(value: RunResult | StepResult | ActionMock | undefined): RunResultAssertionHandle | StepResultAssertionHandle | MockAssertionHandle {
  if (value === undefined) {
    return buildStepResultHandle(undefined, false);
  }
  if (isRunResult(value)) {
    return buildRunResultHandle(value, false);
  }
  if (isStepResult(value)) {
    return buildStepResultHandle(value, false);
  }
  if (isActionMock(value)) {
    return buildMockHandle(value, false);
  }
  throw new TypeError(`expect() received an unsupported value type`);
}

// ── Type guards ───────────────────────────────────────────────────────────────

function isRunResult(v: unknown): v is RunResult {
  return (
    v !== null &&
    typeof v === 'object' &&
    'conclusion' in v &&
    'outputs' in v &&
    'steps' in v &&
    typeof (v as RunResult).step === 'function'
  );
}

function isStepResult(v: unknown): v is StepResult {
  return (
    v !== null &&
    typeof v === 'object' &&
    'conclusion' in v &&
    'stdout' in v &&
    'stderr' in v &&
    'ran' in v &&
    !('step' in v)
  );
}

function isActionMock(v: unknown): v is ActionMock {
  return (
    v !== null &&
    typeof v === 'object' &&
    'calls' in v &&
    'called' in v &&
    'callCount' in v &&
    typeof (v as ActionMock).clear === 'function'
  );
}

// ── RunResult handle ──────────────────────────────────────────────────────────

function buildRunResultHandle(
  result: RunResult,
  negated: boolean,
): RunResultAssertionHandle {
  const handle: RunResultAssertionHandle = {
    value: result,
    get not() { return buildRunResultHandle(result, !negated); },

    toHaveSucceeded() {
      runResultMatchers.toHaveSucceeded(result, negated);
      return handle;
    },
    toHaveFailed() {
      runResultMatchers.toHaveFailed(result, negated);
      return handle;
    },
    toHaveOutput(name, value) {
      runResultMatchers.toHaveOutput(result, name, value, negated);
      return handle;
    },
    toHaveStep(id) {
      runResultMatchers.toHaveStep(result, id, negated);
      return handle;
    },
    toHaveStepSucceeded(id) {
      runResultMatchers.toHaveStepConclusion(result, id, 'success', negated);
      return handle;
    },
    toHaveStepFailed(id) {
      runResultMatchers.toHaveStepConclusion(result, id, 'failure', negated);
      return handle;
    },
    toHaveStepSkipped(id) {
      runResultMatchers.toHaveStepConclusion(result, id, 'skipped', negated);
      return handle;
    },
    toHaveStepOutput(stepId, outputName, value) {
      runResultMatchers.toHaveStepOutput(result, stepId, outputName, value, negated);
      return handle;
    },
    toHaveAnnotation(opts) {
      runResultMatchers.toHaveAnnotation(result, opts, negated);
      return handle;
    },
  };
  return handle;
}

// ── StepResult handle ─────────────────────────────────────────────────────────

function buildStepResultHandle(
  step: StepResult | undefined,
  negated: boolean,
): StepResultAssertionHandle {
  const handle: StepResultAssertionHandle = {
    value: step as StepResult,
    get not() { return buildStepResultHandle(step, !negated); },

    toHaveSucceeded() {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const ok = step.conclusion === 'success';
      if (negated ? ok : !ok) {
        fail(
          negated
            ? `Expected step '${step.id}' to NOT have succeeded, but conclusion was 'success'.`
            : `Expected step '${step.id}' to have succeeded, but conclusion was '${step.conclusion}'.`,
        );
      }
      return handle;
    },

    toHaveFailed() {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const ok = step.conclusion === 'failure';
      if (negated ? ok : !ok) {
        fail(
          negated
            ? `Expected step '${step.id}' to NOT have failed, but conclusion was 'failure'.`
            : `Expected step '${step.id}' to have failed, but conclusion was '${step.conclusion}'.`,
        );
      }
      return handle;
    },

    toHaveBeenSkipped() {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const ok = step.conclusion === 'skipped';
      if (negated ? ok : !ok) {
        fail(
          negated
            ? `Expected step '${step.id}' to NOT have been skipped, but conclusion was 'skipped'.`
            : `Expected step '${step.id}' to have been skipped, but conclusion was '${step.conclusion}'.`,
        );
      }
      return handle;
    },

    toHaveOutput(name, value) {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const actual = step.outputs[name];
      const ok = actual === value;
      if (negated ? ok : !ok) {
        fail(
          negated
            ? `Expected step '${step.id}' output '${name}' to NOT equal ${JSON.stringify(value)}.`
            : `Expected step '${step.id}' output '${name}' to equal ${JSON.stringify(value)}, but got ${actual === undefined ? 'undefined' : JSON.stringify(actual)}.`,
        );
      }
      return handle;
    },

    toHaveAnnotation(opts) {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const found = step.annotations.some((ann) => {
        if (opts?.level && ann.level !== opts.level) return false;
        if (opts?.message) {
          if (typeof opts.message === 'string') return ann.message.includes(opts.message);
          return opts.message.test(ann.message);
        }
        return true;
      });
      const desc = opts ? ` matching ${JSON.stringify(opts)}` : '';
      if (negated) {
        if (found) fail(`Expected step '${step.id}' to NOT have an annotation${desc}, but one was found.`);
      } else {
        if (!found) {
          const available = step.annotations.map((a) => `  ${a.level}: ${a.message}`).join('\n');
          fail(
            `Expected step '${step.id}' to have an annotation${desc}.\n` +
            `Annotations found:\n${available || '  (none)'}`,
          );
        }
      }
      return handle;
    },

    toHaveStdoutContaining(substring) {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const contains = step.stdout.includes(substring);
      if (negated ? contains : !contains) {
        throw new Error(
          negated
            ? `Expected stdout not to contain ${JSON.stringify(substring)}, but it did.\nstdout: ${JSON.stringify(step.stdout)}`
            : `Expected stdout to contain ${JSON.stringify(substring)}.\nstdout: ${JSON.stringify(step.stdout)}`,
        );
      }
      return handle;
    },

    toHaveStderrContaining(substring) {
      if (step === undefined) throw new Error('Expected step to exist, but step was not found');
      const contains = step.stderr.includes(substring);
      if (negated ? contains : !contains) {
        throw new Error(
          negated
            ? `Expected stderr not to contain ${JSON.stringify(substring)}, but it did.\nstderr: ${JSON.stringify(step.stderr)}`
            : `Expected stderr to contain ${JSON.stringify(substring)}.\nstderr: ${JSON.stringify(step.stderr)}`,
        );
      }
      return handle;
    },
  };
  return handle;
}

// ── Mock handle ───────────────────────────────────────────────────────────────

function buildMockHandle(mock: ActionMock, negated: boolean): MockAssertionHandle {
  const handle: MockAssertionHandle = {
    value: mock,
    get not() { return buildMockHandle(mock, !negated); },

    toHaveBeenCalled() {
      mockMatchers.toHaveBeenCalled(mock, negated);
      return handle;
    },
    toHaveBeenCalledTimes(n) {
      mockMatchers.toHaveBeenCalledTimes(mock, n, negated);
      return handle;
    },
    toHaveBeenCalledWith(inputs) {
      mockMatchers.toHaveBeenCalledWith(mock, inputs, negated);
      return handle;
    },
  };
  return handle;
}
