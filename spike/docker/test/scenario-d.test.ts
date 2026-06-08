// Scenario D — args: expression evaluation and entrypoint: override. Validates H5.
// Requires a Docker daemon. Run with: npm run test:docker

import { describe, test, expect } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, '../fixtures/scenario-d');

const backend = (process.env['ACTSPEC_CONTAINER'] ?? 'mock') as 'mock' | 'docker';
const itDocker = backend === 'docker' ? test : test.skip;

describe(`Scenario D — args: expression evaluation (backend: ${backend})`, () => {
  // H5: ${{ inputs.name }} in args is evaluated before docker run
  itDocker('args: expression ${{ inputs.name }} is evaluated before docker run (H5)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { name: 'World' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('greeting', 'World');
  });

  // Probe #7: multi-word input in args — confirm no unexpected shell splitting
  itDocker('args: with multi-word input value does not split unexpectedly (probe #7)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { name: 'Hello World' } });
    expect(result).toHaveSucceeded();
    // If shell-splitting occurs, greeting would be 'Hello' not 'Hello World'
    expect(result).toHaveOutput('greeting', 'Hello World');
  });

  // Probe #8: entrypoint: override with args: works correctly
  itDocker('entrypoint: /bin/sh overrides default and args are passed as positional (probe #8)', async () => {
    const action = actspec(join(FIXTURES, 'action.yml'), { container: 'docker' });
    const result = await action.run({ inputs: { name: 'EntrypointTest' } });
    expect(result).toHaveSucceeded();
    // The fixture uses entrypoint: /bin/sh with args: [-c, echo ...]
    // If --entrypoint and args interact incorrectly the echo would not produce the output
    expect(result).toHaveOutput('greeting', 'EntrypointTest');
  });
});
