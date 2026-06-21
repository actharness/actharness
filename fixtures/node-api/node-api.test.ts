afterEach(() => { actharness.resetMocks(); });

const nodeSource = {
  'dist/index.js': 'src/index.js',
  'dist/fetch.js': 'src/fetch.js',
  'dist/axios.js': 'src/axios.js',
};

test('returns comment count from mocked GitHub API', async () => {
  actharness.mockGitHubApi({
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [
      { id: 1, body: 'first' },
      { id: 2, body: 'second' },
      { id: 3, body: 'third' },
    ],
  });

  const result = await actharness('./action.yml', { nodeSource }).run({
    inputs: { token: 'ghs_test', 'issue-number': '42' },
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('comment-count', '3');
});

test('returns zero when there are no comments', async () => {
  actharness.mockGitHubApi({
    'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [],
  });

  const result = await actharness('./action.yml', { nodeSource }).run({
    inputs: { token: 'ghs_test', 'issue-number': '1' },
  });

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('comment-count', '0');
});

test('mockNetwork intercepts fetch with a string URL', async () => {
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'hello' });

  const result = await actharness('./fetch.yml', { nodeSource }).run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('value', 'hello');
});

test('mockNetwork returns non-200 status and action sets failure', async () => {
  actharness.mockNetwork('https://api.example.com/data', 404, { error: 'not found' });

  const result = await actharness('./fetch.yml', { nodeSource }).run();

  expect(result).toHaveFailed();
});

test('mockNetwork intercepts fetch with a RegExp matcher', async () => {
  actharness.mockNetwork(/api\.example\.com/, 200, { value: 'from-regex' });

  const result = await actharness('./fetch.yml', { nodeSource }).run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('value', 'from-regex');
});

test('mockNetwork intercepts axios with a string URL', async () => {
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'hello' });

  const result = await actharness('./axios.yml', { nodeSource }).run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('value', 'hello');
});

test('mockNetwork returns non-200 status and axios action sets failure', async () => {
  actharness.mockNetwork('https://api.example.com/data', 404, { error: 'not found' });

  const result = await actharness('./axios.yml', { nodeSource }).run();

  expect(result).toHaveFailed();
});

test('mockNetwork intercepts axios with a RegExp matcher', async () => {
  actharness.mockNetwork(/api\.example\.com/, 200, { value: 'from-regex' });

  const result = await actharness('./axios.yml', { nodeSource }).run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('value', 'from-regex');
});
