const nodeSource = {
  'dist/pre.js': 'src/pre.js',
  'dist/index.js': 'src/index.js',
  'dist/post.js': 'src/post.js',
};

test('pre-if true runs the pre phase', async () => {
  const result = await actharness('./action.yml', { nodeSource }).run({ inputs: { 'run-pre': 'true' } });
  expect(result).toHaveSucceeded();
  expect(result.step('pre')).toHaveSucceeded();
});

test('pre-if false skips the pre phase; post-if false (failure() with a successful run) skips post', async () => {
  const result = await actharness('./action.yml', { nodeSource }).run({ inputs: { 'run-pre': 'false' } });
  expect(result).toHaveSucceeded();
  expect(result.step('pre')).toHaveBeenSkipped();
  expect(result.step('post')).toHaveBeenSkipped();
});
