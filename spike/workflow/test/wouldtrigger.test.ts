// Tests for wouldTrigger — H7 (standalone, no new evaluator APIs needed).
// Also probes: probe #6 (paths filter with no changedFiles), probe #10 (per-job ids).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspecWorkflow } from '../src/index.js';
import type { Workflow } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CI = join(__dirname, '../fixtures/ci.yml');

describe('wouldTrigger (H7)', () => {
  let wf: Workflow;

  beforeEach(() => {
    wf = actspecWorkflow(CI);
  });

  // H7: push to main with matching src/ path triggers.
  test('push to main with src/ file triggers (H7)', () => {
    const r = wf.wouldTrigger({ event: 'push', ref: 'refs/heads/main', changedFiles: ['src/index.ts'] });
    expect(r.triggered).toBe(true);
    expect(r.jobs).toContain('build');
    expect(r.jobs).toContain('deploy');
    expect(r.jobs).toContain('notify');
  });

  // H7: push to non-matching branch does not trigger.
  test('push to feature branch does not trigger (branches filter)', () => {
    const r = wf.wouldTrigger({ event: 'push', ref: 'refs/heads/feature/foo', changedFiles: ['src/a.ts'] });
    expect(r.triggered).toBe(false);
    expect(r.reason).toMatch(/branches filter/);
  });

  // Probe #6 (FINDING): paths filter with no changedFiles — conservative: not triggered.
  test('FINDING probe #6: push to main with no changedFiles is not triggered', () => {
    const r = wf.wouldTrigger({ event: 'push', ref: 'refs/heads/main' });
    expect(r.triggered).toBe(false);
    expect(r.reason).toMatch(/changedFiles/);
  });

  // H7: pull_request opened triggers.
  test('pull_request opened triggers (types filter)', () => {
    const r = wf.wouldTrigger({ event: 'pull_request', payload: { action: 'opened' } });
    expect(r.triggered).toBe(true);
  });

  // H7: pull_request closed does not trigger (not in types).
  test('pull_request closed does not trigger', () => {
    const r = wf.wouldTrigger({ event: 'pull_request', payload: { action: 'closed' } });
    expect(r.triggered).toBe(false);
    expect(r.reason).toMatch(/type/i);
  });

  // H7: schedule event triggers (cron not evaluated, just event name match).
  test('schedule event triggers', () => {
    const r = wf.wouldTrigger({ event: 'schedule' });
    expect(r.triggered).toBe(true);
  });

  // H7: unknown event does not trigger.
  test('unknown event does not trigger', () => {
    const r = wf.wouldTrigger({ event: 'release' });
    expect(r.triggered).toBe(false);
    expect(r.reason).toMatch(/not in on:/);
  });

  // H7: push to release/1.0 branch (glob match release/**) triggers.
  test('push to release/** branch triggers (glob match)', () => {
    const r = wf.wouldTrigger({ event: 'push', ref: 'refs/heads/release/1.0', changedFiles: ['src/a.ts'] });
    expect(r.triggered).toBe(true);
  });

  // H7: push with only docs/ files (paths filter excludes non-src).
  test('push with only non-src files does not trigger (paths filter)', () => {
    const r = wf.wouldTrigger({ event: 'push', ref: 'refs/heads/main', changedFiles: ['README.md', 'docs/guide.md'] });
    expect(r.triggered).toBe(false);
    expect(r.reason).toMatch(/paths filter/);
  });
});
