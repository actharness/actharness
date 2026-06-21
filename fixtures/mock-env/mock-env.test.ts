import { actharness } from 'actharness';

test('env from mock def is available to subsequent steps', async () => {
  actharness.mock('actions/setup-tool@v1', {
    outputs: {},
    env: { TOOL_VERSION: '3.12.0' },
  });

  const result = await actharness('./action.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('injected-value', '3.12.0');
});

test('env from dynamic mock impl is available to subsequent steps', async () => {
  actharness.mock('actions/setup-tool@v1', ({ with: w }) => ({
    env: { TOOL_VERSION: w['version'] ?? 'default' },
  }));

  const result = await actharness('./action.yml').run({
    inputs: {},
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('injected-value', 'default');
});

test('env from mock does not bleed across separate runs', async () => {
  actharness.mock('actions/setup-tool@v1', {
    env: { TOOL_VERSION: 'run-1' },
  });
  const r1 = await actharness('./action.yml').run();

  actharness.mock('actions/setup-tool@v1', {
    env: { TOOL_VERSION: 'run-2' },
  });
  const r2 = await actharness('./action.yml').run();

  expect(r1).toHaveOutput('injected-value', 'run-1');
  expect(r2).toHaveOutput('injected-value', 'run-2');
});
