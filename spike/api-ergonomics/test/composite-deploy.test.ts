// Tests for fixtures/deploy/action.yml — Composite with if:, continue-on-error, env threading.
// Friction probes: #3 (stdout), #4 (with:), #5 (continue-on-error), #8 (state isolation), #9 (env threading).
// Validates H3 (matchers cover vocabulary), H4 (mixed-type composites natural).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';
import type { Action } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/deploy');

describe('composite-deploy', () => {
  let action: Action;

  beforeEach(() => {
    action = actspec(FIXTURE);
    // checkout is always mocked so tests don't need a real git repo.
    action.mock('actions/checkout@v4');
  });

  // ── if: conditions ──────────────────────────────────────────────────────────

  test('dry-run=true skips deploy and runs dry-run-notice', async () => {
    const result = await action.run({
      inputs: { environment: 'staging', 'dry-run': true },
    });

    expect(result).toHaveSucceeded();
    expect(result).toHaveSkippedStep('deploy');
    expect(result).toHaveRunStep('dry-run-notice');
  });

  test('dry-run=false runs deploy and skips dry-run-notice', async () => {
    const result = await action.run({
      inputs: { environment: 'production', 'dry-run': false },
    });

    expect(result).toHaveSucceeded();
    expect(result).toHaveRunStep('deploy');
    expect(result).toHaveSkippedStep('dry-run-notice');
    expect(result).toHaveOutput('url', 'https://production.example.com');
  });

  test('deploy step conclusion is success when it runs', async () => {
    const result = await action.run({
      inputs: { environment: 'production', 'dry-run': false },
    });

    expect(result).toHaveStepConclusion('deploy', 'success');
  });

  // ── Probe #5: continue-on-error — outcome vs conclusion ────────────────────

  test('lint step has outcome=failure but conclusion=success (continue-on-error)', async () => {
    const result = await action.run({
      inputs: { environment: 'staging', 'dry-run': false },
    });

    const lint = result.step('lint');
    expect(lint).toBeDefined();
    expect(lint!.ran).toBe(true);
    // Probe #5: outcome and conclusion are distinct — must reach into StepResult directly.
    // Finding: no dedicated matcher for outcome (only conclusion). Access is via result.step().outcome.
    expect(lint!.outcome).toBe('failure');
    expect(lint!.conclusion).toBe('success');
    // The overall run still succeeds because lint has continue-on-error.
    expect(result).toHaveSucceeded();
  });

  // ── Probe #9: GITHUB_ENV threading ─────────────────────────────────────────

  test('ARTIFACT env var written by build is visible in deploy stdout', async () => {
    const result = await action.run({
      inputs: { environment: 'staging', 'dry-run': false },
    });

    // Probe #9: env threading across steps.
    // The deploy step references $ARTIFACT which was set via GITHUB_ENV in the build step.
    const deployStep = result.step('deploy');
    expect(deployStep!.stdout).toContain('app-staging.tgz');
  });

  test('GITHUB_ENV accumulates in result.env', async () => {
    const result = await action.run({
      inputs: { environment: 'production', 'dry-run': false },
    });

    // Probe #9: result.env exposes the final accumulated env state.
    expect(result.env['ARTIFACT']).toBe('app-production.tgz');
  });

  // ── Probe #3: stdout from run: steps ───────────────────────────────────────

  test('deploy step stdout contains the artifact name and environment', async () => {
    const result = await action.run({
      inputs: { environment: 'staging', 'dry-run': false },
    });

    const deployStep = result.step('deploy');
    // Probe #3: no dedicated stdout matcher — must use step().stdout.
    expect(deployStep!.stdout).toContain('Deploying app-staging.tgz to staging');
  });

  test('dry-run-notice stdout mentions the environment name', async () => {
    const result = await action.run({
      inputs: { environment: 'staging', 'dry-run': true },
    });

    const noticeStep = result.step('dry-run-notice');
    expect(noticeStep!.stdout).toContain('staging');
  });

  // ── Probe #4: with: inputs on mocked checkout ──────────────────────────────

  test('checkout mock receives no with: inputs (step has no with: block)', async () => {
    const checkout = action.mock('actions/checkout@v4');

    await action.run({ inputs: { environment: 'staging', 'dry-run': false } });

    expect(checkout).toHaveBeenCalled();
    // Probe #4: with: is empty object when the step has no with: block.
    expect(checkout.calls[0]!.with).toEqual({});
  });

  // ── Probe #8: state isolation ───────────────────────────────────────────────

  test('two runs with different environments do not share env state', async () => {
    const r1 = await action.run({ inputs: { environment: 'staging', 'dry-run': false } });
    const r2 = await action.run({ inputs: { environment: 'production', 'dry-run': false } });

    expect(r1.env['ARTIFACT']).toBe('app-staging.tgz');
    expect(r2.env['ARTIFACT']).toBe('app-production.tgz');
  });
});
