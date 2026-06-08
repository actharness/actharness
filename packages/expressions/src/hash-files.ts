import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import type { ExprValue } from './types.js';
import { coerceToString } from './coerce.js';

// ── Minimal glob implementation (Node built-ins only) ────────────────────────

function matchSegment(pattern: string, segment: string): boolean {
  // Convert a single path segment glob pattern to a regex.
  // Supports * (any chars except /) and ? (one char except /).
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else {
      // Escape regex metacharacters
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  re += '$';
  return new RegExp(re).test(segment);
}

function matchParts(pp: readonly string[], fp: readonly string[], pi: number, fi: number): boolean {
  // Base case: consumed both pattern and path.
  if (pi === pp.length && fi === fp.length) return true;
  // Pattern exhausted but path has more segments.
  if (pi === pp.length) return false;

  const pat = pp[pi]!;

  if (pat === '**') {
    // ** matches 0 or more path segments.
    // Try skipping ** (0 segments consumed by **).
    if (matchParts(pp, fp, pi + 1, fi)) return true;
    // Try consuming 1..n path segments with **.
    for (let i = fi; i < fp.length; i++) {
      if (matchParts(pp, fp, pi + 1, i + 1)) return true;
    }
    return false;
  }

  if (fi === fp.length) return false;

  if (!matchSegment(pat, fp[fi]!)) return false;
  return matchParts(pp, fp, pi + 1, fi + 1);
}

function matchGlob(pattern: string, filePath: string): boolean {
  const p = pattern.replace(/\\/g, '/');
  const f = filePath.replace(/\\/g, '/');
  return matchParts(p.split('/'), f.split('/'), 0, 0);
}

// ── Recursive directory walk ──────────────────────────────────────────────────

function walkDir(dir: string, results: string[]): void {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(fullPath, results);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        try {
          // Follow symlinks: only add if target is a file.
          if (statSync(fullPath).isFile()) {
            results.push(fullPath);
          }
        } catch { /* ignore broken symlinks */ }
      }
    }
  } catch { /* ignore permission errors */ }
}

// ── hashFiles ─────────────────────────────────────────────────────────────────

export function hashFiles(...patterns: ExprValue[]): ExprValue {
  const workspace = process.env['GITHUB_WORKSPACE'] ?? process.cwd();

  // Collect all pattern strings; each arg may itself be a comma-separated list.
  const patternStrings = patterns
    .flatMap((p) => coerceToString(p).split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  if (patternStrings.length === 0) return '';

  const positive = patternStrings.filter((p) => !p.startsWith('!'));
  const negative = patternStrings.filter((p) => p.startsWith('!')).map((p) => p.slice(1));

  // Walk workspace and collect all file paths.
  const allFiles: string[] = [];
  walkDir(workspace, allFiles);

  // Filter to matching files, using relative paths for glob comparison.
  const matched = allFiles
    .filter((f) => {
      const rel = relative(workspace, f).replace(/\\/g, '/');
      const included = positive.some((pat) => matchGlob(pat, rel));
      const excluded = negative.some((pat) => matchGlob(pat, rel));
      return included && !excluded;
    })
    .sort(); // sorted order per spec

  if (matched.length === 0) return '';

  // SHA-256 each file, then SHA-256 the concatenated digests.
  const fileDigests = matched.map((f) => createHash('sha256').update(readFileSync(f)).digest());
  const combined = Buffer.concat(fileDigests);
  return createHash('sha256').update(combined).digest('hex');
}
