// H1 (Istanbul map valid), probe #1 (YAML CST extraction), probe #2 (FileCoverageData construction)

import { resolve } from 'path';
import { readFileSync } from 'fs';
import { createCoverageMap } from '../src/istanbul-compat.js';
import { extractStepRanges, extractJobRanges } from '../src/yaml-map.js';
import { buildActionCoverage, buildWorkflowCoverage } from '../src/istanbul-map.js';

const FIXTURES = resolve(process.cwd(), 'fixtures');

describe('Probe #1 — YAML CST line extraction', () => {
  it('extracts step ranges from guarded/action.yml with correct IDs and lines', () => {
    const source = readFileSync(resolve(FIXTURES, 'guarded/action.yml'), 'utf8');
    const ranges = extractStepRanges(source);

    expect(ranges).toHaveLength(4);
    expect(ranges.map(r => r.id)).toEqual(['prepare', 'full-process', 'quick-process', 'notify']);

    expect(ranges[0]!.hasIf).toBe(false);
    expect(ranges[1]!.hasIf).toBe(true);
    expect(ranges[2]!.hasIf).toBe(true);
    expect(ranges[3]!.hasIf).toBe(true);

    for (let i = 0; i < ranges.length - 1; i++) {
      expect(ranges[i]!.startLine).toBeLessThan(ranges[i + 1]!.startLine);
    }

    for (const r of ranges) {
      expect(r.startLine).toBeGreaterThanOrEqual(1);
      expect(r.endLine).toBeGreaterThanOrEqual(r.startLine);
    }
  });

  it('extracts job ranges from pipeline.yml', () => {
    const source = readFileSync(resolve(FIXTURES, 'pipeline.yml'), 'utf8');
    const ranges = extractJobRanges(source);

    expect(ranges).toHaveLength(3);
    expect(ranges.map(r => r.id)).toEqual(['build', 'test', 'deploy']);

    for (const r of ranges) {
      expect(r.startLine).toBeGreaterThanOrEqual(1);
      expect(r.endLine).toBeGreaterThanOrEqual(r.startLine);
    }
  });
});

describe('Probe #2 / H1 — Istanbul FileCoverageData construction from YAML', () => {
  it('builds a valid FileCoverageData for guarded/action.yml', () => {
    const source = readFileSync(resolve(FIXTURES, 'guarded/action.yml'), 'utf8');
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const { coverage, meta } = buildActionCoverage(sourceFile, source);

    const data = coverage.data;

    expect(Object.keys(data.statementMap)).toHaveLength(4);
    expect(Object.keys(data.s)).toHaveLength(4);
    expect(Object.values(data.s).every(c => c === 0)).toBe(true);

    expect(Object.keys(data.branchMap)).toHaveLength(3);
    expect(Object.keys(data.b)).toHaveLength(3);
    for (const arr of Object.values(data.b)) {
      expect(arr).toEqual([0, 0]);
    }

    for (const loc of Object.values(data.statementMap)) {
      expect(loc.start.line).toBeGreaterThanOrEqual(1);
      expect(loc.end.line).toBeGreaterThanOrEqual(loc.start.line);
    }

    for (const branch of Object.values(data.branchMap)) {
      expect(branch.type).toBe('if');
      expect(branch.locations).toHaveLength(2);
    }

    expect(meta.kind).toBe('action');
    if (meta.kind === 'action') {
      expect(meta.steps.map(s => s.id)).toEqual(['prepare', 'full-process', 'quick-process', 'notify']);
    }
  });

  it('is accepted by istanbul-lib-coverage createCoverageMap without throwing', () => {
    const source = readFileSync(resolve(FIXTURES, 'guarded/action.yml'), 'utf8');
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const { coverage } = buildActionCoverage(sourceFile, source);

    expect(() => {
      const map = createCoverageMap({});
      map.addFileCoverage(coverage);
    }).not.toThrow();
  });

  it('supports merge via istanbul-lib-coverage createCoverageMap', () => {
    const source = readFileSync(resolve(FIXTURES, 'guarded/action.yml'), 'utf8');
    const sourceFile = resolve(FIXTURES, 'guarded/action.yml');
    const { coverage: cov1 } = buildActionCoverage(sourceFile, source);
    const { coverage: cov2 } = buildActionCoverage(sourceFile, source);

    (cov1.data.s['0'] as number)++;

    const map = createCoverageMap({});
    map.addFileCoverage(cov1);
    map.merge(createCoverageMap({ [sourceFile]: cov2.data }));

    const merged = map.fileCoverageFor(sourceFile);
    expect(merged.data.s['0']).toBe(1);
  });
});
