// Tests for fixtures/setup/action.yml — Composite with two uses: children.
// Friction probes: #1 (mock type-agnostic), #3 (stdout), #4 (with: shape), #7 (invocation order), #8 (state isolation).
// Validates H1 (no type knowledge in mock), H2 (RunResult shape), H3 (matchers cover vocabulary).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';
import type { Action } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/setup');

describe('composite-setup', () => {
  let action: Action;

  beforeEach(() => {
    // New Action handle per test — registry is per-instance (no cross-test contamination).
    action = actspec(FIXTURE);
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  test('succeeds and returns cache-hit + node-version outputs from mocks', async () => {
    // H1: mock() call is identical regardless of whether the child is composite or node.
    // Probe #1: no type: parameter needed.
    action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'true' } });
    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    const result = await action.run({ inputs: { 'node-version': '20' } });

    expect(result).toHaveSucceeded();
    // H2: outputs arrive in result.outputs regardless of how the child set them.
    expect(result).toHaveOutput('cache-hit', 'true');
    expect(result).toHaveOutput('node-version', '20.11.0');
  });

  // ── Probe #4: with: inputs received correctly ───────────────────────────────

  test('passes the evaluated node-version with: input to actions/cache', async () => {
    const cache = action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '18.20.0' } });

    await action.run({ inputs: { 'node-version': '18' } });

    // Probe #4: the with: block is evaluated against the expression context before mock sees it.
    expect(cache).toHaveBeenCalledWith({ path: '~/.npm', key: 'node-18' });
  });

  test('passes node-version with: input to actions/setup-node', async () => {
    action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    const setup = action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    await action.run({ inputs: { 'node-version': '20' } });

    expect(setup).toHaveBeenCalledWith({ 'node-version': '20' });
  });

  // ── Probe #7: invocation order ──────────────────────────────────────────────

  test('invokes cache before setup-node in the declared step order', async () => {
    const cache = action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    const setup = action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    await action.run({ inputs: { 'node-version': '20' } });

    // Probe #7: call order asserted without reaching into mock.calls[0] manually.
    expect(cache).toHaveBeenCalledTimes(1);
    expect(setup).toHaveBeenCalledTimes(1);
    // Verify order via the step sequence in the result.
    const result = await action.run({ inputs: { 'node-version': '20' } });
    const stepIds = result.steps.map(s => s.id);
    expect(stepIds.indexOf('cache')).toBeLessThan(stepIds.indexOf('setup'));
  });

  // ── Probe #3: stdout from a run: step ──────────────────────────────────────

  test('verify step stdout mentions the setup-node version', async () => {
    action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    const result = await action.run({ inputs: { 'node-version': '20' } });

    // Probe #3: is stdout accessible directly on the step? Is there a matcher?
    // Finding: no toHaveStepStdout matcher — must reach into result.step().stdout.
    // This is expected friction (probe #3).
    const verifyStep = result.step('verify');
    expect(verifyStep).toBeDefined();
    expect(verifyStep!.stdout).toContain('20.11.0 is ready');
  });

  // ── Probe #8: state isolation between runs ──────────────────────────────────

  test('second run on the same Action handle does not leak mock call counts', async () => {
    const cache = action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    await action.run({ inputs: { 'node-version': '20' } });
    expect(cache).toHaveBeenCalledTimes(1);

    action.clearMocks();
    await action.run({ inputs: { 'node-version': '18' } });
    // After clearMocks(), call count resets — probe #8: no explicit reset needed, clearMocks() suffices.
    expect(cache).toHaveBeenCalledTimes(1);
  });

  test('different inputs on successive runs produce different outputs', async () => {
    action.mock('actions/cache@v3', { outputs: { 'cache-hit': 'false' } });
    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '20.11.0' } });

    const r1 = await action.run({ inputs: { 'node-version': '20' } });

    action.mock('actions/setup-node@v4', { outputs: { 'node-version': '18.20.0' } });
    const r2 = await action.run({ inputs: { 'node-version': '18' } });

    expect(r1).toHaveOutput('node-version', '20.11.0');
    expect(r2).toHaveOutput('node-version', '18.20.0');
  });
});
