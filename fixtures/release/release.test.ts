// Covers three v0.1 acceptance scenarios in one fixture: a mocked `uses:`,
// a skipped step via `if:`, and `$GITHUB_ENV` threading between steps.
import { actspec } from 'actspec';

test('skips publish on dry-run and records the mocked checkout inputs', async () => {
  const action = actspec('./action.yml');
  const checkout = action.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });

  const result = await action.run({ inputs: { 'dry-run': true } });

  expect(checkout).toHaveBeenCalledWith({ 'fetch-depth': '0' });
  expect(result).toHaveSkippedStep('publish');
  expect(result).toHaveStepConclusion('version', 'success');
  expect(result).toHaveOutput('sha', 'abc123');
});

test('runs publish when not a dry-run, seeing the threaded $GITHUB_ENV', async () => {
  const action = actspec('./action.yml');
  action.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });

  const result = await action.run({ inputs: { 'dry-run': false } });

  expect(result).toHaveRunStep('publish');
  expect(result.step('publish')!.stdout).toContain('Publishing 1.2.3');
});
