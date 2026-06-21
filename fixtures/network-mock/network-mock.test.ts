// Acceptance fixtures for @actharness/network-mock — proxy path (bash, sh, python).
// Fixture K (Node path regression) lives in packages/node/test/node.test.ts.

afterEach(() => { actharness.resetMocks(); });

// ── Fixture A — bash plain HTTP mock ─────────────────────────────────────────

test('A: bash curl intercepts plain HTTP and records the call', async () => {
  actharness.mockNetwork('http://example.com/api', 200, { ok: true });

  const result = await actharness('./bash-http.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"ok":true}');
});

// ── Fixture B — bash HTTPS mock (CONNECT tunnel + CA cert) ───────────────────

test('B: bash curl intercepts HTTPS via CONNECT tunnel', async () => {
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'secure' });

  const result = await actharness('./bash-https.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"value":"secure"}');
});

// ── Fixture C — Python requests mock (REQUESTS_CA_BUNDLE) ────────────────────

test('C: python requests intercepts HTTPS (REQUESTS_CA_BUNDLE)', async () => {
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'from-python' });

  const result = await actharness('./python-https.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"value":"from-python"}');
});

// ── Fixture E — sh wget mock (SSL_CERT_FILE) ──────────────────────────────────

test('E: sh curl intercepts HTTPS (CURL_CA_BUNDLE)', async () => {
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'from-sh' });

  const result = await actharness('./sh-https.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"value":"from-sh"}');
});

// ── Fixture F — mockGitHubApi over proxy (bash curl) ─────────────────────────

test('F: mockGitHubApi matched by bash curl over HTTPS', async () => {
  actharness.mockGitHubApi({
    'GET /repos/{owner}/{repo}': { full_name: 'owner/repo' },
  });

  const result = await actharness('./bash-github-api.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('full_name', 'owner/repo');
});

// ── Fixture G — function matcher (proxy path) ─────────────────────────────────

test('G: function matcher works on proxy path', async () => {
  actharness.mockNetwork(
    (url, method) => url.includes('/api') && method === 'POST',
    200,
    { ok: true },
  );

  const result = await actharness('./bash-post.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"ok":true}');
});

// ── Fixture H — per-call response factory (proxy path) ───────────────────────

test('H: response factory called per request with incrementing counter', async () => {
  let n = 0;
  actharness.mockNetwork('https://example.com/api', 200, () => ({ body: { attempt: ++n } }));

  // Two-step action: make two sequential curl calls to the same URL.
  const result = await actharness('./bash-factory.yml').run();

  expect(result).toHaveSucceeded();
});

// ── Fixture I — requestHeaders and requestBody recorded ───────────────────────

test('I: requestHeaders and requestBody captured on proxy path', async () => {
  actharness.mockNetwork('https://example.com/api', 200, { ok: true });

  const result = await actharness('./bash-post.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '{"ok":true}');
});

// ── Fixture J — unmatched request blocked (502) ───────────────────────────────

test('J: unmatched request returns 502 and no real connection is made', async () => {
  // Register a mock for a *different* URL so the proxy starts, but the action
  // hits an unmatched URL — proxy must 502 it.
  actharness.mockNetwork('https://other.example.com/noop', 200, {});

  const result = await actharness('./bash-unmatched.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('status', '502');
});

// ── Fixture L — shared registry across shell types ────────────────────────────

test('L: single mockNetwork registration accumulates hits across multiple runs', async () => {
  // Register once — registry is NOT cleared between runs, only by resetNetworkMocks().
  actharness.mockNetwork('https://api.example.com/data', 200, { value: 'shared' });

  const result1 = await actharness('./bash-https.yml').run();
  const result2 = await actharness('./bash-https.yml').run();

  expect(result1).toHaveSucceeded();
  expect(result1).toHaveOutput('body', '{"value":"shared"}');
  expect(result2).toHaveSucceeded();
  expect(result2).toHaveOutput('body', '{"value":"shared"}');
});

// ── Fixture M — string body (no JSON wrapping) ────────────────────────────────

test('M: string body returned as-is without JSON serialization', async () => {
  actharness.mockNetwork('http://example.com/text', 200, 'hello world');

  const result = await actharness('./bash-string-body.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', 'hello world');
});

// ── Fixture N — custom response headers ───────────────────────────────────────

test('N: custom content-type header set on string body response', async () => {
  actharness.mockNetwork('https://api.example.com/html', 200, '<h1>Hello</h1>', { 'content-type': 'text/html' });

  const result = await actharness('./bash-custom-headers.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('body', '<h1>Hello</h1>');
  expect(result).toHaveOutput('content_type', 'text/html');
});

// ── Fixture O — factory status override ───────────────────────────────────────

test('O: factory overrides status code per call (rate-limit simulation)', async () => {
  let n = 0;
  actharness.mockNetwork('https://api.example.com/retry', 200, () =>
    ++n === 1
      ? { status: 429, body: 'rate limited' }
      : { body: { ok: true } },
  );

  const result = await actharness('./bash-factory-status.yml').run();

  expect(result).toHaveSucceeded();
  expect(result).toHaveOutput('first', '429');
  expect(result).toHaveOutput('second', '200');
});
