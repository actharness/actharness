// Parse sh/bash set -x trace output for line coverage.
// Matches ::COVERED::N:: markers emitted by our custom PS4.

export function parseShCoverage(stderr: string, headerLineCount: number): Record<number, number> {
  const hits: Record<number, number> = {};
  const re = /::COVERED::(\d+)::/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const originalLine = parseInt(m[1]!, 10) - headerLineCount;
    if (originalLine >= 1) {
      hits[originalLine] = (hits[originalLine] ?? 0) + 1;
    }
  }
  return hits;
}
