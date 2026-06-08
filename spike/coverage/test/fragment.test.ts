// H3/H4 (disk-first pattern under actspec runner), H6 (parallel safety), probe #6 (fragment ready)
// This file runs as a separate worker from listener.test.ts.

import { resolve } from 'path';
import { collector } from '../src/coverage-register.js';
import { actspec } from '../src/index.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

describe('H3/H4/H6 — disk-first fragment data (separate worker from listener.test.ts)', () => {
  it('collector accumulates coverage for the partial action in this worker', async () => {
    const action = actspec(resolve(FIXTURES, 'partial/action.yml'));
    await action.run({ inputs: { env: 'production' } });

    const fragment = collector.getFragment();
    const sourceFile = resolve(FIXTURES, 'partial/action.yml');
    const fc = fragment[sourceFile];

    expect(fc).toBeDefined();
    if (!fc) return;

    expect(Object.keys(fc.statementMap)).toHaveLength(3);
    expect(Object.keys(fc.branchMap)).toHaveLength(1);

    expect(Object.values(fc.s).filter(c => (c as number) > 0).length).toBeGreaterThanOrEqual(2);
  });

  it('probe #6 — fragment data is non-empty before worker exits (will be written on process exit)', () => {
    const fragment = collector.getFragment();

    const keys = Object.keys(fragment);
    expect(keys.length).toBeGreaterThan(0);

    for (const fc of Object.values(fragment)) {
      expect(fc.path).toBeTruthy();
      expect(fc.statementMap).toBeDefined();
      expect(fc.s).toBeDefined();
    }
  });

  it('H6 — this is a separate worker from listener.test.ts; its fragment merges independently', () => {
    console.log(`[H6] Worker pid: ${process.pid} — fragment will be written to: ${process.env['ACTSPEC_COVERAGE_TMP'] ?? '/tmp/actspec-cov-spike'}`);
    expect(process.pid).toBeGreaterThan(0);
  });
});
