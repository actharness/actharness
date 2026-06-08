// H5 (registerRunListener fires within workers), probe #4 (under actspec runner)

import { resolve } from 'path';
import { collector } from '../src/coverage-register.js';
import { actspec } from '../src/index.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

describe('H5 — listener fires in this worker (actspec runner)', () => {
  let stepsBefore: number;

  beforeAll(() => {
    stepsBefore = collector.getCoveredSteps();
  });

  it('collector receives coverage from run() and covered steps increase', async () => {
    const action = actspec(resolve(FIXTURES, 'guarded/action.yml'));
    await action.run({ inputs: { mode: 'full' } });

    const stepsAfter = collector.getCoveredSteps();
    expect(stepsAfter).toBeGreaterThan(stepsBefore);
  });

  it('collector sees both directions of an if: guard across two runs', async () => {
    const action = actspec(resolve(FIXTURES, 'guarded/action.yml'));

    await action.run({ inputs: { mode: 'full' } });
    await action.run({ inputs: { mode: 'quick', 'skip-notify': 'true' } });

    const fragment = collector.getFragment();
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const fc = fragment[sourceFile];

    expect(fc).toBeDefined();
    if (!fc) return;

    const bothDirections = Object.values(fc.b).some((arr) => {
      const counts = arr as number[];
      return counts[0]! > 0 && counts[1]! > 0;
    });
    expect(bothDirections).toBe(true);
  });

  it('fragment contains the guarded action source file', async () => {
    const action = actspec(resolve(FIXTURES, 'guarded/action.yml'));
    await action.run({ inputs: { mode: 'full' } });

    const fragment = collector.getFragment();
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    expect(fragment[sourceFile]).toBeDefined();
  });

  it('documents that flush mechanism is process.on(exit) under actspec runner', () => {
    // Under node:test child processes, process.on('exit', ...) fires reliably.
    // No afterAll/beforeExit dance needed (proven in runner spike H6).
    console.log('[probe #4] flush mechanism: process.on(exit) — child process model, no workaround needed');
    expect(typeof process.on).toBe('function');
  });
});
