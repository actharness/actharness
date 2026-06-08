// register.ts — loaded via --import before each test file.
// Injects describe/it/test/lifecycle hooks, stub actspec(), and expect() into globalThis
// so test files need zero imports. Also wires the coverage fragment flush (H6).

import { describe, it, test, before, after, beforeEach, afterEach } from 'node:test';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect } from './expect.ts';

// H1: inject node:test lifecycle globals (beforeAll/afterAll are aliases for before/after)
Object.assign(globalThis, {
  describe, it, test,
  before, after, beforeEach, afterEach,
  beforeAll: before, afterAll: after,
});

// Stub RunResult — fixed shape the matchers assert against.
// Replaced by the real @actspec/core result when the package is built.
const stubStep = {
  id: 'hello',
  name: 'Say hello',
  ran: true,
  outcome: 'success' as const,
  conclusion: 'success' as const,
  phase: 'main' as const,
};

function makeResult(conclusion: 'success' | 'failure' = 'success') {
  return {
    conclusion,
    outputs: { greeting: 'Hello World' },
    steps: [stubStep],
    env: {},
    annotations: [] as Array<{ level: string; message: string }>,
    stdout: 'greeting=Hello World\n',
    stderr: '',
    step(id: string) {
      return this.steps.find((s) => s.id === id);
    },
  };
}

function makeActionMock() {
  return {
    calls: [{ with: { name: 'World' }, env: {}, outputs: { greeting: 'Hello World' } }],
    called: true,
    callCount: 1,
  };
}

// Stub actspec() global — returns fake RunResult so test files can call
// actspec('./action.yml').run(...) without real action execution.
(globalThis as Record<string, unknown>)['actspec'] = (_source: string) => {
  const mock = makeActionMock();
  return {
    mock: (_ref: string, _def?: unknown) => mock,
    run: async (_input?: unknown) => makeResult(),
  };
};

// Inject actspec's own expect() — no Jest/Vitest dep (H4).
(globalThis as Record<string, unknown>)['expect'] = expect;

// H6: coverage fragment flush — write per-worker fragment on exit.
// Each worker subprocess writes a stub Istanbul FileCoverageData to ACTSPEC_COVERAGE_TMP.
// The host (cli.ts) reads and merges all fragments after all workers complete (H7).
const coverageTmpDir = process.env['ACTSPEC_COVERAGE_TMP'];
if (coverageTmpDir) {
  process.on('exit', () => {
    const fragment = {
      'action.yml': {
        path: 'action.yml',
        statementMap: {
          '0': { start: { line: 19, column: 0 }, end: { line: 21, column: 0 } },
        },
        fnMap: {},
        branchMap: {
          '0': {
            loc: { start: { line: 19, column: 0 }, end: { line: 21, column: 0 } },
            type: 'if',
            locations: [
              { start: { line: 19, column: 0 }, end: { line: 21, column: 0 } },
              { start: { line: 19, column: 0 }, end: { line: 21, column: 0 } },
            ],
            line: 19,
          },
        },
        s: { '0': 1 },
        f: {},
        b: { '0': [1, 0] },
      },
    };
    try {
      mkdirSync(coverageTmpDir, { recursive: true });
      const fragmentPath = `${coverageTmpDir}/fragment-${process.pid}-${randomUUID()}.json`;
      writeFileSync(fragmentPath, JSON.stringify(fragment));
    } catch {
      // best-effort: don't crash the test process over a coverage write
    }
  });
}
