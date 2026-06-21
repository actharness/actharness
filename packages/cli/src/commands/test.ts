// actharness test — purpose-built test runner on top of node:test.

import { run } from 'node:test';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { availableParallelism, tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { glob } from 'glob';
import { CoverageCollector, generateReports, generateActharnessReports, ACTHARNESS_REPORTER_NAMES } from '@actharness/coverage';
import type { ReporterName, CoverageMetric } from '@actharness/coverage';
import type { InputExerciseEntry, OutputExerciseEntry, StepReachedEntry } from '@actharness/coverage';
import { loadConfig } from '../config.js';
import type { ActharnessConfig } from '../config.js';

export interface TestOptions {
  patterns: string[];
  coverage: boolean;
  reporters: ReporterName[];
  coverageDir: string;
  thresholds: Record<string, number>;
  workers?: number;
}

export interface TestResult {
  passed: number;
  failed: number;
  thresholdFailed: boolean;
}

export function parseTestArgs(args: string[], config: ActharnessConfig = {}): TestOptions {
  const patterns: string[] = [];
  const reporters: ReporterName[] = [];
  const thresholds: Record<string, number> = { ...config.thresholds };
  let coverage = config.coverage ?? false;
  let coverageDir = config.coverageDir
    ? resolve(process.cwd(), config.coverageDir)
    : join(process.cwd(), 'coverage');
  let workers = config.workers ?? Math.max(1, availableParallelism() - 1);

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--coverage') {
      coverage = true;
    } else if (arg === '--workers' && i + 1 < args.length) {
      workers = Math.max(1, parseInt(args[++i]!, 10) || 1);
    } else if (arg === '--reporter' && i + 1 < args.length) {
      reporters.push(...(args[++i]!.split(',') as ReporterName[]));
    } else if (arg === '--coverage-dir' && i + 1 < args.length) {
      coverageDir = resolve(process.cwd(), args[++i]!);
    } else if (arg === '--threshold' && i + 1 < args.length) {
      const pair = args[++i]!;
      const eq = pair.indexOf('=');
      if (eq !== -1) {
        thresholds[pair.slice(0, eq)] = Number(pair.slice(eq + 1));
      }
    } else if (!arg.startsWith('--')) {
      patterns.push(arg);
    }
  }

  if (patterns.length === 0) {
    if (config.patterns && config.patterns.length > 0) {
      patterns.push(...config.patterns);
    } else {
      patterns.push('**/*.{actharness,test}.ts');
    }
  }

  if (coverage && reporters.length === 0) {
    if (config.reporters && config.reporters.length > 0) {
      reporters.push(...(config.reporters as ReporterName[]));
    } else {
      reporters.push('lcov', 'html', 'text');
    }
  }

  return { patterns, coverage, reporters, coverageDir, thresholds, workers };
}

export function defaultRegisterUrl(): string {
  return pathToFileURL(
    fileURLToPath(new URL('./register.js', import.meta.url)),
  ).href;
}

export async function checkThresholds(
  collector: CoverageCollector,
  thresholds: Record<string, number>,
  outDir: string,
): Promise<boolean> {
  if (Object.keys(thresholds).length === 0) return false;
  const report = await collector.toCoverageReport();
  let failed = false;
  for (const [key, min] of Object.entries(thresholds)) {
    const stat = report.total[key as CoverageMetric];
    const pct = stat?.pct ?? 0;
    if (pct < min) {
      console.error(`Coverage threshold not met: ${key} ${pct.toFixed(2)}% < ${min}%`);
      failed = true;
    }
  }
  if (failed) {
    console.error(`See ${outDir}/ for the full coverage report`);
  }
  return failed;
}

export function mergeCoverageData(tmpDir: string): CoverageCollector {
  const collector = new CoverageCollector();
  for (const file of readdirSync(tmpDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(readFileSync(join(tmpDir, file), 'utf8')) as {
        istanbulMap?: unknown;
        inputExercises?: InputExerciseEntry[];
        outputExercises?: OutputExerciseEntry[];
        stepReachedExercises?: StepReachedEntry[];
        jsCoverageEntries?: import('@actharness/coverage').JsCoverageEntry[];
        shShellCoverageEntries?: import('@actharness/coverage').ShShellCoverageEntry[];
        bashShellCoverageEntries?: import('@actharness/coverage').ShShellCoverageEntry[];
        pwshShellCoverageEntries?: import('@actharness/coverage').ShShellCoverageEntry[];
        pythonShellCoverageEntries?: import('@actharness/coverage').PythonShellCoverageEntry[];
        nodeShellCoverageEntries?: import('@actharness/coverage').NodeShellCoverageEntry[];
      };
      const fragment = CoverageCollector.fromParts(
        raw.istanbulMap ?? raw,
        raw.inputExercises ?? [],
        raw.outputExercises ?? [],
        raw.stepReachedExercises ?? [],
        raw.jsCoverageEntries ?? [],
        raw.shShellCoverageEntries ?? [],
        raw.bashShellCoverageEntries ?? [],
        raw.pwshShellCoverageEntries ?? [],
        raw.pythonShellCoverageEntries ?? [],
        raw.nodeShellCoverageEntries ?? [],
      );
      collector.merge(fragment);
    } catch {
      // skip malformed fragments
    }
  }
  return collector;
}

type RawTestEvent = { type: string; data: unknown };
type TestEventData = { name: string; nesting: number; file?: string; details?: { duration_ms?: number; error?: Error } };
type LineEntry = { indent: string; icon: string; name: string; hasChild: boolean; errorLines: string[] };

