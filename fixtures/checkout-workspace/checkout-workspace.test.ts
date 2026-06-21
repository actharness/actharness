const nodeSource = { 'dist/index.js': 'src/index.js' };

test('workspace is empty before checkout, then seeded after — npm ci and file access work', async () => {
  const result = await actharness('./action.yml', { workspace: './seed', nodeSource }).run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('before-checkout-saw-file', 'false');
  expect(result).toHaveOutput('npm-ci-exit-code', '0');
  expect(result).toHaveOutput('shell-read-value', 'hello-from-checkout');
  expect(result).toHaveOutput('node-read-value', 'hello-from-checkout');
  expect(result).toHaveOutput('node-read-value-relative', 'hello-from-checkout');
});

test('workspace stays empty for the whole run when options.workspace is omitted', async () => {
  const result = await actharness('./action.yml', { nodeSource }).run();

  expect(result).toHaveOutput('before-checkout-saw-file', 'false');
  // No seed source configured — npm ci has no package.json/lockfile to work with, so it
  // fails, and every step after it defaults to `if: success()` and gets skipped as a result.
  expect(result).toHaveStepFailed('npm-ci');
  expect(result.step('after-shell')).toHaveBeenSkipped();
});
