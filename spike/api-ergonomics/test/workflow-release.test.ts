// Tests for fixtures/release.yml — Workflow with needs: fan-out.
// Friction probe: #10 (workflow matchers feel like action matchers one level up).
// Validates H7 (workflow matchers additive), H1 (mock() same call shape in workflow context).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/release.yml');

describe('workflow-release', () => {
  let workflow: Workflow;

  beforeEach(() => {
    workflow = actspecWorkflow(FIXTURE);
    // Mock remote uses: steps in the workflow jobs.
    workflow.mock('actions/checkout@v4');
    workflow.mock('actions/upload-artifact@v4', {
      outputs: { 'artifact-url': 'https://github.com/actspec/test-repo/actions/runs/1/artifacts/42' },
    });
  });

  // ── H7: toHaveRunJob feels like toHaveRunStep one level up ─────────────────

  test('all three jobs run in sequence: build → test → publish (H7)', async () => {
    const result = await workflow.run();

    // H7 probe #10: toHaveRunJob should feel like toHaveRunStep from action tests.
    expect(result).toHaveRunJob('build');
    expect(result).toHaveRunJob('test');
    expect(result).toHaveRunJob('publish');
  });

  test('all three jobs conclude with success (H7)', async () => {
    const result = await workflow.run();

    // H7: toHaveJobConclusion mirrors toHaveStepConclusion ergonomics.
    expect(result).toHaveJobConclusion('build', 'success');
    expect(result).toHaveJobConclusion('test', 'success');
    expect(result).toHaveJobConclusion('publish', 'success');
  });

  // ── needs: output threading ─────────────────────────────────────────────────

  test('test job step stdout contains artifact from build job via needs: (probe #10)', async () => {
    const result = await workflow.run();

    // The test job's run-tests step does: echo "Testing ${{ needs.build.outputs.artifact }}"
    // needs.build.outputs.artifact was set to 'app.tgz' by the build job.
    const testJob = result.job('test');
    expect(testJob).toBeDefined();
    const runTestsStep = testJob!.step('run-tests');
    expect(runTestsStep!.stdout).toContain('app.tgz');
  });

  test('publish job outputs artifact-name from needs.build.outputs', async () => {
    const result = await workflow.run();

    // publish job output: artifact-name: ${{ needs.build.outputs.artifact }}
    expect(result).toHaveJobOutput('publish', 'artifact-name', 'app.tgz');
  });

  // ── Mocked job: downstream jobs see mock outputs ─────────────────────────────

  test('mocking build job: test and publish see the mock artifact output', async () => {
    workflow.mockJob('build', { outputs: { artifact: 'mock-app.tgz' }, result: 'success' });

    const result = await workflow.run();

    expect(result).toHaveRunJob('test');
    expect(result).toHaveRunJob('publish');

    const testJob = result.job('test');
    expect(testJob!.step('run-tests')!.stdout).toContain('mock-app.tgz');
  });

  // ── Workflow-level conclusion ────────────────────────────────────────────────

  test('workflow concludes success when all jobs succeed', async () => {
    const result = await workflow.run();
    expect(result.conclusion).toBe('success');
  });

  // ── Probe #10: job-level step matchers reuse action matchers ────────────────

  test('result.job(id) exposes toHaveRunStep — same matchers as action result (probe #10)', async () => {
    const result = await workflow.run();

    // Probe #10: the matchers on result.job(id) should be identical to those on a RunResult.
    // H7: workflow matchers are additive, not a different API.
    const buildJob = result.job('build');
    expect(buildJob).toBeDefined();

    // These are the SAME matchers as in composite tests — just applied to a job result.
    expect(buildJob!).toHaveRunStep('compile');
    expect(buildJob!).toHaveStepConclusion('compile', 'success');
    expect(buildJob!).toHaveStepOutput('compile', 'artifact', 'app.tgz');
  });

  // ── H1: mock() call shape in workflow context ────────────────────────────────

  test('mock() in a workflow test uses the same syntax as in an action test (H1)', async () => {
    // H1 smoke test for workflow context:
    // workflow.mock('actions/checkout@v4') — identical to action.mock('actions/checkout@v4').
    // No type: parameter. No workflow-specific mock syntax.
    const checkout = workflow.mock('actions/checkout@v4');

    await workflow.run();

    // checkout mock was called once per job that has it (build and publish have checkout).
    expect(checkout).toHaveBeenCalled();
  });
});
