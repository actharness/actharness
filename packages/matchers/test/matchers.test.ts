import { describe, it, expect as vitestExpect } from 'vitest';
import type { RunResult, ActionMock, ActionMockCall, StepResult } from '@actharness/types';
import { expect, MatchError } from '../src/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRunResult(overrides: Partial<RunResult> = {}): RunResult {
  const steps = overrides.steps ?? [];
  return {
    conclusion: 'success',
    outputs: {},
    steps,
    step: (id: string) => steps.find((s) => s.id === id),
    env: {},
    annotations: [],
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

function makeMock(overrides: Partial<ActionMock> = {}): ActionMock {
  const calls: ActionMockCall[] = overrides.calls ?? [];
  return {
    calls,
    called: calls.length > 0,
    callCount: calls.length,
    mockOutputs: () => mockBase,
    mockConclusion: () => mockBase,
    mockImplementation: () => mockBase,
    mockImplementationOnce: () => mockBase,
    clear: () => {},
    ...overrides,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockBase = calls as any;
}

function makeStep(
  id: string,
  conclusion: 'success' | 'failure' | 'skipped' = 'success',
  outputs: Record<string, string> = {},
) {
  return {
    id,
    name: id,
    phase: 'main' as const,
    ran: conclusion !== 'skipped',
    outcome: conclusion,
    conclusion,
    outputs,
    annotations: [],
    stdout: '',
    stderr: '',
  };
}

// ── RunResult matchers ────────────────────────────────────────────────────────

describe('expect(RunResult).toHaveSucceeded', () => {
  it('passes when conclusion is success', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'success' })).toHaveSucceeded();
    }).not.toThrow();
  });

  it('throws MatchError when conclusion is failure', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'failure' })).toHaveSucceeded();
    }).toThrow(MatchError);
  });

  it('includes failing step ids in error when steps are present', () => {
    vitestExpect(() => {
      expect(makeRunResult({
        conclusion: 'failure',
        steps: [makeStep('build', 'failure')],
      })).toHaveSucceeded();
    }).toThrow(/build/);
  });

  it('.not passes when conclusion is failure', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'failure' })).not.toHaveSucceeded();
    }).not.toThrow();
  });

  it('.not throws when conclusion is success', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'success' })).not.toHaveSucceeded();
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveFailed', () => {
  it('passes when conclusion is failure', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'failure' })).toHaveFailed();
    }).not.toThrow();
  });

  it('throws when conclusion is success', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'success' })).toHaveFailed();
    }).toThrow(MatchError);
  });

  it('.not passes when conclusion is success', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'success' })).not.toHaveFailed();
    }).not.toThrow();
  });

  it('.not throws when conclusion is failure', () => {
    vitestExpect(() => {
      expect(makeRunResult({ conclusion: 'failure' })).not.toHaveFailed();
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveOutput', () => {
  it('passes when output matches', () => {
    vitestExpect(() => {
      expect(makeRunResult({ outputs: { name: 'world' } }))
        .toHaveOutput('name', 'world');
    }).not.toThrow();
  });

  it('throws when output does not match', () => {
    vitestExpect(() => {
      expect(makeRunResult({ outputs: { name: 'alice' } }))
        .toHaveOutput('name', 'world');
    }).toThrow(MatchError);
  });

  it('throws when output is missing', () => {
    vitestExpect(() => {
      expect(makeRunResult({ outputs: {} })).toHaveOutput('name', 'world');
    }).toThrow(MatchError);
  });

  it('.not passes when output does not match', () => {
    vitestExpect(() => {
      expect(makeRunResult({ outputs: { name: 'alice' } }))
        .not.toHaveOutput('name', 'world');
    }).not.toThrow();
  });

  it('.not throws when output matches', () => {
    vitestExpect(() => {
      expect(makeRunResult({ outputs: { name: 'world' } }))
        .not.toHaveOutput('name', 'world');
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveStep', () => {
  it('passes when step exists', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('build')] })).toHaveStep('build');
    }).not.toThrow();
  });

  it('throws when step is missing', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [] })).toHaveStep('missing');
    }).toThrow(MatchError);
  });

  it('includes existing step ids in error when step is missing', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('build')] })).toHaveStep('missing');
    }).toThrow(/build/);
  });

  it('.not passes when step is missing', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [] })).not.toHaveStep('missing');
    }).not.toThrow();
  });

  it('.not throws when step exists', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('build')] })).not.toHaveStep('build');
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveStepSucceeded', () => {
  it('passes for successful step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success')] }))
        .toHaveStepSucceeded('s1');
    }).not.toThrow();
  });

  it('throws for failed step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'failure')] }))
        .toHaveStepSucceeded('s1');
    }).toThrow(MatchError);
  });

  it('throws for missing step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [] })).toHaveStepSucceeded('s1');
    }).toThrow(MatchError);
  });

  it('.not throws when step is successful', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success')] }))
        .not.toHaveStepSucceeded('s1');
    }).toThrow(MatchError);
  });

  it('.not passes when step did not succeed', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'failure')] }))
        .not.toHaveStepSucceeded('s1');
    }).not.toThrow();
  });
});

