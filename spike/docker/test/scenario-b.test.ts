// Scenario B — Prebuilt image (docker://registry/img). Validates H1, H2, H8.
// Requires a Docker daemon. Run with: npm run test:docker
// Skipped by default (mock backend); set ACTSPEC_CONTAINER=docker to run real containers.

import { describe, test, expect, beforeAll } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures/scenario-b');

const backend = (process.env['ACTSPEC_CONTAINER'] ?? 'mock') as 'mock' | 'docker';
const itDocker = backend === 'docker' ? test : test.skip;

describe(`Scenario B — Prebuilt image (backend: ${backend})`, () => {
  // Probe #4: docker:// prefix is stripped correctly for docker pull/run
  itDocker('prebuilt image: input reaches container and output is returned (H1, H2)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { message: 'hello from docker' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('message', 'hello from docker');
  });

  // H8: non-root user can write to $GITHUB_OUTPUT because files are chmod 0o666
  itDocker('container running as non-root (USER 1000:1000) can still write to $GITHUB_OUTPUT (H8)', async () => {
    const action = actspec(join(FIXTURES, 'nonroot/action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { value: 'x' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('echoed', 'x');
  });

  // Probe #2: absolute host path is the same path inside the container
  itDocker('protocol file bind-mount round-trip: host reads what container wrote (probe #1, probe #2)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { message: 'round-trip-test' } });
    expect(result).toHaveSucceeded();
    // If mount is one-way or path mismatches, output would be empty — not 'round-trip-test'
    expect(result).toHaveOutput('message', 'round-trip-test');
  });
});
