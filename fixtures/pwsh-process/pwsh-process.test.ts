import { actharness } from 'actharness';

const action = actharness('./action.yml', { pwshIsolation: 'process' });

test('process isolation: if branch — value > 10 produces "high"', async () => {
  const result = await action.run({ inputs: { value: '20' } });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('result', 'high');
});

test('process isolation: else branch — value ≤ 10 produces "low"', async () => {
  const result = await action.run({ inputs: { value: '5' } });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('result', 'low');
});
