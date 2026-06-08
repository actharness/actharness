// H2 (HTML renderer renders action.yml), probe #3 (reporter doesn't crash on .yml source)

import { resolve } from 'path';
import { readFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { createCoverageMap } from '../src/istanbul-compat.js';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { buildActionCoverage, updateActionCoverage } from '../src/istanbul-map.js';
import { actspec } from '../src/index.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');
const TMP_REPORT = '/tmp/actspec-html-probe';

describe('Probe #3 / H2 — HTML reporter on YAML source', () => {
  it('produces index.html without crashing when source file is action.yml', async () => {
    rmSync(TMP_REPORT, { recursive: true, force: true });
    mkdirSync(TMP_REPORT, { recursive: true });

    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    const result = await action.run({ inputs: { mode: 'full' } });
    updateActionCoverage(coverage, meta, result);

    const map = createCoverageMap({});
    map.addFileCoverage(coverage);

    expect(() => {
      const context = libReport.createContext({ dir: TMP_REPORT, coverageMap: map });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = reports.create('html' as any);
      r.execute(context);
    }).not.toThrow();

    const indexHtml = resolve(TMP_REPORT, 'index.html');
    expect(existsSync(indexHtml)).toBe(true);
    const html = readFileSync(indexHtml, 'utf8');
    expect(html.length).toBeGreaterThan(0);
    expect(html).toMatch(/action\.yml/i);

    rmSync(TMP_REPORT, { recursive: true, force: true });
  });

  it('produces text report without crashing', async () => {
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const yamlSource = readFileSync(sourceFile, 'utf8');
    const { coverage, meta } = buildActionCoverage(sourceFile, yamlSource);

    const action = actspec(sourceFile);
    const result = await action.run({ inputs: { mode: 'full' } });
    updateActionCoverage(coverage, meta, result);

    const map = createCoverageMap({});
    map.addFileCoverage(coverage);

    expect(() => {
      const context = libReport.createContext({ dir: '/tmp', coverageMap: map });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = reports.create('text' as any);
      r.execute(context);
    }).not.toThrow();
  });
});
