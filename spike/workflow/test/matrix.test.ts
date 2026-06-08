// Tests for fixtures/matrix.yml — H6 (matrix + fail-fast).
// Also probes: probe #2 (matrix job identity), probe #3 (cancelled conclusion).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MATRIX = join(__dirname, '../fixtures/matrix.yml');

describe('matrix expansion + fail-fast (matrix.yml)', () => {
  let wf: Workflow;

  beforeEach(() => {
    wf = actspecWorkflow(MATRIX);
  });

  // H6: matrix expands to N instances in result.jobs.
  test('matrix node:[18,20] produces two JobResult instances (H6)', async () => {
    const result = await wf.run();
    const testJobs = result.jobs.filter(j => j.id === 'test');
    expect(testJobs).toHaveLength(2);
  });

  // H6: each instance carries its matrix values.
  test('each matrix instance carries its matrix context (H6)', async () => {
    const result = await wf.run();
    const testJobs = result.jobs.filter(j => j.id === 'test');
    const nodes = testJobs.map(j => j.matrix?.['node']);
    expect(nodes).toContain(18);
    expect(nodes).toContain(20);
  });

  // H6: all instances succeed when no failure.
  test('both instances succeed when no failure (H6)', async () => {
    const result = await wf.run();
    expect(result).toHaveJobConclusion('test', 'success');
    const testJobs = result.jobs.filter(j => j.id === 'test');
    expect(testJobs.every(j => j.conclusion === 'success')).toBe(true);
  });

  // Probe #2 (FINDING): job(id) returns only the FIRST matrix instance.
  // To access a specific instance, filter result.jobs by id + matrix value.
  test('FINDING probe #2: job(id) returns first matrix instance only', async () => {
    const result = await wf.run();
    const first = result.job('test');
    expect(first).toBeDefined();
    // This only returns one instance — the first. The API has no disambiguation.
    // To get node=20: result.jobs.find(j => j.id === 'test' && j.matrix?.node === 20)
    const node20 = result.jobs.find(j => j.id === 'test' && j.matrix?.['node'] === 20);
    expect(node20).toBeDefined();
    expect(node20!.matrix?.['node']).toBe(20);
  });

  // Probe #3: fail-fast cancels siblings.
  test('fail-fast: node=18 failure cancels node=20 instance (probe #3)', async () => {
    const result = await wf.run({ env: { FORCE_FAIL_NODE18: 'true' } });
    const node18 = result.jobs.find(j => j.id === 'test' && j.matrix?.['node'] === 18);
    const node20 = result.jobs.find(j => j.id === 'test' && j.matrix?.['node'] === 20);
    expect(node18!.conclusion).toBe('failure');
    // FINDING (probe #3): cancelled conclusion requires JobResult.conclusion to include 'cancelled'.
    // This only works because JobResult uses Omit<RunResult, 'conclusion'> (H3 type fix).
    expect(node20!.conclusion).toBe('cancelled');
    expect(result).toHaveJobCancelled('test');
  });

  // When fail-fast fires, downstream report job should be skipped.
  test('fail-fast: report job is skipped when test fails (probe #3)', async () => {
    const result = await wf.run({ env: { FORCE_FAIL_NODE18: 'true' } });
    expect(result).toHaveSkippedJob('report');
  });

  // H6: step output from each instance.
  test('each matrix instance writes its node version to step output (H6)', async () => {
    const result = await wf.run();
    const node18 = result.jobs.find(j => j.id === 'test' && j.matrix?.['node'] === 18);
    const node20 = result.jobs.find(j => j.id === 'test' && j.matrix?.['node'] === 20);
    expect(node18!.step('run')!.outputs['version']).toBe('18');
    expect(node20!.step('run')!.outputs['version']).toBe('20');
  });
});
