// Tests for fixtures/ci.yml — H1 (StepRunner reuse), H2 (ContextStore extension),
// H3 (JobResult extends RunResult), H4 (WorkflowResult composes with matchers),
// H5 (actspecWorkflow is a pure add).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = join(__dirname, '../fixtures/ci.yml');

describe('needs: fan-in (ci.yml)', () => {
  let wf: Workflow;

  beforeEach(() => {
    wf = actspecWorkflow(CI);
  });

  // H1: StepRunner reuse — job steps run via the same composite executor.
  test('build job runs its compile step (H1)', async () => {
    const result = await wf.run();
    expect(result).toHaveRunJob('build');
    // H3: toHaveRunStep on a JobResult — same matcher as on a RunResult.
    expect(result.job('build')!).toHaveRunStep('compile');
  });

  // H2: ContextStore extension — needs context threads without shape change.
  test('deploy job step receives needs.build.outputs.artifact (H2)', async () => {
    const result = await wf.run();
    const ship = result.job('deploy')!.step('ship');
    expect(ship).toBeDefined();
    expect(ship!.stdout).toContain('app.tgz');
  });

  // H3: JobResult extends RunResult — v0.1 step matchers work on a job result.
  test('v0.1 step matchers work on result.job(id) without casting (H3)', async () => {
    const result = await wf.run();
    const build = result.job('build')!;
    // These are the SAME matchers as action tests — no type-specific ceremony.
    expect(build).toHaveRunStep('compile');
    expect(build).toHaveStepConclusion('compile', 'success');
    expect(build).toHaveStepOutput('compile', 'artifact', 'app.tgz');
  });

  // H4: WorkflowResult composes — job matchers + step matchers mixed in one test.
  test('job-level and step-level matchers compose on the same result (H4)', async () => {
    const result = await wf.run();
    expect(result).toHaveRunJob('build');
    expect(result).toHaveJobConclusion('build', 'success');
    expect(result).toHaveJobOutput('deploy', 'deployed', 'app.tgz');
    // Mix: step matcher on a job result.
    expect(result.job('deploy')!).toHaveRunStep('ship');
  });

  // H5: actspecWorkflow() is a pure add — no imports from actspec() changed.
  test('needs: output accessible from job outputs expression (H5)', async () => {
    const result = await wf.run();
    // deploy job declares: outputs.deployed: ${{ needs.build.outputs.artifact }}
    expect(result).toHaveJobOutput('deploy', 'deployed', 'app.tgz');
  });
});
