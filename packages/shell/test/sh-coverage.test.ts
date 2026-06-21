import { describe, it, expect } from 'vitest';
import { parseShCoverage } from '../src/sh-coverage.js';

describe('parseShCoverage', () => {
  it('returns empty object for empty stderr', () => {
    expect(parseShCoverage('', 3)).toEqual({});
  });

  it('returns empty object when no markers present', () => {
    expect(parseShCoverage('some random stderr\nno markers here', 3)).toEqual({});
  });

  it('parses a single marker and subtracts header offset', () => {
    const hits = parseShCoverage('::COVERED::5::', 3);
    expect(hits[2]).toBe(1);
  });

  it('skips lines where originalLine is zero after offset', () => {
    const hits = parseShCoverage('::COVERED::3::', 3);
    expect(Object.keys(hits).length).toBe(0);
  });

  it('skips lines where originalLine is negative after offset', () => {
    const hits = parseShCoverage('::COVERED::1::', 3);
    expect(Object.keys(hits).length).toBe(0);
  });

  it('accumulates hit count for the same line number', () => {
    const stderr = '::COVERED::4::\n::COVERED::4::\n::COVERED::4::';
    const hits = parseShCoverage(stderr, 3);
    expect(hits[1]).toBe(3);
  });

  it('handles multiple distinct lines', () => {
    const stderr = '::COVERED::4::\n::COVERED::5::\n::COVERED::6::';
    const hits = parseShCoverage(stderr, 3);
    expect(hits[1]).toBe(1);
    expect(hits[2]).toBe(1);
    expect(hits[3]).toBe(1);
  });

  it('handles markers embedded mid-line (e.g. shell command text follows)', () => {
    const hits = parseShCoverage('::COVERED::7::echo hello', 3);
    expect(hits[4]).toBe(1);
  });

  it('handles multiple markers on one line', () => {
    const hits = parseShCoverage('::COVERED::4::::COVERED::5::', 3);
    expect(hits[1]).toBe(1);
    expect(hits[2]).toBe(1);
  });
});
