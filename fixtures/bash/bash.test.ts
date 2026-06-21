import { actharness } from 'actharness';

test('basic output — provided name input produces correct greeting', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { name: 'Alice', 'should-fail': 'false' },
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('greeting', 'Hello, Alice!');
});

test('input default — omitting name uses "World"', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveOutput('greeting', 'Hello, World!');
});

test('env seed is readable in run: steps', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
    env: { TEST_ENV: 'seed-value' },
  });

  expect(result).toHaveOutput('env-value', 'seed-value');
});

test('step-level env: overrides seed for that step; seed is restored in the next', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
    env: { TEST_ENV: 'seed-value' },
  });

  expect(result).toHaveOutput('step-env-value', 'https://staging.example.com');
  expect(result).toHaveOutput('restored-env', 'seed-value');
});

test('GITHUB_ENV value written in one step is readable as an env var in the next', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveOutput('threaded-env', 'from-set-github-env');
});

test('GITHUB_PATH prepends a path for subsequent steps', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveOutput('has-custom-bin', 'true');
});

test('working-directory: step runs in the configured subdirectory', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveOutput('cwd-name', 'subdir');
});

test('continue-on-error: failing step does not fail the action', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveStepSucceeded('flaky');
});

test('if: failure() step and always() step both run after a failure', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'true' },
  });

  expect(result).toHaveFailed();
  expect(result).toHaveStepSucceeded('on-failure');
  expect(result).toHaveStepSucceeded('always-runs');
});

test('if: always() step runs on both the success and failure paths', async () => {
  const successResult = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });
  expect(successResult).toHaveStepSucceeded('always-runs');

  const failResult = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'true' },
  });
  expect(failResult).toHaveStepSucceeded('always-runs');
});

test('::warning:: annotation is captured on the success path', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'false' },
  });

  expect(result).toHaveAnnotation({ level: 'warning', message: 'low disk space' });
});

test('::error:: annotation appears when the failure path is triggered', async () => {
  const result = await actharness('./action.yml').run({
    inputs: { 'should-fail': 'true' },
  });

  expect(result).toHaveAnnotation({ level: 'error', message: 'abort requested' });
});
