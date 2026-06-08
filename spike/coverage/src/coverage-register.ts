// Loaded via --import in each worker subprocess alongside the runner's register.ts.
// Creates the CoverageCollector, registers it on the run sink, and flushes the
// Istanbul fragment to disk on process exit. The runner's CLI reads and merges
// all fragments after all workers complete.
//
// Under node:test's run(), workers are real child processes — process.on('exit', ...)
// fires reliably (proven in the runner spike, H6), so no afterAll/beforeExit dance needed.

import { CoverageCollector } from './collector.js';
import { writeFragment } from './fragment-writer.js';

export const collector = new CoverageCollector();
collector.register();

process.on('exit', () => {
  writeFragment(collector.getFragment());
});
