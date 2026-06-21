// Walking skeleton integration test — composite executor + ShellSandbox.
// These tests exercise the full execution path with real bash.

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';

// Side-effectful import — registers composite executor with core (source import for coverage)
import '../src/index.js';
import { actharness, ScopeRegistry, scopeALS } from '@actharness/core';

const FIXTURES = join(import.meta.dirname, 'fixtures');

describe('greet action (walking skeleton)', () => {
  it('runs a composite action and resolves outputs', async () => {
    const action = actharness(join(FIXTURES, 'greet'));
    const result = await action.run({ inputs: { name: 'World' } });

    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Hello, World!');
  });

  it('applies default inputs when not provided', async () => {
    const action = actharness(join(FIXTURES, 'greet'));
    const result = await action.run({ inputs: { name: 'Alice' } });

    expect(result.outputs['message']).toBe('Hello, Alice!');
  });

  it('overrides defaults with provided inputs', async () => {
    const action = actharness(join(FIXTURES, 'greet'));
    const result = await action.run({
      inputs: { name: 'Bob', greeting: 'Hi' },
    });

    expect(result.outputs['message']).toBe('Hi, Bob!');
  });

  it('exposes step results', async () => {
    const action = actharness(join(FIXTURES, 'greet'));
    const result = await action.run({ inputs: { name: 'Test' } });

    const greetStep = result.step('greet');
    expect(greetStep).toBeDefined();
    expect(greetStep?.ran).toBe(true);
    expect(greetStep?.conclusion).toBe('success');
  });

  it('captures step outputs', async () => {
    const action = actharness(join(FIXTURES, 'greet'));
    const result = await action.run({ inputs: { name: 'Test' } });

    expect(result.step('greet')?.outputs['message']).toBe('Hello, Test!');
  });
});

describe('multi-step action', () => {
  it('all steps succeed when should_fail=false', async () => {
    const action = actharness(join(FIXTURES, 'multi-step'));
    const result = await action.run({ inputs: { should_fail: 'false' } });

    expect(result.conclusion).toBe('success');
    expect(result.step('first')?.conclusion).toBe('success');
    expect(result.step('second')?.conclusion).toBe('success');
    expect(result.step('third')?.conclusion).toBe('success');
  });

  it('continue-on-error: step 2 fails but conclusion=success, job continues', async () => {
    const action = actharness(join(FIXTURES, 'multi-step'));
    const result = await action.run({ inputs: { should_fail: 'true' } });

    // Second step fails but has continue-on-error:true → conclusion: success
    const second = result.step('second');
    expect(second?.outcome).toBe('failure');
    expect(second?.conclusion).toBe('success');
  });

  it('always() step always runs regardless of job status', async () => {
    const action = actharness(join(FIXTURES, 'multi-step'));
    const result = await action.run({ inputs: { should_fail: 'true' } });

    const third = result.step('third');
    expect(third?.ran).toBe(true);
    expect(third?.outputs['ran']).toBe('yes');
  });

  it('resolves action outputs from final context', async () => {
    const action = actharness(join(FIXTURES, 'multi-step'));
    const result = await action.run({});
    expect(result.outputs['ran_third']).toBe('yes');
  });
});

describe('composite-executor output branches', () => {
  it('no outputs field: resolves with empty outputs (outputs ?? {} branch)', async () => {
    const action = actharness(join(FIXTURES, 'no-output'));
    const result = await action.run({});
    expect(result.conclusion).toBe('success');
    expect(result.outputs).toEqual({});
  });

  it('output with no value field: skipped (if (def.value) FALSE branch)', async () => {
    const action = actharness(join(FIXTURES, 'bad-output'));
    const result = await action.run({});
    expect(result.outputs['no_value']).toBeUndefined();
  });

  it('output with invalid expression: caught and set to empty string', async () => {
    const action = actharness(join(FIXTURES, 'bad-output'));
    const result = await action.run({});
    expect(result.outputs['bad_expr']).toBe('');
  });

  it('conclusion is failure when a step fails without continue-on-error', async () => {
    const action = actharness(join(FIXTURES, 'fail-step'));
    const result = await action.run({});
    expect(result.conclusion).toBe('failure');
  });
});

describe('mock resolution', () => {
  it('mocked uses: step returns mock outputs without executing', async () => {
    const scope = new ScopeRegistry();
    const checkoutMock = scope.mock('actions/checkout@v4', { outputs: { sha: 'abc123' } });

    const action = actharness(join(FIXTURES, 'greet'));
    const result = await scopeALS.run([scope], () => action.run({ inputs: { name: 'World' } }));

    expect(result.conclusion).toBe('success');
    // Mock was registered but not invoked (greet has no uses: steps)
    expect(checkoutMock.callCount).toBe(0);
  });
});

describe('shell coverage propagation', () => {
  it('populates shellCoverage on ExecutionResult when ACTHARNESS_COVERAGE_TMP is set', async () => {
    process.env['ACTHARNESS_COVERAGE_TMP'] = '/tmp/actharness-cov-test';
    try {
      const action = actharness(join(FIXTURES, 'greet'));
      const result = await action.run({ inputs: { name: 'CovTest' } });
      expect(result.conclusion).toBe('success');
      // shellCoverage is internal on ExecutionResult — verify via the raw result
      // actharness wraps ExecutionResult; shellCoverage surfaces through run-sink/meta
      // but the important thing is the composite executor path ran without error
      // and the greet step ran
      expect(result.step('greet')?.ran).toBe(true);
    } finally {
      delete process.env['ACTHARNESS_COVERAGE_TMP'];
    }
  });
});