describe('expect(RunResult).toHaveStepFailed', () => {
  it('passes for failed step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'failure')] }))
        .toHaveStepFailed('s1');
    }).not.toThrow();
  });

  it('throws for successful step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success')] }))
        .toHaveStepFailed('s1');
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveStepSkipped', () => {
  it('passes for skipped step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'skipped')] }))
        .toHaveStepSkipped('s1');
    }).not.toThrow();
  });

  it('throws for non-skipped step', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success')] }))
        .toHaveStepSkipped('s1');
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveStepOutput', () => {
  it('passes when step output matches', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success', { result: '42' })] }))
        .toHaveStepOutput('s1', 'result', '42');
    }).not.toThrow();
  });

  it('throws when step output does not match', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success', { result: '99' })] }))
        .toHaveStepOutput('s1', 'result', '42');
    }).toThrow(MatchError);
  });

  it('throws when step is missing', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [] })).toHaveStepOutput('s1', 'result', '42');
    }).toThrow(MatchError);
  });

  it('shows undefined in error when output key absent', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success', {})] }))
        .toHaveStepOutput('s1', 'result', '42');
    }).toThrow(/undefined/);
  });

  it('.not passes when output differs', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success', { result: '0' })] }))
        .not.toHaveStepOutput('s1', 'result', '42');
    }).not.toThrow();
  });

  it('.not throws when output matches', () => {
    vitestExpect(() => {
      expect(makeRunResult({ steps: [makeStep('s1', 'success', { result: '42' })] }))
        .not.toHaveStepOutput('s1', 'result', '42');
    }).toThrow(MatchError);
  });
});

describe('expect(RunResult).toHaveAnnotation', () => {
  const resultWithAnnotation = makeRunResult({
    annotations: [
      { level: 'error', message: 'Something went wrong', file: 'src/x.ts', line: 10 },
      { level: 'warning', message: 'Watch out' },
    ],
  });

  it('passes when any annotation exists (no opts)', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).toHaveAnnotation();
    }).not.toThrow();
  });

  it('passes when annotation with level matches', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).toHaveAnnotation({ level: 'error' });
    }).not.toThrow();
  });

  it('passes when annotation message matches string', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).toHaveAnnotation({ message: 'Something' });
    }).not.toThrow();
  });

  it('passes when annotation message matches regex', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).toHaveAnnotation({ message: /went wrong/ });
    }).not.toThrow();
  });

  it('throws when no annotation exists', () => {
    vitestExpect(() => {
      expect(makeRunResult({ annotations: [] })).toHaveAnnotation();
    }).toThrow(MatchError);
  });

  it('throws when level does not match', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).toHaveAnnotation({ level: 'notice' });
    }).toThrow(MatchError);
  });

  it('.not passes when no annotation', () => {
    vitestExpect(() => {
      expect(makeRunResult({ annotations: [] })).not.toHaveAnnotation();
    }).not.toThrow();
  });

  it('.not throws when annotation exists', () => {
    vitestExpect(() => {
      expect(resultWithAnnotation).not.toHaveAnnotation();
    }).toThrow(MatchError);
  });
});

