// H7 (threshold enforcement), probe #10 (partial branch → threshold fails)

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createCoverageMap } from '../src/istanbul-compat.js';
import { buildActionCoverage, updateActionCoverage } from '../src/istanbul-map.js';
import { checkThresholds } from '../src/thresholds.js';
import { actspec } from '../src/index.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

describe('H7 / Probe #10 — threshold enforcement', () => {
  it('passes when ifBranches threshold is satisfied', async () => {
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    await action.run({ inputs: { mode: 'full' } }).then(r => updateActionCoverage(coverage, meta, r));
    await action.run({ inputs: { mode: 'quick', 'skip-notify': 'true' } }).then(r => updateActionCoverage(coverage, meta, r));

    const map = createCoverageMap({});
    map.addFileCoverage(coverage);

    const result = checkThresholds(map, { ifBranches: 100 });
    expect(result.passed).toBe(true);
    expect(result.failures).toHaveLength(0);
  });

  it('fails when ifBranches threshold is NOT satisfied (probe #10)', async () => {
    const sourceFile = resolve(FIXTURES, 'partial/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    await action.run({ inputs: { env: 'production' } }).then(r => updateActionCoverage(coverage, meta, r));
    await action.run({ inputs: { env: 'production' } }).then(r => updateActionCoverage(coverage, meta, r));

    const map = createCoverageMap({});
    map.addFileCoverage(coverage);

    const result = checkThresholds(map, { ifBranches: 100 });
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThan(0);
    console.log('[probe #10] threshold failure message:', result.failures[0]);
  });

  it('distinguishes between partial and full coverage at different threshold levels', async () => {
    const sourceFile = resolve(FIXTURES, 'partial/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    await action.run({ inputs: { env: 'production' } }).then(r => updateActionCoverage(coverage, meta, r));

    const map = createCoverageMap({});
    map.addFileCoverage(coverage);

    const at50 = checkThresholds(map, { ifBranches: 50 });
    expect(at50.passed).toBe(true);

    const at100 = checkThresholds(map, { ifBranches: 100 });
    expect(at100.passed).toBe(false);
  });
});
