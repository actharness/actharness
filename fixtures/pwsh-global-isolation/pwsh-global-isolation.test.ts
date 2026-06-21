import { actharness } from 'actharness';

const action = actharness('./action.yml');

test('$global: state set in step 1 is not visible in step 2 (Runspace isolation)', async () => {
  const result = await action.run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('step2-saw', '');
});