describe('chaining matchers', () => {
  it('can chain multiple assertions', () => {
    vitestExpect(() => {
      expect(
        makeRunResult({
          conclusion: 'success',
          outputs: { out: 'val' },
          steps: [makeStep('s1', 'success')],
        }),
      )
        .toHaveSucceeded()
        .toHaveOutput('out', 'val')
        .toHaveStepSucceeded('s1');
    }).not.toThrow();
  });
});

// ── ActionMock matchers ───────────────────────────────────────────────────────

describe('expect(ActionMock).toHaveBeenCalled', () => {
  it('passes when mock was called', () => {
    const mock = makeMock({
      calls: [{ with: {}, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() => expect(mock).toHaveBeenCalled()).not.toThrow();
  });

  it('throws when mock was not called', () => {
    const mock = makeMock({ calls: [], called: false, callCount: 0 });
    vitestExpect(() => expect(mock).toHaveBeenCalled()).toThrow(MatchError);
  });

  it('.not passes when mock was not called', () => {
    const mock = makeMock({ calls: [], called: false, callCount: 0 });
    vitestExpect(() => expect(mock).not.toHaveBeenCalled()).not.toThrow();
  });

  it('.not throws when mock was called', () => {
    const mock = makeMock({
      calls: [{ with: {}, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() => expect(mock).not.toHaveBeenCalled()).toThrow(MatchError);
  });
});

describe('expect(ActionMock).toHaveBeenCalledTimes', () => {
  it('passes when call count matches', () => {
    const mock = makeMock({
      calls: [{ with: {}, env: {}, outputs: {} }, { with: {}, env: {}, outputs: {} }],
      called: true,
      callCount: 2,
    });
    vitestExpect(() => expect(mock).toHaveBeenCalledTimes(2)).not.toThrow();
  });

  it('throws when call count differs', () => {
    const mock = makeMock({ calls: [], called: false, callCount: 0 });
    vitestExpect(() => expect(mock).toHaveBeenCalledTimes(1)).toThrow(MatchError);
  });

  it('.not passes when count differs', () => {
    const mock = makeMock({ calls: [], called: false, callCount: 0 });
    vitestExpect(() => expect(mock).not.toHaveBeenCalledTimes(1)).not.toThrow();
  });

  it('.not throws when count matches', () => {
    const mock = makeMock({
      calls: [{ with: {}, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() => expect(mock).not.toHaveBeenCalledTimes(1)).toThrow(MatchError);
  });
});

describe('expect(ActionMock).toHaveBeenCalledWith', () => {
  it('passes when inputs match in any call', () => {
    const mock = makeMock({
      calls: [
        { with: { token: 'abc', depth: '1' }, env: {}, outputs: {} },
      ],
      called: true,
      callCount: 1,
    });
    vitestExpect(() =>
      expect(mock).toHaveBeenCalledWith({ token: 'abc' }),
    ).not.toThrow();
  });

  it('throws when no call matches', () => {
    const mock = makeMock({
      calls: [{ with: { token: 'xyz' }, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() =>
      expect(mock).toHaveBeenCalledWith({ token: 'abc' }),
    ).toThrow(MatchError);
  });

  it('shows (none) in error when mock has no calls', () => {
    const mock = makeMock({ calls: [], called: false, callCount: 0 });
    vitestExpect(() =>
      expect(mock).toHaveBeenCalledWith({ token: 'abc' }),
    ).toThrow(/\(none\)/);
  });

  it('.not passes when no call matches', () => {
    const mock = makeMock({
      calls: [{ with: { token: 'xyz' }, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() =>
      expect(mock).not.toHaveBeenCalledWith({ token: 'abc' }),
    ).not.toThrow();
  });

  it('.not throws when a call matches', () => {
    const mock = makeMock({
      calls: [{ with: { token: 'abc' }, env: {}, outputs: {} }],
      called: true,
      callCount: 1,
    });
    vitestExpect(() =>
      expect(mock).not.toHaveBeenCalledWith({ token: 'abc' }),
    ).toThrow(MatchError);
  });
});

// ── StepResult matchers ───────────────────────────────────────────────────────

function makeStepResult(overrides: Partial<StepResult> = {}): StepResult {
  return {
    id: 'step1',
    name: 'step1',
    phase: 'main',
    ran: true,
    outcome: 'success',
    conclusion: 'success',
    outputs: {},
    annotations: [],
    stdout: '',
    stderr: '',
    ...overrides,
  };
}

describe('expect(StepResult).toHaveAnnotation', () => {
  function makeAnnotatedStep() {
    return makeStepResult({
      annotations: [
        { level: 'notice', message: 'deployment started' },
        { level: 'warning', message: 'cache miss' },
      ],
    });
  }

  it('passes when any annotation exists (no opts)', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).toHaveAnnotation(),
    ).not.toThrow();
  });

  it('passes when annotation with level matches', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).toHaveAnnotation({ level: 'notice' }),
    ).not.toThrow();
  });

  it('passes when annotation message matches string', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).toHaveAnnotation({ message: 'deployment' }),
    ).not.toThrow();
  });

  it('passes when annotation message matches regex', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).toHaveAnnotation({ message: /cache.*miss/ }),
    ).not.toThrow();
  });

  it('throws when no annotation exists', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', annotations: [] })).toHaveAnnotation(),
    ).toThrow(MatchError);
  });

  it('error message includes step id', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', annotations: [] })).toHaveAnnotation(),
    ).toThrow(/build/);
  });

  it('throws when level does not match', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).toHaveAnnotation({ level: 'error' }),
    ).toThrow(MatchError);
  });

  it('.not passes when no annotation', () => {
    vitestExpect(() =>
      expect(makeStepResult({ annotations: [] })).not.toHaveAnnotation(),
    ).not.toThrow();
  });

  it('.not throws when annotation exists', () => {
    vitestExpect(() =>
      expect(makeAnnotatedStep()).not.toHaveAnnotation(),
    ).toThrow(MatchError);
  });
});

