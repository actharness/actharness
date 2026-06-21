// Build line-coverage stats from sh/bash set -x trace hits.

import type { CoverageStat } from './types.js';

// Bare keywords that open a new block — inherit hits from the first command after them.
const SH_OPEN = /^(else|then|do)([\s;#]|$)/;
// Bare keywords that close a block — inherit hits from the last command before them.
const SH_CLOSE = /^(fi|done|esac)([\s;#]|$)/;

type ShLineType = 'blank' | 'command' | 'open' | 'close';

function classifyShLine(raw: string): ShLineType {
  const line = raw.trim();
  if (line === '' || line.startsWith('#')) return 'blank';
  if (SH_OPEN.test(line)) return 'open';
  if (SH_CLOSE.test(line)) return 'close';
  return 'command';
}

export function buildShStats(
  lineHits: Record<number, number>,
  source: string,
): { lines: CoverageStat; executableLines: number[]; effectiveHits: Record<number, number> } {
  const sourceLines = source.split('\n');
  const types: ShLineType[] = sourceLines.map((l) => classifyShLine(l));

  // Start with raw hits; patch in propagated values for open/close keywords.
  const effectiveHits: Record<number, number> = { ...lineHits };

  for (let i = 0; i < sourceLines.length; i++) {
    const lineNum = i + 1;
    if (types[i] === 'open') {
      // Forward scan: inherit from the first command that follows (stop at close).
      let found = false;
      for (let j = i + 1; j < sourceLines.length; j++) {
        if (types[j] === 'command') {
          effectiveHits[lineNum] = lineHits[j + 1] ?? 0;
          found = true;
          break;
        }
        if (types[j] === 'close') break;
      }
      if (!found) effectiveHits[lineNum] = 0;
    } else if (types[i] === 'close') {
      // Backward scan: inherit from the nearest command before this keyword.
      let found = false;
      for (let j = i - 1; j >= 0; j--) {
        if (types[j] === 'command') {
          effectiveHits[lineNum] = lineHits[j + 1] ?? 0;
          found = true;
          break;
        }
      }
      if (!found) effectiveHits[lineNum] = 0;
    }
  }

  const executableLines: number[] = [];
  for (let i = 0; i < sourceLines.length; i++) {
    if (types[i] !== 'blank') executableLines.push(i + 1);
  }

  const total = executableLines.length;
  const covered = executableLines.filter((n) => (effectiveHits[n] ?? 0) > 0).length;
  const pct = total === 0 ? 100 : (covered / total) * 100;
  return { lines: { covered, total, pct }, executableLines, effectiveHits };
}
