// H10 (job coverage alongside step coverage), probe #12 (no collision in statement IDs)

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createCoverageMap } from '../src/istanbul-compat.js';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { buildWorkflowCoverage, buildActionCoverage, updateWorkflowCoverage, updateActionCoverage } from '../src/istanbul-map.js';
import { actspec, actspecWorkflow } from '../src/index.js';
import { collector } from '../src/coverage-register.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

describe('H10 / Probe #12 — job coverage alongside step coverage', () => {
  it('workflow run produces job coverage in the collector', async () => {
    const wf = actspecWorkflow(resolve(FIXTURES, 'pipeline.yml'));
    wf.mock('actions/checkout@v4', { outputs: {} });

    await wf.run({});
    const fragment = collector.getFragment();

    const wfPath = resolve(FIXTURES, 'pipeline.yml');
    expect(fragment[wfPath]).toBeDefined();

    const wfFc = fragment[wfPath]!;
    expect(Object.keys(wfFc.statementMap)).toHaveLength(3);

    const coveredJobs = Object.values(wfFc.s).filter(c => (c as number) > 0).length;
    expect(coveredJobs).toBe(3);
    console.log(`[H10] Jobs covered: ${coveredJobs}/3`);
  });

  it('probe #12 — job and step coverage in the SAME Istanbul map: no statement ID collision', () => {
    const wfPath = resolve(FIXTURES, 'pipeline.yml');
    const wfYaml = readFileSync(wfPath, 'utf8');
    const { coverage: wfCov } = buildWorkflowCoverage(wfPath, wfYaml);

    const actionPath = resolve(FIXTURES, 'guarded/action.yml');
    const actionYaml = readFileSync(actionPath, 'utf8');
    const { coverage: actionCov } = buildActionCoverage(actionPath, actionYaml);

    const map = createCoverageMap({});
    expect(() => {
      map.addFileCoverage(wfCov);
      map.addFileCoverage(actionCov);
    }).not.toThrow();

    const wfFc = map.fileCoverageFor(wfPath);
    const actionFc = map.fileCoverageFor(actionPath);

    expect(Object.keys(wfFc.data.statementMap)).toHaveLength(3);
    expect(Object.keys(actionFc.data.statementMap)).toHaveLength(4);

    console.log('[probe #12] statement IDs are scoped per file — no collision possible.');
  });

  it('text reporter produces output for both workflow jobs and action steps', async () => {
    const wfPath = resolve(FIXTURES, 'pipeline.yml');
    const wfYaml = readFileSync(wfPath, 'utf8');
    const { coverage: wfCov, meta: wfMeta } = buildWorkflowCoverage(wfPath, wfYaml);

    const actionPath = resolve(FIXTURES, 'guarded/action.yml');
    const actionYaml = readFileSync(actionPath, 'utf8');
    const { coverage: actionCov, meta: actionMeta } = buildActionCoverage(actionPath, actionYaml);

    updateWorkflowCoverage(wfCov, wfMeta, 'build', true);
    updateWorkflowCoverage(wfCov, wfMeta, 'test', true);
    updateWorkflowCoverage(wfCov, wfMeta, 'deploy', true);

    const action = actspec(actionPath);
    await action.run({ inputs: { mode: 'full' } }).then(r => updateActionCoverage(actionCov, actionMeta, r));

    const map = createCoverageMap({});
    map.addFileCoverage(wfCov);
    map.addFileCoverage(actionCov);

    expect(() => {
      const context = libReport.createContext({ dir: '/tmp', coverageMap: map });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reports.create('text' as any).execute(context);
    }).not.toThrow();

    console.log('[H10] text reporter executed successfully for combined workflow + action coverage map.');
  });

  it('skipped job shows as uncovered in the Istanbul map', () => {
    const wfPath = resolve(FIXTURES, 'pipeline.yml');
    const wfYaml = readFileSync(wfPath, 'utf8');
    const { coverage: wfCov, meta: wfMeta } = buildWorkflowCoverage(wfPath, wfYaml);

    updateWorkflowCoverage(wfCov, wfMeta, 'build', true);
    updateWorkflowCoverage(wfCov, wfMeta, 'test', true);
    updateWorkflowCoverage(wfCov, wfMeta, 'deploy', false);

    const deployMeta = wfMeta.jobs.find(j => j.id === 'deploy')!;
    const deployCount = wfCov.data.s[deployMeta.statementIdx] as number;
    expect(deployCount).toBe(0);

    const buildMeta = wfMeta.jobs.find(j => j.id === 'build')!;
    const buildCount = wfCov.data.s[buildMeta.statementIdx] as number;
    expect(buildCount).toBe(1);

    console.log('[H10] skipped job correctly shows as statement count=0 in Istanbul map.');
  });
});
