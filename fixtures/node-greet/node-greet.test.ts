const nodeSource = { 'dist/index.js': 'src/index.js' };

test('sets the greeting output for a given name', async () => {
  const result = await actharness('./action.yml', { nodeSource }).run({ inputs: { name: 'World' } });
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('greeting', 'Hello World');
});

test('applies the input default when name is omitted', async () => {
  const result = await actharness('./action.yml', { nodeSource }).run();
  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('greeting', 'Hello World');
});
