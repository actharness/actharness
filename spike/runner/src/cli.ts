// cli.ts — minimal actspec test runner on top of node:test.
// Proves: file discovery (H3), --import globals injection (H1+H2), parallel workers (H3),
// pass/fail collection, and coverage fragment merge (H6+H7).

import { run } from 'node:test';
import { glob } from 'glob';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import istanbulCoverage from 'istanbul-lib-coverage';
import istanbulLibReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';

const { createCoverageMap } = istanbulCoverage;
const { createContext } = istanbulLibReport;
import { pathToFileURL, fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// ── arg parsing ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const coverageFlag = args.includes('--coverage');

// Collect --import <path> pairs for extra modules to load in each worker.
// Paths starting with ./ or ../ are resolved relative to CWD, then converted to file URLs.
const extraImports: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--import' && i + 1 < args.length) {
    const raw = args[++i]!;
    const resolved =
      raw.startsWith('./') || raw.startsWith('../')
        ? pathToFileURL(resolve(process.cwd(), raw)).href
        : raw;
    extraImports.push(resolved);
  }
}

const patterns = args.filter((a, i) => {
  if (a.startsWith('--')) return false;
  // skip values that follow --import
  if (args[i - 1] === '--import') return false;
  return true;
});

if (patterns.length === 0) {
  console.error('Usage: cli.ts [--coverage] <glob> [<glob>...]');
  process.exit(1);
}

// ── file discovery ───────────────────────────────────────────────────────────

const files: string[] = [];
for (const pattern of patterns) {
  const matches = await glob(pattern, { ignore: ['node_modules/**'], absolute: true });
  files.push(...matches);
}

if (files.length === 0) {
  console.error(`No test files found for: ${patterns.join(', ')}`);
  process.exit(1);
}

// ── coverage setup ───────────────────────────────────────────────────────────

const coverageTmpDir = coverageFlag
  ? join(tmpdir(), `actspec-cov-${Date.now()}`)
  : undefined;

const coverageOutDir = './coverage';

if (coverageTmpDir) {
  mkdirSync(coverageTmpDir, { recursive: true });
  // Workers inherit parent env — register.ts reads this to know it should flush.
  process.env['ACTSPEC_COVERAGE_TMP'] = coverageTmpDir;
}

// ── run files in parallel workers ────────────────────────────────────────────

const registerUrl = pathToFileURL(
  fileURLToPath(new URL('./register.ts', import.meta.url)),
).href;

const workerImports: string[] = [
  '--import', 'tsx/esm',
  '--import', registerUrl,
  ...extraImports.flatMap((p) => ['--import', p]),
];

const stream = run({
  files,
  concurrency: true,
  execArgv: workerImports,
});

// ── collect results ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

type TestEvent =
  | { type: 'test:pass'; data: { name: string; nesting: number } }
  | { type: 'test:fail'; data: { name: string; nesting: number; details: { error: Error } } }
  | { type: string; data: unknown };

for await (const raw of stream) {
  const event = raw as TestEvent;

  if (event.type === 'test:pass') {
    passed++;
    console.log(`  ✓ ${event.data.name}`);
  } else if (event.type === 'test:fail') {
    failed++;
    const err = event.data.details.error;
    console.log(`  ✗ ${event.data.name}`);
    console.log(`    ${err?.message ?? String(err)}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed`);

// ── coverage merge (H7) ───────────────────────────────────────────────────────

if (coverageTmpDir) {
  const map = createCoverageMap({});

  for (const file of readdirSync(coverageTmpDir)) {
    if (!file.endsWith('.json')) continue;
    const raw = JSON.parse(readFileSync(join(coverageTmpDir, file), 'utf8'));
    map.merge(createCoverageMap(raw));
  }

  mkdirSync(coverageOutDir, { recursive: true });
  const context = createContext({ dir: coverageOutDir, coverageMap: map });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (reports as any).create('text').execute(context);

  console.log(`\nCoverage written to ${coverageOutDir}/`);
}

process.exit(failed > 0 ? 1 : 0);
