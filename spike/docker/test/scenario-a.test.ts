// Scenario A — Mock backend (no daemon required). Validates H7.
// Tests that docker actions are intercepted by the mock registry without invoking docker,
// and that docker uses: steps in composites work identically to any other uses: mock.

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures/scenario-a');

describe('Scenario A — Mock backend (H7)', () => {
  test('docker action is mocked by default — no daemon required', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'));
    action.mock(join(FIXTURES, 'action.yml'), { outputs: { result: 'mocked' } });
    const result = await action.run({ inputs: { message: 'hello' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('result', 'mocked');
  });

  test('unmocked docker action in mock mode returns stub success', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'));
    const result = await action.run({ inputs: { message: 'hello' } });
    expect(result).toHaveSucceeded();
  });

  test('docker uses: in a composite is intercepted the same way as any uses:', async () => {
    const composite = actspec(join(FIXTURES, 'composite/action.yml'));
    composite.mock('./docker-child', { outputs: { scanned: 'clean' } });
    const result = await composite.run({ inputs: { path: './src' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveStepOutput('scan', 'scanned', 'clean');
  });

  test('mock call is recorded correctly', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'));
    const m = action.mock(join(FIXTURES, 'action.yml'), { outputs: { result: 'recorded' } });
    await action.run({ inputs: { message: 'test' } });
    expect(m).toHaveBeenCalled();
    expect(m).toHaveBeenCalledTimes(1);
  });
});
