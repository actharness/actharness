// Tests for reporters.ts — mocks istanbul-compat.js to verify generateReports
// covers all ?? branches: reporters, dir, projectRoot.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/istanbul-compat.js', () => ({
  createCoverageMap: vi.fn(() => ({})),
  createContext: vi.fn(() => ({})),
  createReport: vi.fn(() => ({ execute: vi.fn() })),
}));

vi.mock('../src/html-reporter.js', () => ({
  generateHtmlReport: vi.fn(),
}));

vi.mock('../src/text-reporter.js', () => ({
  buildTextReport: vi.fn().mockReturnValue('text report'),
  buildTextSummary: vi.fn().mockReturnValue('text summary'),
}));

import { createContext, createReport } from '../src/istanbul-compat.js';
import { generateHtmlReport } from '../src/html-reporter.js';
import { buildTextReport, buildTextSummary } from '../src/text-reporter.js';
import { generateReports, generateActharnessReports, ACTHARNESS_REPORTER_NAMES } from '../src/reporters.js';
import type { CoverageMap } from '../src/istanbul-compat.js';
import type { CoverageReport } from '../src/types.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createReport).mockReturnValue({ execute: vi.fn() } as unknown as ReturnType<typeof createReport>);
  vi.mocked(buildTextReport).mockReturnValue('text report');
  vi.mocked(buildTextSummary).mockReturnValue('text summary');
});

function makeEmptyReport(): CoverageReport {
  const stat = { covered: 0, total: 0, pct: 0 };
  return {
  files: {},
  jsFiles: {},
  total: { steps: stat, ifBranches: stat, inputs: stat, outputs: stat, jsStatements: stat, jsBranches: stat, jsFunctions: stat, jsLines: stat, shShellLines: stat, pwshShellLines: stat, pythonShellStatements: stat, pythonShellBranches: stat, pythonShellLines: stat, nodeShellLines: stat, nodeShellStatements: stat, nodeShellBranches: stat, bashShellLines: stat },
  pythonShellFiles: {},
  shShellFiles: {},
  bashShellFiles: {},
  pwshShellFiles: {},
  nodeShellFiles: {}
};
}

// ── ACTHARNESS_REPORTER_NAMES ────────────────────────────────────────────────────

describe('ACTHARNESS_REPORTER_NAMES', () => {
  it('contains html, html-spa, text, text-summary', () => {
    expect(ACTHARNESS_REPORTER_NAMES.has('html')).toBe(true);
    expect(ACTHARNESS_REPORTER_NAMES.has('html-spa')).toBe(true);
    expect(ACTHARNESS_REPORTER_NAMES.has('text')).toBe(true);
    expect(ACTHARNESS_REPORTER_NAMES.has('text-summary')).toBe(true);
  });

  it('does not contain lcov, json, cobertura', () => {
    expect(ACTHARNESS_REPORTER_NAMES.has('lcov')).toBe(false);
    expect(ACTHARNESS_REPORTER_NAMES.has('json')).toBe(false);
    expect(ACTHARNESS_REPORTER_NAMES.has('cobertura')).toBe(false);
  });
});

// ── generateReports ───────────────────────────────────────────────────────────

describe('generateReports', () => {
  it('filters out actharness reporters from defaults (only lcov reaches Istanbul)', () => {
    const fakeMap = {} as CoverageMap;
    generateReports(fakeMap, {});
    // Default reporters: ['lcov', 'html', 'text']; html and text are filtered
    expect(vi.mocked(createReport)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createReport)).toHaveBeenCalledWith('lcov', { projectRoot: process.cwd() });
    expect(vi.mocked(createContext)).toHaveBeenCalledWith(
      expect.objectContaining({ coverageMap: fakeMap }),
    );
  });

  it('uses opts when reporters, dir, and projectRoot are provided', () => {
    const fakeMap = {} as CoverageMap;
    generateReports(fakeMap, {
      reporters: ['json'],
      dir: '/custom/dir',
      projectRoot: '/custom/root',
    });
    expect(vi.mocked(createReport)).toHaveBeenCalledWith('json', { projectRoot: '/custom/root' });
    expect(vi.mocked(createContext)).toHaveBeenCalledWith(
      expect.objectContaining({ dir: '/custom/dir' }),
    );
  });

  it('calls Istanbul once with no-arg defaults (lcov survives filter)', () => {
    const fakeMap = {} as CoverageMap;
    generateReports(fakeMap);
    expect(vi.mocked(createReport)).toHaveBeenCalledTimes(1);
  });

  it('returns early without calling Istanbul when all reporters are actharness-handled', () => {
    const fakeMap = {} as CoverageMap;
    generateReports(fakeMap, { reporters: ['html', 'text'] });
    expect(vi.mocked(createReport)).not.toHaveBeenCalled();
    expect(vi.mocked(createContext)).not.toHaveBeenCalled();
  });

  it('returns early when reporters list is empty', () => {
    const fakeMap = {} as CoverageMap;
    generateReports(fakeMap, { reporters: [] });
    expect(vi.mocked(createReport)).not.toHaveBeenCalled();
  });
});

// ── generateActharnessReports ────────────────────────────────────────────────────

describe('generateActharnessReports', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'actharness-rep-test-')); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('calls generateHtmlReport for html reporter', () => {
    generateActharnessReports(makeEmptyReport(), { reporters: ['html'], dir: tmpDir });
    expect(vi.mocked(generateHtmlReport)).toHaveBeenCalledWith(
      expect.objectContaining({ files: {}, total: expect.any(Object) }),
      tmpDir,
      expect.any(String),
    );
  });

  it('calls generateHtmlReport for html-spa reporter', () => {
    generateActharnessReports(makeEmptyReport(), { reporters: ['html-spa'], dir: tmpDir });
    expect(vi.mocked(generateHtmlReport)).toHaveBeenCalledOnce();
  });

  it('calls buildTextReport and logs for text reporter', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    generateActharnessReports(makeEmptyReport(), { reporters: ['text'], dir: tmpDir });
    expect(vi.mocked(buildTextReport)).toHaveBeenCalledOnce();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('text report'))).toBe(true);
    spy.mockRestore();
  });

  it('calls buildTextSummary and logs for text-summary reporter', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    generateActharnessReports(makeEmptyReport(), { reporters: ['text-summary'], dir: tmpDir });
    expect(vi.mocked(buildTextSummary)).toHaveBeenCalledOnce();
    expect(spy.mock.calls.some((c) => String(c[0]).includes('text summary'))).toBe(true);
    spy.mockRestore();
  });

  it('uses default reporters (html + text) when none given', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    generateActharnessReports(makeEmptyReport(), { dir: tmpDir });
    expect(vi.mocked(generateHtmlReport)).toHaveBeenCalledOnce();
    expect(vi.mocked(buildTextReport)).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('silently ignores non-actharness reporter names (covers else-if false branch)', () => {
    generateActharnessReports(makeEmptyReport(), { reporters: ['none'] });
    expect(vi.mocked(generateHtmlReport)).not.toHaveBeenCalled();
    expect(vi.mocked(buildTextReport)).not.toHaveBeenCalled();
    expect(vi.mocked(buildTextSummary)).not.toHaveBeenCalled();
  });

  it('uses default dir (cwd/coverage) when dir not given', () => {
    generateActharnessReports(makeEmptyReport(), { reporters: ['html'] });
    expect(vi.mocked(generateHtmlReport)).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringContaining('coverage'),
      expect.any(String),
    );
  });
});
