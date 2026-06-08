// Scenario C — Local Dockerfile build and content-hash caching. Validates H1, H3, H4.
// Requires a Docker daemon. Run with: npm run test:docker

import { describe, test, expect, beforeAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';
import { clearImageCache, getImageCacheSize } from '../src/container.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures/scenario-c');
const FIXTURES_PATH = join(__dirname, '../fixtures/scenario-c-path');
const FIXTURES_ALT  = join(__dirname, '../fixtures/scenario-c-alt');

const backend = (process.env['ACTSPEC_CONTAINER'] ?? 'mock') as 'mock' | 'docker';
const itDocker = backend === 'docker' ? test : test.skip;

describe(`Scenario C — Local Dockerfile build + cache (backend: ${backend})`, () => {
  beforeAll(() => {
    // Start each scenario with a clean cache so build count is deterministic
    clearImageCache();
  });

  // H3: local Dockerfile is built on demand
  itDocker('local Dockerfile is built and action produces outputs (H3)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { value: 'built' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('value', 'built');
  });

  // H4: second run with same Dockerfile skips the build (cache hit)
  itDocker('second run uses the content-hash cache — no rebuild (H4)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    // First run: builds and caches
    const first = await action.run({ inputs: { value: 'a' } });
    // Second run: should hit the in-process cache
    const second = await action.run({ inputs: { value: 'b' } });
    expect(first).toHaveSucceeded();
    expect(second).toHaveSucceeded();
    // Both return their respective input values — confirms the container ran both times
    expect(first).toHaveOutput('value', 'a');
    expect(second).toHaveOutput('value', 'b');
  });

  // Probe #5: same Dockerfile content -> same cache key -> no rebuild
  itDocker('identical Dockerfile content produces the same cache key (probe #5)', async () => {
    const action1 = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const action2 = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    await action1.run({ inputs: { value: 'first-instance' } });
    // Second actspec() for the same action.yml should reuse the cached image
    const result = await action2.run({ inputs: { value: 'second-instance' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('value', 'second-instance');
  });

  // Probe #6a: image: Dockerfile (literal) resolves the action's own directory as build context
  itDocker('image: Dockerfile resolves the action directory as build context (probe #6a)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { value: 'dockerfile-literal-ok' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('value', 'dockerfile-literal-ok');
  });

  // Probe #6b: image: ./path resolves relative to the action directory, not process.cwd()
  itDocker('image: ./subdir resolves Dockerfile in subdirectory relative to action dir (probe #6b)', async () => {
    const action = actspec(join(FIXTURES_PATH, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { value: 'path-form-ok' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('value', 'path-form-ok');
  });

  // H4 — cache invalidation: different Dockerfile content produces a different cache key and a distinct build
  itDocker('different Dockerfile content produces a distinct cache entry (H4 invalidation)', async () => {
    clearImageCache();
    const actionC   = actspec(join(FIXTURES,     'action.yml'), { container: 'docker' });
    const actionAlt = actspec(join(FIXTURES_ALT, 'action.yml'), { container: 'docker' });
    await actionC.run({ inputs: { value: 'c' } });
    const sizeAfterFirst = getImageCacheSize();
    await actionAlt.run({ inputs: { value: 'alt' } });
    const sizeAfterSecond = getImageCacheSize();
    // Two separate Dockerfiles with different content must produce two distinct cache entries
    expect(sizeAfterFirst).toBe(1);
    expect(sizeAfterSecond).toBe(2);
    // Re-running scenario-c hits the cache — size does not grow
    await actionC.run({ inputs: { value: 'c-again' } });
    expect(getImageCacheSize()).toBe(2);
  });
});
