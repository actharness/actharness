// Scenario E — pre-entrypoint / post-entrypoint lifecycle + GITHUB_STATE threading. Validates H6.
// Requires a Docker daemon. Run with: npm run test:docker

import { describe, test, expect, beforeAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';
import { clearImageCache } from '../src/container.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES      = join(__dirname, '../fixtures/scenario-e');
const FIXTURES_FAIL = join(__dirname, '../fixtures/scenario-e-fail');

const backend = (process.env['ACTSPEC_CONTAINER'] ?? 'mock') as 'mock' | 'docker';
const itDocker = backend === 'docker' ? test : test.skip;

describe(`Scenario E — pre/post lifecycle (backend: ${backend})`, () => {
  beforeAll(() => {
    clearImageCache();
  });

  // H6: three phases produce three StepResults with correct phase discriminators
  itDocker('pre/main/post phases run in order with correct phase discriminators (H6)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({});

    const pre  = result.steps.find(s => s.phase === 'pre');
    const main = result.steps.find(s => s.phase === 'main');
    const post = result.steps.find(s => s.phase === 'post');

    expect(pre).toBeDefined();
    expect(main).toBeDefined();
    expect(post).toBeDefined();
    expect(pre!.conclusion).toBe('success');
    expect(main!.conclusion).toBe('success');
    expect(post!.conclusion).toBe('success');
  });

  // H6: GITHUB_STATE written in pre-entrypoint is available as STATE_<key> in post-entrypoint
  itDocker('GITHUB_STATE threads from pre-entrypoint to post-entrypoint (H6, probe #10)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({});
    // pre.sh writes cache_key=abc to $GITHUB_STATE
    // post.sh reads $STATE_cache_key and writes restored=$STATE_cache_key to $GITHUB_OUTPUT
    expect(result).toHaveOutput('restored', 'abc');
  });

  // Probe #9: ordering — post always runs even when main fails (GitHub Actions default)
  itDocker('main failure does not prevent post-entrypoint from running (probe #9)', async () => {
    // This test validates the assumption; the fixture always succeeds.
    // If we need to test failure ordering, a separate fixture with a failing main would be needed.
    // For now, confirm all three phases run when everything succeeds.
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({});
    expect(result.steps).toHaveLength(3);
    expect(result.steps.every(s => s.ran)).toBe(true);
  });

  // main_ran output is written by main.sh
  itDocker('main entrypoint writes outputs correctly alongside pre/post phases', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({});
    expect(result).toHaveOutput('main_ran', 'true');
    expect(result).toHaveOutput('restored', 'abc');
  });

  // Probe #9: post-entrypoint runs unconditionally — even when main-entrypoint fails
  itDocker('post-entrypoint runs even when main-entrypoint exits non-zero (probe #9)', async () => {
    clearImageCache();
    const action = actspec(join(FIXTURES_FAIL, 'action.yml'), { container: 'docker' });
    const result = await action.run({});
    // Overall action fails because main exited 1
    expect(result).toHaveFailed();
    // But post-entrypoint still ran and wrote its output
    expect(result).toHaveOutput('post_ran', 'true');
    // Two steps: main (failure) + post (success)
    const main = result.steps.find(s => s.phase === 'main');
    const post = result.steps.find(s => s.phase === 'post');
    expect(main!.conclusion).toBe('failure');
    expect(post!.conclusion).toBe('success');
  });
});
