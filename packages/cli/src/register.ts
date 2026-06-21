// Worker bootstrap — loaded via --import by actharness test workers.
// Injects node:test lifecycle functions + actharness + expect into globalThis.
// Wraps describe/it/test/beforeEach/afterEach to manage the mock scope stack.

import { actharness } from '@actharness/core';
import { globalMock, globalMockOnce, globalResetMocks, fileRootRegistry } from '@actharness/core';
import { expect } from '@actharness/matchers';
import {
  describe, it, test,
  before, after,
  beforeEach, afterEach,
  beforeAll, afterAll,
} from './lifecycle.js';

// Side-effectful: registers the composite and node executors.
import '@actharness/composite';
import '@actharness/node';
import { mockGitHubApi, mockGitHubApiOnce, mockNetwork, mockNetworkOnce, resetNetworkMocks } from '@actharness/node';

// ── Inject lifecycle functions ────────────────────────────────────────────────

Object.assign(globalThis, {
  describe, it, test,
  before, after,
  beforeEach, afterEach,
  beforeAll, afterAll,
});

// ── actharness with global mock API ──────────────────────────────────────────────

const actharnessWithMocks = Object.assign(actharness, {
  mock: globalMock,
  mockOnce: globalMockOnce,
  resetMocks: () => { globalResetMocks(); resetNetworkMocks(); },
  mockGitHubApi,
  mockGitHubApiOnce,
  mockNetwork,
  mockNetworkOnce,
});


(globalThis as Record<string, unknown>)['actharness'] = actharnessWithMocks;
(globalThis as Record<string, unknown>)['expect'] = expect;

// ── Coverage fragment flush ───────────────────────────────────────────────────

const coverageTmpDir = process.env['ACTHARNESS_COVERAGE_TMP'];
if (coverageTmpDir) {
  const { CoverageCollector } = await import('@actharness/coverage');
  const { registerRunListener } = await import('@actharness/core');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { randomUUID } = await import('node:crypto');

  const collector = new CoverageCollector();
  registerRunListener(collector.createListener());

  process.on('exit', () => {
    try {
      mkdirSync(coverageTmpDir, { recursive: true });
      const fragment = collector.toFragment();
      const fragmentPath = join(
        coverageTmpDir,
        `fragment-${process.pid}-${randomUUID()}.json`,
      );
      writeFileSync(fragmentPath, JSON.stringify(fragment));
    } catch {
      // best-effort — never crash the test process on a coverage write failure
    }
  });
}

// Suppress unused import warning — fileRootRegistry is exported for completeness.
void fileRootRegistry;