describe('expect(StepResult).toHaveStdoutContaining', () => {
  it('passes when stdout contains substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stdout: 'hello world' })).toHaveStdoutContaining('world'),
    ).not.toThrow();
  });

  it('throws when stdout does not contain substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stdout: 'hello' })).toHaveStdoutContaining('world'),
    ).toThrow();
  });

  it('.not passes when stdout does not contain substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stdout: 'hello' })).not.toHaveStdoutContaining('world'),
    ).not.toThrow();
  });

  it('.not throws when stdout contains substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stdout: 'hello world' })).not.toHaveStdoutContaining('world'),
    ).toThrow();
  });
});

describe('expect(StepResult).toHaveStderrContaining', () => {
  it('passes when stderr contains substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stderr: 'error: something' })).toHaveStderrContaining('error'),
    ).not.toThrow();
  });

  it('throws when stderr does not contain substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stderr: '' })).toHaveStderrContaining('error'),
    ).toThrow();
  });

  it('.not passes when stderr does not contain substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stderr: '' })).not.toHaveStderrContaining('error'),
    ).not.toThrow();
  });

  it('.not throws when stderr contains substring', () => {
    vitestExpect(() =>
      expect(makeStepResult({ stderr: 'error: something' })).not.toHaveStderrContaining('error'),
    ).toThrow();
  });
});

describe('expect(StepResult).toHaveSucceeded', () => {
  it('passes when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'success' })).toHaveSucceeded(),
    ).not.toThrow();
  });

  it('throws when conclusion is failure', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', conclusion: 'failure' })).toHaveSucceeded(),
    ).toThrow(MatchError);
  });

  it('error message includes step id and actual conclusion', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', conclusion: 'failure' })).toHaveSucceeded(),
    ).toThrow(/build/);
  });

  it('.not passes when conclusion is failure', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'failure' })).not.toHaveSucceeded(),
    ).not.toThrow();
  });

  it('.not throws when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'success' })).not.toHaveSucceeded(),
    ).toThrow(MatchError);
  });
});

