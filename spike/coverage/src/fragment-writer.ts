import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { FileCoverageData } from 'istanbul-lib-coverage';

export const COVERAGE_TMP_DEFAULT = '/tmp/actspec-cov-spike';

export function getCoverageTmpDir(): string {
  return process.env['ACTSPEC_COVERAGE_TMP'] ?? COVERAGE_TMP_DEFAULT;
}

export function writeFragment(fragment: Record<string, FileCoverageData>): void {
  if (Object.keys(fragment).length === 0) return;

  const dir = getCoverageTmpDir();
  mkdirSync(dir, { recursive: true });

  // Use pid + hrtime for a unique filename within this worker process.
  const [sec, ns] = process.hrtime();
  const name = `fragment-${process.pid}-${sec}-${ns}.json`;
  writeFileSync(join(dir, name), JSON.stringify(fragment), 'utf8');
}
