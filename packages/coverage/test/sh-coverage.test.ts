import { describe, it, expect } from 'vitest';
import { buildShStats } from '../src/sh-coverage.js';

describe('buildShStats', () => {
  it('empty source → total=0, covered=0, pct=100', () => {
    const result = buildShStats({}, '');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('blank-only source → total=0, covered=0, pct=100', () => {
    const result = buildShStats({}, '   \n\n  ');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('comment-only source → total=0, covered=0, pct=100', () => {
    const result = buildShStats({}, '# comment\n# another');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('one executable line, hit → covered=1, total=1, pct=100', () => {
    const result = buildShStats({ 1: 1 }, 'echo hello');
    expect(result.lines).toEqual({ covered: 1, total: 1, pct: 100 });
    expect(result.executableLines).toEqual([1]);
  });

  it('one executable line, not hit → covered=0, total=1, pct=0', () => {
    const result = buildShStats({}, 'echo hello');
    expect(result.lines).toEqual({ covered: 0, total: 1, pct: 0 });
    expect(result.executableLines).toEqual([1]);
  });

  it('multiple lines, partial hit → correct fractional pct', () => {
    const source = 'echo line1\necho line2\necho line3\necho line4';
    const result = buildShStats({ 1: 1, 3: 2 }, source);
    expect(result.lines.covered).toBe(2);
    expect(result.lines.total).toBe(4);
    expect(result.lines.pct).toBeCloseTo(50);
  });

  it('skips blank and comment lines, counts only executable', () => {
    const source = '# header\n\necho hi\n# comment\necho bye';
    const result = buildShStats({ 3: 1 }, source);
    expect(result.lines.total).toBe(2);
    expect(result.lines.covered).toBe(1);
    expect(result.lines.pct).toBeCloseTo(50);
  });

  it('all lines hit → pct=100', () => {
    const source = 'echo a\necho b';
    const result = buildShStats({ 1: 1, 2: 3 }, source);
    expect(result.lines.covered).toBe(2);
    expect(result.lines.pct).toBe(100);
  });

  it('else/fi included; else inherits from next command, fi from last command before', () => {
    const source = 'if [[ $x ]]; then\necho yes\nelse\necho no\nfi';
    // lineHits: condition evaluated (1), else-branch ran (4 hit), if-branch didn't (2 miss)
    // line 3 else → forward → echo no (line 4) → 1
    // line 5 fi   → backward → echo no (line 4) → 1
    const result = buildShStats({ 1: 1, 4: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4, 5]);
    expect(result.lines.total).toBe(5);
    expect(result.lines.covered).toBe(4); // line 2 (echo yes) not hit
    expect(result.effectiveHits[3]).toBe(1); // else → hits of echo no
    expect(result.effectiveHits[5]).toBe(1); // fi → hits of echo no
  });

  it('else inherits 0 hits when else-block not entered', () => {
    const source = 'if [[ $x ]]; then\necho yes\nelse\necho no\nfi';
    // if-branch ran, else didn't
    const result = buildShStats({ 1: 1, 2: 1 }, source);
    expect(result.effectiveHits[3]).toBe(0); // else → echo no = 0
    expect(result.effectiveHits[5]).toBe(0); // fi → echo no = 0
    expect(result.lines.covered).toBe(2); // lines 1 and 2
  });

  it('do/done included; do inherits from first body command, done from last', () => {
    const source = 'for i in 1 2\ndo\necho $i\ndone';
    // line 2 do   → forward → echo $i (line 3) → 2
    // line 4 done → backward → echo $i (line 3) → 2
    const result = buildShStats({ 1: 2, 3: 2 }, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4]);
    expect(result.lines.total).toBe(4);
    expect(result.lines.covered).toBe(4);
    expect(result.lines.pct).toBe(100);
    expect(result.effectiveHits[2]).toBe(2); // do → hits of echo $i
    expect(result.effectiveHits[4]).toBe(2); // done → hits of echo $i
  });

  it('then and fi with trailing comments inherit correctly', () => {
    const source = 'if [ $a ]; then # start\necho ok\nfi # end';
    // line 1: "if [ $a ]; then # start" — starts with "if", so COMMAND
    // line 3: "fi # end" — starts with "fi", so CLOSE
    const result = buildShStats({ 2: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3]);
    expect(result.lines.total).toBe(3);
    expect(result.effectiveHits[3]).toBe(1); // fi # end → hits of echo ok
  });

  it('"if [[ ]]; then" on same line is a command, not an open keyword', () => {
    const source = 'if [[ $x ]]; then\necho hi\nfi';
    const result = buildShStats({}, source);
    // "if [[ $x ]]; then" starts with "if" → COMMAND, not OPEN
    expect(result.executableLines).toEqual([1, 2, 3]);
    expect(result.effectiveHits[3]).toBe(0); // fi → echo hi = 0
  });

  it('esac included; inherits from last command before it', () => {
    const source = 'case $x in\na) echo a ;;\nesac';
    const result = buildShStats({ 1: 1, 2: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3]);
    expect(result.lines.total).toBe(3);
    expect(result.lines.covered).toBe(3);
    expect(result.effectiveHits[3]).toBe(1); // esac → hits of `a) echo a ;;`
  });

  it('open keyword with empty block stops forward scan at close keyword', () => {
    // else\nfi — else forward scan hits fi (close) → stop, no command found → effectiveHits[1]=0
    // fi backward scan — else is not a command → no command found → effectiveHits[2]=0
    const source = 'else\nfi';
    const result = buildShStats({}, source);
    expect(result.executableLines).toEqual([1, 2]);
    expect(result.effectiveHits[1]).toBe(0); // else → no command before fi
    expect(result.effectiveHits[2]).toBe(0); // fi → no command before
  });

  it('forward scan skips blank lines between open keyword and command', () => {
    // else\n\necho hi\nfi — blank line between else and echo hi
    // forward scan: j=1 (blank) → not close → continue; j=2 (echo hi=COMMAND) → hits[3]=undefined → 0
    const source = 'else\n\necho hi\nfi';
    const result = buildShStats({}, source);
    expect(result.executableLines).toEqual([1, 3, 4]); // blank line 2 excluded
    expect(result.effectiveHits[1]).toBe(0); // else → echo hi has no hit entry → 0
    expect(result.effectiveHits[4]).toBe(0); // fi → echo hi has no hit entry → 0
  });
});