describe('expect(StepResult).toHaveFailed', () => {
  it('passes when conclusion is failure', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'failure' })).toHaveFailed(),
    ).not.toThrow();
  });

  it('throws when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'deploy', conclusion: 'success' })).toHaveFailed(),
    ).toThrow(MatchError);
  });

  it('error message includes step id', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'deploy', conclusion: 'success' })).toHaveFailed(),
    ).toThrow(/deploy/);
  });

  it('.not passes when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'success' })).not.toHaveFailed(),
    ).not.toThrow();
  });

  it('.not throws when conclusion is failure', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'failure' })).not.toHaveFailed(),
    ).toThrow(MatchError);
  });
});

describe('expect(StepResult).toHaveBeenSkipped', () => {
  it('passes when conclusion is skipped', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'skipped' })).toHaveBeenSkipped(),
    ).not.toThrow();
  });

  it('throws when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'deploy', conclusion: 'success' })).toHaveBeenSkipped(),
    ).toThrow(MatchError);
  });

  it('error message includes step id', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'deploy', conclusion: 'success' })).toHaveBeenSkipped(),
    ).toThrow(/deploy/);
  });

  it('.not passes when conclusion is success', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'success' })).not.toHaveBeenSkipped(),
    ).not.toThrow();
  });

  it('.not throws when conclusion is skipped', () => {
    vitestExpect(() =>
      expect(makeStepResult({ conclusion: 'skipped' })).not.toHaveBeenSkipped(),
    ).toThrow(MatchError);
  });
});

describe('expect(StepResult).toHaveOutput', () => {
  it('passes when output matches', () => {
    vitestExpect(() =>
      expect(makeStepResult({ outputs: { sha: 'abc1234' } })).toHaveOutput('sha', 'abc1234'),
    ).not.toThrow();
  });

  it('throws when output does not match', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', outputs: { sha: 'xyz' } })).toHaveOutput('sha', 'abc1234'),
    ).toThrow(MatchError);
  });

  it('error message includes step id, output name, and actual value', () => {
    vitestExpect(() =>
      expect(makeStepResult({ id: 'build', outputs: { sha: 'xyz' } })).toHaveOutput('sha', 'abc1234'),
    ).toThrow(/build/);
  });

  it('shows undefined in error when output key is absent', () => {
    vitestExpect(() =>
      expect(makeStepResult({ outputs: {} })).toHaveOutput('sha', 'abc1234'),
    ).toThrow(/undefined/);
  });

  it('.not passes when output does not match', () => {
    vitestExpect(() =>
      expect(makeStepResult({ outputs: { sha: 'other' } })).not.toHaveOutput('sha', 'abc1234'),
    ).not.toThrow();
  });

  it('.not throws when output matches', () => {
    vitestExpect(() =>
      expect(makeStepResult({ outputs: { sha: 'abc1234' } })).not.toHaveOutput('sha', 'abc1234'),
    ).toThrow(MatchError);
  });
});

// ── expect(undefined) — step not found ───────────────────────────────────────

describe('expect(undefined) step not found', () => {
  it('toHaveSucceeded throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveSucceeded(),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveFailed throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveFailed(),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveBeenSkipped throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveBeenSkipped(),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveOutput throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveOutput('sha', 'abc1234'),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveAnnotation throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveAnnotation(),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveStdoutContaining throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveStdoutContaining('anything'),
    ).toThrow('Expected step to exist, but step was not found');
  });

  it('toHaveStderrContaining throws when step is undefined', () => {
    vitestExpect(() =>
      expect(undefined).toHaveStderrContaining('anything'),
    ).toThrow('Expected step to exist, but step was not found');
  });
});

// ── expect() type guard ───────────────────────────────────────────────────────

describe('expect() type guard', () => {
  it('throws TypeError for unsupported values', () => {
    vitestExpect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (expect as any)('just a string');
    }).toThrow(TypeError);
  });
});
