import { describe, it, expect } from 'vitest';
import { parsePythonCoverageJson } from '../src/python-coverage.js';

const SAMPLE_JSON = JSON.stringify({
  files: {
    '/tmp/script.py': {
      executed_lines: [1, 2, 4],
      missing_lines: [5, 6],
      executed_branches: [[2, 4], [4, -1]],
      missing_branches: [[2, 6]],
    },
  },
});

describe('parsePythonCoverageJson', () => {
  it('parses executed_lines, missing_lines, executed_branches, missing_branches', () => {
    const result = parsePythonCoverageJson(SAMPLE_JSON, '/tmp/script.py');
    expect(result.executedLines).toEqual([1, 2, 4]);
    expect(result.missingLines).toEqual([5, 6]);
    expect(result.executedBranches).toEqual([[2, 4], [4, -1]]);
    expect(result.missingBranches).toEqual([[2, 6]]);
  });

  it('looks up by scriptPath key first', () => {
    const result = parsePythonCoverageJson(SAMPLE_JSON, '/tmp/script.py');
    expect(result.executedLines).toHaveLength(3);
  });

  it('falls back to first file entry when scriptPath not found', () => {
    const result = parsePythonCoverageJson(SAMPLE_JSON, '/other/path.py');
    expect(result.executedLines).toEqual([1, 2, 4]);
  });

  it('returns empty arrays when files object is empty', () => {
    const result = parsePythonCoverageJson(JSON.stringify({ files: {} }), '/tmp/script.py');
    expect(result.executedLines).toEqual([]);
    expect(result.missingLines).toEqual([]);
    expect(result.executedBranches).toEqual([]);
    expect(result.missingBranches).toEqual([]);
  });

  it('returns empty arrays when files key is absent', () => {
    const result = parsePythonCoverageJson(JSON.stringify({}), '/tmp/script.py');
    expect(result.executedLines).toEqual([]);
    expect(result.missingLines).toEqual([]);
  });

  it('defaults missing sub-fields to empty arrays', () => {
    const json = JSON.stringify({ files: { '/tmp/script.py': {} } });
    const result = parsePythonCoverageJson(json, '/tmp/script.py');
    expect(result.executedLines).toEqual([]);
    expect(result.missingLines).toEqual([]);
    expect(result.executedBranches).toEqual([]);
    expect(result.missingBranches).toEqual([]);
  });
});
