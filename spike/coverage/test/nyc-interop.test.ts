// H8 (nyc merge interop), probe #9 (YAML map merges with JS coverage map)

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createCoverageMap, createFileCoverage } from '../src/istanbul-compat.js';
import type { FileCoverageData } from '../src/istanbul-compat.js';
import { buildActionCoverage, updateActionCoverage } from '../src/istanbul-map.js';
import { actspec } from '../src/index.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

function toyJsCoverage(path: string): FileCoverageData {
  return {
    path,
    statementMap: {
      '0': { start: { line: 1, column: 0 }, end: { line: 1, column: 30 } },
      '1': { start: { line: 3, column: 0 }, end: { line: 5, column: 10 } },
    },
    fnMap: {
      '0': { name: 'doSomething', decl: { start: { line: 3, column: 0 }, end: { line: 5, column: 10 } }, loc: { start: { line: 3, column: 0 }, end: { line: 5, column: 10 } }, line: 3 },
    },
    branchMap: {},
    s: { '0': 2, '1': 1 },
    f: { '0': 1 },
    b: {},
  };
}

describe('H8 / Probe #9 — nyc merge interop', () => {
  it('YAML coverage map merges with a toy JS coverage map without error', async () => {
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    await action.run({ inputs: { mode: 'full' } }).then(r => updateActionCoverage(coverage, meta, r));

    const yamlMap = createCoverageMap({});
    yamlMap.addFileCoverage(coverage);

    const jsPath = '/fake/src/app.js';
    const jsCoverage = createFileCoverage(toyJsCoverage(jsPath));

    const combined = createCoverageMap({});
    expect(() => {
      combined.merge(yamlMap);
      combined.merge(createCoverageMap({ [jsPath]: jsCoverage.data }));
    }).not.toThrow();

    const paths = Object.keys(combined.data);
    expect(paths).toContain(sourceFile);
    expect(paths).toContain(jsPath);

    const yamlFc = combined.fileCoverageFor(sourceFile);
    expect(Object.keys(yamlFc.data.statementMap)).toHaveLength(4);

    const jsFc = combined.fileCoverageFor(jsPath);
    expect(jsFc.data.s['0']).toBe(2);
    expect(jsFc.data.f['0']).toBe(1);

    console.log('[H8] nyc-merge-equivalent: both files present in combined map:', paths);
  });

  it('merging two copies of the same YAML coverage accumulates counts', async () => {
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');

    const { coverage: cov1, meta } = buildActionCoverage(sourceFile, yamlSource);
    const { coverage: cov2 } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    await action.run({ inputs: { mode: 'full' } }).then(r => updateActionCoverage(cov1, meta, r));
    await action.run({ inputs: { mode: 'full' } }).then(r => updateActionCoverage(cov2, meta, r));

    const map1 = createCoverageMap({ [sourceFile]: cov1.data });
    const map2 = createCoverageMap({ [sourceFile]: cov2.data });

    const combined = createCoverageMap({});
    combined.merge(map1);
    combined.merge(map2);

    const fc = combined.fileCoverageFor(sourceFile);
    expect(fc.data.s['0']).toBe(2);
  });
});
