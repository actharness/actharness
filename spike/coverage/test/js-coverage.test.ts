// H9 (JS line coverage from worker_threads), probe #11

import { resolve } from 'path';
import { existsSync } from 'fs';
import { actspec } from '../src/index.js';
import { collector } from '../src/coverage-register.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');
const SETTER_DIR = resolve(FIXTURES, 'setter');

describe('H9 / Probe #11 — JS line coverage from worker_threads', () => {
  it('setter action runs successfully and produces output', async () => {
    expect(existsSync(resolve(SETTER_DIR, 'index.js'))).toBe(true);
    expect(existsSync(resolve(SETTER_DIR, 'package.json'))).toBe(true);

    const action = actspec(SETTER_DIR);
    const result = await action.run({ inputs: { greeting: 'Hello', name: 'World' } });

    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Hello, World!');
  });

  it('V8 coverage data is collected for the setter JS file and appears in the fragment', async () => {
    const action = actspec(SETTER_DIR);

    await action.run({ inputs: { greeting: 'Hi', name: 'Alice' } });

    const fragment = collector.getFragment();

    const actionYml = resolve(SETTER_DIR, 'action.yml');
    expect(fragment[actionYml]).toBeDefined();

    const setterJs = resolve(SETTER_DIR, 'index.js');
    const hasJsCoverage = fragment[setterJs] !== undefined;

    console.log(`[H9] JS line coverage file present in fragment: ${hasJsCoverage}`);
    if (hasJsCoverage) {
      const jsFc = fragment[setterJs]!;
      console.log(`[H9] JS statement count keys: ${Object.keys(jsFc.s).length}`);
      console.log(`[H9] JS statements covered: ${Object.values(jsFc.s).filter(c => (c as number) > 0).length}`);
      expect(Object.keys(jsFc.statementMap).length).toBeGreaterThan(0);
    } else {
      console.warn('[H9 ❌] setter/index.js NOT found in coverage fragment.');
      console.warn('[H9] Fragment keys:', Object.keys(fragment));
    }

    expect(hasJsCoverage).toBe(true);
  });

  it('the node action step appears in the coverage map (step coverage works for node actions)', async () => {
    const action = actspec(SETTER_DIR);
    const before = Object.keys(collector.getFragment()).length;

    await action.run({ inputs: { greeting: 'Hello', name: 'Coverage' } });

    const fragment = collector.getFragment();
    const after = Object.keys(fragment).length;
    expect(after).toBeGreaterThanOrEqual(before);

    const actionYml = resolve(SETTER_DIR, 'action.yml');
    expect(fragment[actionYml]).toBeDefined();
  });
});
