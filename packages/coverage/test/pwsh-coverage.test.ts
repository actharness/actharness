import { describe, it, expect } from 'vitest';
import { buildPwshStats } from '../src/pwsh-coverage.js';

describe('buildPwshStats', () => {
  it('empty source → total=0, covered=0, pct=100', () => {
    const result = buildPwshStats({}, '');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('blank-only source → total=0, covered=0, pct=100', () => {
    const result = buildPwshStats({}, '   \n\n  ');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('comment-only source → total=0, covered=0, pct=100', () => {
    const result = buildPwshStats({}, '# comment\n# another');
    expect(result.lines).toEqual({ covered: 0, total: 0, pct: 100 });
    expect(result.executableLines).toEqual([]);
  });

  it('one executable line, hit → covered=1, total=1, pct=100', () => {
    const result = buildPwshStats({ 1: 1 }, 'Write-Output "hello"');
    expect(result.lines).toEqual({ covered: 1, total: 1, pct: 100 });
    expect(result.executableLines).toEqual([1]);
  });

  it('one executable line, not hit → covered=0, total=1, pct=0', () => {
    const result = buildPwshStats({}, 'Write-Output "hello"');
    expect(result.lines).toEqual({ covered: 0, total: 1, pct: 0 });
    expect(result.executableLines).toEqual([1]);
  });

  it('multiple lines, partial hit → correct fractional pct', () => {
    const source = 'Write-Output "a"\nWrite-Output "b"\nWrite-Output "c"\nWrite-Output "d"';
    const result = buildPwshStats({ 1: 1, 3: 2 }, source);
    expect(result.lines.covered).toBe(2);
    expect(result.lines.total).toBe(4);
    expect(result.lines.pct).toBeCloseTo(50);
  });

  it('skips blank and comment lines, counts only executable', () => {
    const source = '# header\n\nWrite-Output "hi"\n# comment\nWrite-Output "bye"';
    const result = buildPwshStats({ 3: 1 }, source);
    expect(result.lines.total).toBe(2);
    expect(result.lines.covered).toBe(1);
    expect(result.lines.pct).toBeCloseTo(50);
  });

  it('all lines hit → pct=100', () => {
    const source = 'Write-Output "a"\nWrite-Output "b"';
    const result = buildPwshStats({ 1: 1, 2: 3 }, source);
    expect(result.lines.covered).toBe(2);
    expect(result.lines.pct).toBe(100);
  });

  it('standalone } is a close keyword; inherits from last command before it', () => {
    const source = 'if ($x) {\nWrite-Output "yes"\n}';
    // line 1: if ($x) {   → command
    // line 2: Write-Output → command
    // line 3: }            → close → backward → Write-Output (line 2)
    const result = buildPwshStats({ 1: 1, 2: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3]);
    expect(result.lines.total).toBe(3);
    expect(result.lines.pct).toBe(100);
    expect(result.effectiveHits[3]).toBe(1); // } → hits of Write-Output "yes"
  });

  it('} else { is an open keyword; inherits from first command after it', () => {
    const source = 'if ($x) {\nWrite-Output "yes"\n} else {\nWrite-Output "no"\n}';
    // line 3: } else {  → open → forward → Write-Output "no" (line 4)
    // line 5: }         → close → backward → Write-Output "no" (line 4)
    const result = buildPwshStats({ 1: 1, 4: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4, 5]);
    expect(result.lines.total).toBe(5);
    expect(result.lines.covered).toBe(4); // line 2 not hit
    expect(result.effectiveHits[3]).toBe(1); // } else { → hits of Write-Output "no"
    expect(result.effectiveHits[5]).toBe(1); // } → hits of Write-Output "no"
  });

  it('} catch { and } finally { are open keywords; inherit from first command after each', () => {
    const source = 'try {\nRisky\n} catch {\nHandle\n} finally {\nCleanup\n}';
    // line 3: } catch {   → open → Handle (line 4)
    // line 5: } finally { → open → Cleanup (line 6)
    // line 7: }           → close → Cleanup (line 6)
    const result = buildPwshStats({ 1: 1, 2: 1, 4: 1, 6: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(result.lines.total).toBe(7);
    expect(result.lines.pct).toBe(100);
    expect(result.effectiveHits[3]).toBe(1); // } catch { → Handle
    expect(result.effectiveHits[5]).toBe(1); // } finally { → Cleanup
    expect(result.effectiveHits[7]).toBe(1); // } → Cleanup
  });

  it('} catch [System.Exception] { is an open keyword', () => {
    const source = 'try {\nRisky\n} catch [System.Exception] {\nHandle\n}';
    const result = buildPwshStats({ 1: 1, 2: 1, 4: 1 }, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4, 5]);
    expect(result.lines.total).toBe(5);
    expect(result.effectiveHits[3]).toBe(1); // } catch [System.Exception] { → Handle
    expect(result.effectiveHits[5]).toBe(1); // } → Handle
  });

  it('} elseif ($x) { has a condition — treated as a command, not an open keyword', () => {
    const source = 'if ($a) {\nWrite-Output "a"\n} elseif ($b) {\nWrite-Output "b"\n}';
    // line 3: } elseif ($b) { → NOT an open keyword (has condition) → command
    // line 5: }               → close → backward → Write-Output "b" (line 4)
    const result = buildPwshStats({}, source);
    expect(result.executableLines).toEqual([1, 2, 3, 4, 5]);
    expect(result.effectiveHits[5]).toBe(0); // } → Write-Output "b" = 0
  });

  it('open keyword with empty block stops forward scan at close keyword', () => {
    // } else { followed immediately by } — forward scan hits } (close) → stop, no command found
    // } backward scan — } else { is not a command → no command found
    const source = '} else {\n}';
    const result = buildPwshStats({}, source);
    expect(result.executableLines).toEqual([1, 2]);
    expect(result.effectiveHits[1]).toBe(0); // } else { → no command before }
    expect(result.effectiveHits[2]).toBe(0); // } → no command before
  });

  it('forward scan skips blank lines between open keyword and command', () => {
    // blank line between } else { and command → forward scan continues past blank
    // command has no lineHits entry → effectiveHits inherits 0 via ?? 0
    const source = '} else {\n\nWrite-Output "not hit"\n}';
    const result = buildPwshStats({}, source);
    expect(result.executableLines).toEqual([1, 3, 4]); // blank line 2 excluded
    expect(result.effectiveHits[1]).toBe(0); // } else { → Write-Output "not hit" has no entry → 0
    expect(result.effectiveHits[4]).toBe(0); // } → Write-Output "not hit" has no entry → 0
  });
});
