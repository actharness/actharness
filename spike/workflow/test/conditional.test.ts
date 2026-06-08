// Tests for fixtures/conditional.yml — job-level if: conditions (H1, H2).
// Also probes: probe #1 (skipped job access), probe #4 (needs context in if:).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONDITIONAL = join(__dirname, '../fixtures/conditional.yml');

describe('job-level if: conditions (conditional.yml)', () => {
  let wf: Workflow;

  beforeEach(() => {
    wf = actspecWorkflow(CONDITIONAL);
  });

  // When build succeeds: on-success runs, on-failure is skipped, always-run runs.
  test('on-success runs when build succeeds', async () => {
    const result = await wf.run();
    expect(result).toHaveRunJob('on-success');
    expect(result.job('on-success')!).toHaveRunStep('succeed');
  });

  test('on-failure is skipped when build succeeds', async () => {
    const result = await wf.run();
    // Probe #1: skipped job should be accessible via result.job(id) with outcome 'skipped'.
    expect(result).toHaveSkippedJob('on-failure');
    const skipped = result.job('on-failure')!;
    expect(skipped.conclusion).toBe('skipped');
    expect(skipped.outcome).toBe('skipped');
  });

  test('always-run runs regardless of build result', async () => {
    const result = await wf.run();
    expect(result).toHaveRunJob('always-run');
    expect(result.job('always-run')!.step('notify')!.stdout).toContain('Always runs');
  });

  // Probe #4: needs.<id>.outputs.* accessible in the always-run step expression.
  test('needs.build.outputs.status threads into always-run step (probe #4)', async () => {
    const result = await wf.run();
    const notify = result.job('always-run')!.step('notify')!;
    expect(notify.stdout).toContain('status=built');
  });

  test('mockJob: mocked build with failure causes on-success to be skipped', async () => {
    wf.mockJob('build', { result: 'failure', outputs: {} });
    const result = await wf.run();
    expect(result).toHaveSkippedJob('on-success');
    expect(result).toHaveRunJob('on-failure');
    expect(result).toHaveRunJob('always-run');
  });
});
