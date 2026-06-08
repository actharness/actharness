/**
 * C# "G15" invariant-culture number-to-string, faithfully reproduced.
 *
 * Rules (from EvaluationResult.cs / ExpressionUtility.cs):
 *  - Uppercase E for scientific notation
 *  - ≤15 significant digits, trailing zeros stripped
 *  - Scientific if exponent >= 15 or exponent < -4 (same threshold as C# G format)
 *  - Exponent sign always shown; minimum digits (no zero-padding)
 *
 * Corpus pins: 1.0→'1', 1.1→'1.1', 1234567890.0→'1234567890',
 *              12345678901234567890.0→'1.23456789012346E+19'
 */
export function numberToG15(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (!isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  if (n === 0) return '0';

  const abs = Math.abs(n);
  // Derive exponent via toExponential to avoid log10 fp drift.
  const expRaw = abs.toExponential();
  const expMatch = expRaw.match(/e([+-]\d+)$/);
  const exp = expMatch ? parseInt(expMatch[1]!, 10) : 0;

  if (exp >= 15 || exp < -4) {
    // Scientific: 14 decimal places in mantissa = 15 sig figs total.
    const raw = n.toExponential(14); // e.g. "1.23456789012346e+19"
    const eIdx = raw.indexOf('e');
    const mantissa = raw.slice(0, eIdx).replace(/\.?0+$/, '');
    const expNum = parseInt(raw.slice(eIdx + 1), 10);
    const sign = expNum >= 0 ? '+' : '-';
    return `${mantissa}E${sign}${Math.abs(expNum)}`;
  }

  // Fixed: 14 - exp decimal places gives 15 sig figs.
  const dp = Math.max(0, 14 - exp);
  const fixed = n.toFixed(dp);
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed;
}
