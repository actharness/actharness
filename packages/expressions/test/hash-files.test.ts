import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { evaluate } from '../src/index.js';

// Workspace layout:
//   a.ts             → 'content-a'
//   b.txt            → 'content-b'
//   sub/c.ts         → 'content-c'
//   sub/deep/e.ts    → 'content-e'
const WORKSPACE = join(tmpdir(), `actspec-hf-${process.pid}`);

function sha256(data: string): Buffer {
  return createHash('sha256').update(Buffer.from(data, 'utf8')).digest();
}

function expectedHash(...fileContents: string[]): string {
  return createHash('sha256')
    .update(Buffer.concat(fileContents.map(sha256)))
    .digest('hex');
}

describe('hashFiles', () => {
  beforeAll(() => {
    mkdirSync(join(WORKSPACE, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(WORKSPACE, 'a.ts'), 'content-a');
    writeFileSync(join(WORKSPACE, 'b.txt'), 'content-b');
    writeFileSync(join(WORKSPACE, 'sub', 'c.ts'), 'content-c');
    writeFileSync(join(WORKSPACE, 'sub', 'deep', 'e.ts'), 'content-e');
    // Broken symlink — exercises the inner catch in walkDir (statSync throws)
    symlinkSync('/non-existent-target-xyz', join(WORKSPACE, 'broken.ts'));
    process.env['GITHUB_WORKSPACE'] = WORKSPACE;
  });

  afterAll(() => {
    delete process.env['GITHUB_WORKSPACE'];
    rmSync(WORKSPACE, { recursive: true, force: true });
  });

  test('no match → empty string', () => {
    expect(evaluate("hashFiles('no-such-file')")).toBe('');
  });

  test('* wildcard matches top-level .ts file (exercises matchSegment * branch)', () => {
    // '*.ts' matches only a.ts at root level
    expect(evaluate("hashFiles('*.ts')")).toBe(expectedHash('content-a'));
  });

  test('? wildcard matches single character (exercises matchSegment ? branch)', () => {
    // '?.ts' matches 'a.ts' — one char before .ts
    expect(evaluate("hashFiles('?.ts')")).toBe(expectedHash('content-a'));
  });

  test('** inner loop: path with intermediate segment (exercises ** for-loop return)', () => {
    // sub/deep/e.ts: ** skip fails (*.ts doesn't match 'deep'), loop advances to depth 2 → succeeds
    // sub/c.ts: ** skip succeeds immediately
    // sorted order: WORKSPACE/sub/c.ts < WORKSPACE/sub/deep/e.ts
    expect(evaluate("hashFiles('sub/**/*.ts')")).toBe(expectedHash('content-c', 'content-e'));
  });

  test('**/*.ts matches all .ts files across all depths', () => {
    // a.ts, sub/c.ts, sub/deep/e.ts — sorted by absolute path
    expect(evaluate("hashFiles('**/*.ts')")).toBe(
      expectedHash('content-a', 'content-c', 'content-e'),
    );
  });

  test('negation pattern excludes matching files', () => {
    // **/*.ts minus sub/**/*.ts → only a.ts
    expect(evaluate("hashFiles('**/*.ts', '!sub/**/*.ts')")).toBe(expectedHash('content-a'));
  });

  test('hash is deterministic across calls', () => {
    expect(evaluate("hashFiles('**/*.ts')")).toBe(evaluate("hashFiles('**/*.ts')"));
  });

  test('comma-separated patterns in one argument', () => {
    // 'a.ts,b.txt' → two patterns; sorted: WORKSPACE/a.ts < WORKSPACE/b.txt
    expect(evaluate("hashFiles('a.ts,b.txt')")).toBe(expectedHash('content-a', 'content-b'));
  });

  test('hashFiles is overridable via ctx.functions', () => {
    const result = evaluate("hashFiles('**/*.ts')", {
      functions: { hashfiles: () => 'mocked' },
    });
    expect(result).toBe('mocked');
  });

  test('empty pattern string → empty string (patternStrings.length === 0 path)', () => {
    expect(evaluate("hashFiles('')")).toBe('');
  });

  test('pattern shorter than path — exhausted pattern returns no match (line 32 path)', () => {
    // 'sub/deep' matches 'sub/deep' prefix but sub/deep/e.ts has one extra segment
    // matchParts: pattern consumed but path still has 'e.ts' → return false → no files matched
    expect(evaluate("hashFiles('sub/deep')")).toBe('');
  });

  test('broken symlink is silently skipped (inner walkDir catch)', () => {
    // broken.ts is a symlink to /non-existent-target-xyz; statSync throws → caught
    // *.ts still matches a.ts; broken.ts is skipped, not added to results
    expect(evaluate("hashFiles('*.ts')")).toBe(expectedHash('content-a'));
  });

  test('non-existent workspace directory is handled gracefully (outer walkDir catch)', () => {
    // readdirSync throws ENOENT → caught by outer catch → no files → returns ''
    const saved = process.env['GITHUB_WORKSPACE'];
    process.env['GITHUB_WORKSPACE'] = '/non-existent-workspace-xyz-12345';
    try {
      expect(evaluate("hashFiles('**/*.ts')")).toBe('');
    } finally {
      process.env['GITHUB_WORKSPACE'] = saved;
    }
  });
});
