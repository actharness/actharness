// Targeted friction probes — documents design gaps and type findings.
// Each test is annotated with its classification from the spike spec.

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = join(__dirname, '../fixtures/ci.yml');
const CONDITIONAL = join(__dirname, '../fixtures/conditional.yml');

describe('friction probes', () => {
  let wf: Workflow;

  beforeEach(() => {
    wf = actspecWorkflow(CI);
  });

  // Probe #1: skipped job is accessible via result.job(id), with conclusion 'skipped'.
  // FINDING: requires JobResult.conclusion to include 'skipped' (H3 type fix applied).
  // CLASSIFICATION: type change needed (v0.1-blocking, resolved by Omit pattern in types.ts).
  test('probe #1: skipped job is accessible and has conclusion "skipped"', async () => {
    const cwf = actspecWorkflow(CONDITIONAL);
    cwf.mockJob('build', { result: 'failure' });
    const result = await cwf.run();

    const skipped = result.job('on-success');
    expect(skipped).toBeDefined();
    // If JobResult extended RunResult directly, this would be a type error:
    // conclusion would be typed as 'success' | 'failure', not 'skipped'.
    expect(skipped!.conclusion).toBe('skipped');
    expect(skipped!.outcome).toBe('skipped');
  });

  // Probe #7: mockJob has no .calls — cannot assert what inputs a job received.
  // CLASSIFICATION: design gap (by design — jobs have no 'with:' surface like actions).
  // This test documents the limitation by showing there is no spy to assert on.
  test('probe #7: mockJob has no .calls surface — spy assertion not possible', async () => {
    // mockJob returns void, not a JobMock spy. You cannot write:
    //   expect(mockBuild).toHaveBeenCalledWith({ ... })
    // This is by design: a job's "inputs" are its needs context + env, not a declared with:.
    // The only way to verify what a mocked job "received" is to inspect the dependent job's step
    // stdout or outputs after it uses needs.<id>.outputs.
    wf.mockJob('build', { outputs: { artifact: 'sentinel.tgz' } });
    const result = await wf.run();

    // Indirect assertion: deploy job received the mocked output.
    expect(result.job('deploy')!.step('ship')!.stdout).toContain('sentinel.tgz');
  });

  // Probe #8: wf.run({ job: 'deploy' }) — single-job execution not implemented.
  // CLASSIFICATION: design gap (not v0.1-blocking — wf.run({}) runs the full graph).
  // The WorkflowRunInput.job field is in the spec but not implemented in this spike.
  test('probe #8: wf.run() runs full graph (single-job limit not implemented)', async () => {
    // A run({ job: 'deploy' }) call would ideally only run 'build' + 'deploy'.
    // For now the full graph always runs. This is a known gap noted in findings.
    const result = await wf.run();
    // All three jobs run — no way to limit to one.
    expect(result.jobs.map(j => j.id)).toEqual(expect.arrayContaining(['build', 'deploy', 'notify']));
  });

  // Probe #9: isRunResult type guard works for JobResult (no casting needed).
  // CLASSIFICATION: no change needed — JobResult structurally satisfies RunResult check.
  test('probe #9: v0.1 RunResult matchers work on JobResult without casting', async () => {
    const result = await wf.run();
    const job = result.job('build')!;
    // These matchers' isRunResult guard checks 'conclusion', 'steps', 'outputs'.
    // JobResult has all three (via Omit<RunResult, 'conclusion'> + explicit conclusion).
    expect(job).toHaveRunStep('compile');
    expect(job).toHaveOutput('artifact', 'app.tgz');
    expect(job).toHaveSucceeded();
  });
});