async function runWithPool(tasks: (() => Promise<void>)[], limit: number): Promise<void> {
  const queue = [...tasks];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      let task: (() => Promise<void>) | undefined;
      while ((task = queue.shift()) !== undefined) {
        await task();
      }
    }),
  );
}

async function runOneFile(
  file: string,
  execArgv: string[],
): Promise<{ passed: number; failed: number; lines: LineEntry[] }> {
  // node:test run() types vary by @types/node version; cast to accept execArgv.
  const stream = run({ files: [file], execArgv } as Parameters<typeof run>[0]);
  const lines: LineEntry[] = [];
  const nestingStacks = new Map<number, number[]>();
  let passed = 0;
  let failed = 0;

  for await (const raw of stream) {
    const event = raw as RawTestEvent;
    const d = event.data as TestEventData;

    // Skip the file-suite wrapper event: nesting=0 with no d.file (top-level tests have d.file set).
    if (d.nesting === 0 && !d.file) continue;

    if (event.type === 'test:start') {
      const idx = lines.length;
      lines.push({ indent: '  '.repeat(d.nesting + 1), icon: '', name: d.name, hasChild: false, errorLines: [] });
      if (d.nesting > 0) {
        const parentStack = nestingStacks.get(d.nesting - 1);
        if (parentStack?.length) lines[parentStack[parentStack.length - 1]!]!.hasChild = true;
      }
      if (!nestingStacks.has(d.nesting)) nestingStacks.set(d.nesting, []);
      nestingStacks.get(d.nesting)!.push(idx);
    } else if (event.type === 'test:pass' || event.type === 'test:fail') {
      const idx = nestingStacks.get(d.nesting)?.pop();
      if (idx !== undefined) {
        const line = lines[idx]!;
        if (!line.hasChild) {
          if (event.type === 'test:pass') {
            line.icon = '✓ ';
            passed++;
          } else {
            line.icon = '✗ ';
            failed++;
            if (d.details) {
              const err = d.details.error;
              line.errorLines.push(`${line.indent}  ${err?.message ?? String(err)}`);
            }
          }
        }
      }
    }
  }

  return { passed, failed, lines };
}

export async function runTests(
  opts: TestOptions,
  registerUrl = defaultRegisterUrl(),
  tsxEsmUrl = import.meta.resolve('tsx/esm'),
): Promise<TestResult> {
  const { patterns, coverage, reporters, coverageDir, thresholds } = opts;
  const workers = opts.workers ?? Math.max(1, availableParallelism() - 1);

  const files: string[] = [];
  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      ignore: ['node_modules/**'],
      absolute: true,
      cwd: process.cwd(),
    });
    files.push(...matches);
  }

  if (files.length === 0) {
    console.error(`actharness: no test files found for: ${patterns.join(', ')}`);
    return { passed: 0, failed: 1, thresholdFailed: false };
  }

  const coverageTmpDir = coverage
    ? join(tmpdir(), `actharness-cov-${process.hrtime.bigint()}`)
    : undefined;

  if (coverageTmpDir) {
    mkdirSync(coverageTmpDir, { recursive: true });
    process.env['ACTHARNESS_COVERAGE_TMP'] = coverageTmpDir;
  }

  const execArgv: string[] = ['--import', tsxEsmUrl, '--import', registerUrl];

  let passed = 0;
  let failed = 0;

  await runWithPool(
    files.map((file) => async () => {
      const result = await runOneFile(file, execArgv);
      passed += result.passed;
      failed += result.failed;
      if (result.lines.length > 0) {
        const relPath = relative(process.cwd(), file);
        console.log(`\n${relPath}`);
        for (const line of result.lines) {
          console.log(`${line.indent}${line.icon}${line.name}`);
          for (const errLine of line.errorLines) console.log(errLine);
        }
      }
    }),
    workers,
  );

  console.log(`\n${passed} passed, ${failed} failed`);

  if (coverageTmpDir) {
    delete process.env['ACTHARNESS_COVERAGE_TMP'];
    const collector = mergeCoverageData(coverageTmpDir);
    mkdirSync(coverageDir, { recursive: true });
    const istanbulReporters = reporters.filter((r) => !ACTHARNESS_REPORTER_NAMES.has(r));
    const actharnessReporters = reporters.filter((r) => ACTHARNESS_REPORTER_NAMES.has(r));
    generateReports(collector.coverageMap, { reporters: istanbulReporters, dir: coverageDir, projectRoot: process.cwd() });
    if (actharnessReporters.length > 0) {
      generateActharnessReports(await collector.toCoverageReport(), { reporters: actharnessReporters, dir: coverageDir, cwd: process.cwd() });
    }
    writeFileSync(
      join(coverageDir, 'coverage-final.json'),
      JSON.stringify(collector.coverageMap.toJSON(), null, 2),
    );
    console.log(`\nCoverage report written to ${coverageDir}/`);
    const thresholdFailed = await checkThresholds(collector, thresholds, coverageDir);
    return { passed, failed, thresholdFailed };
  }

  return { passed, failed, thresholdFailed: false };
}

export async function testCommand(
  args: string[],
  registerUrl?: string,
  tsxEsmUrl?: string,
): Promise<number> {
  const config = await loadConfig(process.cwd());
  const opts = parseTestArgs(args, config);
  const { failed, thresholdFailed } = await runTests(opts, registerUrl, tsxEsmUrl);
  return failed > 0 || thresholdFailed ? 1 : 0;
}
