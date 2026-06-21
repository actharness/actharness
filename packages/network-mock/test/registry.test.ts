import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockNetwork,
  mockNetworkOnce,
  mockGitHubApi,
  mockGitHubApiOnce,
  drainForNode,
  drainForProxy,
  recordApiHit,
  recordNetworkHit,
  matchNetworkEntry,
  matchApiEntry,
  resetNetworkMocks,
  pruneConsumedOnce,
  NetworkMockHandle,
} from '../src/registry.js';

beforeEach(() => {
  resetNetworkMocks();
});

// ── NetworkMockHandle ─────────────────────────────────────────────────────────

describe('NetworkMockHandle', () => {
  it('starts empty', () => {
    const h = new NetworkMockHandle();
    expect(h.calls).toEqual([]);
    expect(h.called).toBe(false);
    expect(h.callCount).toBe(0);
  });

  it('_record pushes a call and updates accessors', () => {
    const h = new NetworkMockHandle();
    h._record({ url: 'https://x.com', method: 'GET', requestHeaders: {}, requestBody: null, response: {}, matchedPattern: 'x' });
    expect(h.called).toBe(true);
    expect(h.callCount).toBe(1);
    expect(h.calls[0]!.url).toBe('https://x.com');
  });

  it('clear empties calls', () => {
    const h = new NetworkMockHandle();
    h._record({ url: 'u', method: 'GET', requestHeaders: {}, requestBody: null, response: {}, matchedPattern: 'p' });
    h.clear();
    expect(h.called).toBe(false);
    expect(h.callCount).toBe(0);
  });
});

// ── mockNetwork ───────────────────────────────────────────────────────────────

describe('mockNetwork', () => {
  it('returns a NetworkMockHandle', () => {
    const h = mockNetwork('https://example.com', 200, { ok: true });
    expect(h).toBeInstanceOf(NetworkMockHandle);
    expect(h.called).toBe(false);
  });

  it('accepts string matcher', () => {
    mockNetwork('https://example.com/api', 200, {});
    const { networkEntries } = drainForProxy();
    expect(networkEntries).toHaveLength(1);
    expect(networkEntries[0]!.matcher).toBe('https://example.com/api');
  });

  it('accepts RegExp matcher', () => {
    mockNetwork(/example\.com/, 200, {});
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.matcher).toBeInstanceOf(RegExp);
  });

  it('accepts function matcher', () => {
    const fn = (url: string) => url.includes('/api');
    mockNetwork(fn, 200, {});
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.matcher).toBe(fn);
  });

  it('accepts factory response function', () => {
    let n = 0;
    mockNetwork('https://x.com', 200, () => ({ body: { n: ++n } }));
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.responseFactory).toBeInstanceOf(Function);
    expect(networkEntries[0]!.response).toBeUndefined();
  });

  it('stores static response directly', () => {
    mockNetwork('https://x.com', 200, { value: 42 });
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.response).toEqual({ value: 42 });
    expect(networkEntries[0]!.responseFactory).toBeNull();
  });

  it('stores responseHeaders when headers arg is provided', () => {
    mockNetwork('https://x.com', 200, 'plain text', { 'content-type': 'text/plain' });
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.responseHeaders).toEqual({ 'content-type': 'text/plain' });
  });

  it('does not set responseHeaders when headers arg is omitted', () => {
    mockNetwork('https://x.com', 200, { ok: true });
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.responseHeaders).toBeUndefined();
  });
});

// ── mockGitHubApi ─────────────────────────────────────────────────────────────

describe('mockGitHubApi', () => {
  it('returns a NetworkMockHandle', () => {
    const h = mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    expect(h).toBeInstanceOf(NetworkMockHandle);
  });

  it('pushes one entry per route', () => {
    mockGitHubApi({
      'GET /repos/{owner}/{repo}': { full_name: 'a/b' },
      'GET /users/{username}': { login: 'alice' },
    });
    const { apiEntries } = drainForProxy();
    expect(apiEntries).toHaveLength(2);
    expect(apiEntries[0]!.pattern).toBe('GET /repos/{owner}/{repo}');
    expect(apiEntries[1]!.pattern).toBe('GET /users/{username}');
  });

  it('shares the same handle across all routes', () => {
    const h = mockGitHubApi({
      'GET /repos/{owner}/{repo}': {},
      'GET /users/{username}': {},
    });
    const { apiEntries } = drainForProxy();
    expect(apiEntries[0]!.handle).toBe(h);
    expect(apiEntries[1]!.handle).toBe(h);
  });

  it('throws if a response is a function', () => {
    expect(() =>
      mockGitHubApi({ 'GET /repos/{owner}/{repo}': (() => ({})) as never }),
    ).toThrow('function responses are not supported');
  });
});

// ── mockGitHubApiOnce ─────────────────────────────────────────────────────────

describe('mockGitHubApiOnce', () => {
  it('returns a NetworkMockHandle', () => {
    const h = mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    expect(h).toBeInstanceOf(NetworkMockHandle);
  });

  it('pushes entries with once: true', () => {
    mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const { apiEntries } = drainForProxy();
    expect(apiEntries[0]!.once).toBe(true);
    expect(apiEntries[0]!.pattern).toBe('GET /repos/{owner}/{repo}');
  });

  it('throws if a response is a function', () => {
    expect(() =>
      mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': (() => ({})) as never }),
    ).toThrow('function responses are not supported');
  });
});

// ── mockNetworkOnce ───────────────────────────────────────────────────────────

describe('mockNetworkOnce', () => {
  it('returns a NetworkMockHandle', () => {
    const h = mockNetworkOnce('https://example.com', 200, { ok: true });
    expect(h).toBeInstanceOf(NetworkMockHandle);
  });

  it('pushes entry with once: true', () => {
    mockNetworkOnce('https://example.com/api', 200, {});
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.once).toBe(true);
    expect(networkEntries[0]!.matcher).toBe('https://example.com/api');
  });

  it('stores static response and sets responseHeaders when provided', () => {
    mockNetworkOnce('https://x.com', 200, 'text', { 'content-type': 'text/plain' });
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.responseHeaders).toEqual({ 'content-type': 'text/plain' });
    expect(networkEntries[0]!.once).toBe(true);
  });

  it('accepts factory response (once: true, no responseHeaders set)', () => {
    mockNetworkOnce('https://x.com', 200, () => ({ body: { n: 1 } }));
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.once).toBe(true);
    expect(networkEntries[0]!.responseFactory).toBeInstanceOf(Function);
    expect(networkEntries[0]!.responseHeaders).toBeUndefined();
  });
});

// ── drainForNode ──────────────────────────────────────────────────────────────

describe('drainForNode', () => {
  it('snapshots without clearing the registry', () => {
    mockNetwork('https://x.com', 200, {});
    drainForNode();
    const { networkEntries } = drainForProxy();
    expect(networkEntries).toHaveLength(1); // still there
  });

  it('serializes string matcher as-is', () => {
    mockNetwork('https://x.com/api', 200, {});
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.matcher).toBe('https://x.com/api');
  });

  it('serializes RegExp matcher as { source, flags }', () => {
    mockNetwork(/example\.com/i, 200, {});
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.matcher).toEqual({ source: 'example\\.com', flags: 'i' });
  });

  it('marks static responses with hasFactory:false and includes body', () => {
    mockNetwork('https://x.com', 200, { ok: true });
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.hasFactory).toBe(false);
    expect(networkMocks[0]!.body).toEqual({ ok: true });
  });

  it('marks factory responses with hasFactory:true and omits body', () => {
    mockNetwork('https://x.com', 200, () => ({ body: { ok: true } }));
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.hasFactory).toBe(true);
    expect(networkMocks[0]!.body).toBeUndefined();
  });

  it('serializes function matchers as hasMatcherFunction:true with null matcher', () => {
    mockNetwork((url) => url.includes('/api'), 200, {});
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.hasMatcherFunction).toBe(true);
    expect(networkMocks[0]!.matcher).toBeNull();
  });

  it('includes headers in serialized mock when responseHeaders is set', () => {
    mockNetwork('https://x.com', 200, 'ok', { 'x-custom': 'value' });
    const { networkMocks } = drainForNode();
    expect(networkMocks[0]!.headers).toEqual({ 'x-custom': 'value' });
  });

  it('includes apiMocks from mockGitHubApi', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const { apiMocks } = drainForNode();
    expect(apiMocks).toHaveLength(1);
    expect(apiMocks[0]!.pattern).toBe('GET /repos/{owner}/{repo}');
  });
});

// ── drainForProxy ─────────────────────────────────────────────────────────────

describe('drainForProxy', () => {
  it('snapshots without clearing the registry', () => {
    mockNetwork('https://x.com', 200, {});
    drainForProxy();
    const second = drainForProxy();
    expect(second.networkEntries).toHaveLength(1);
  });

  it('includes function matchers', () => {
    const fn = (url: string, method: string) => method === 'POST';
    mockNetwork(fn, 200, {});
    const { networkEntries } = drainForProxy();
    expect(networkEntries[0]!.matcher).toBe(fn);
  });
});

// ── resetNetworkMocks ─────────────────────────────────────────────────────────

describe('resetNetworkMocks', () => {
  it('clears all pending mocks', () => {
    mockNetwork('https://x.com', 200, {});
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    resetNetworkMocks();
    const { networkEntries, apiEntries } = drainForProxy();
    expect(networkEntries).toHaveLength(0);
    expect(apiEntries).toHaveLength(0);
  });
});

// ── matchNetworkEntry ─────────────────────────────────────────────────────────

describe('matchNetworkEntry', () => {
  it('matches exact URL string', () => {
    mockNetwork('https://api.example.com/data', 200, {});
    const { networkEntries } = drainForProxy();
    expect(matchNetworkEntry(networkEntries, 'https://api.example.com/data', 'GET')).toBeDefined();
  });

  it('matches substring when string is not a valid URL', () => {
    mockNetwork('/api', 200, {});
    const { networkEntries } = drainForProxy();
    expect(matchNetworkEntry(networkEntries, 'https://example.com/api/v2', 'GET')).toBeDefined();
  });

  it('matches RegExp', () => {
    mockNetwork(/api\.example\.com/, 200, {});
    const { networkEntries } = drainForProxy();
    expect(matchNetworkEntry(networkEntries, 'https://api.example.com/data', 'GET')).toBeDefined();
    expect(matchNetworkEntry(networkEntries, 'https://other.com/data', 'GET')).toBeUndefined();
  });

  it('matches function matcher', () => {
    mockNetwork((url, method) => method === 'POST' && url.includes('/submit'), 200, {});
    const { networkEntries } = drainForProxy();
    expect(matchNetworkEntry(networkEntries, 'https://x.com/submit', 'POST')).toBeDefined();
    expect(matchNetworkEntry(networkEntries, 'https://x.com/submit', 'GET')).toBeUndefined();
  });

  it('returns undefined when no entry matches', () => {
    mockNetwork('https://x.com', 200, {});
    const { networkEntries } = drainForProxy();
    expect(matchNetworkEntry(networkEntries, 'https://other.com', 'GET')).toBeUndefined();
  });

  it('first-match wins', () => {
    mockNetwork('https://x.com', 200, { first: true });
    mockNetwork('https://x.com', 404, { second: true });
    const { networkEntries } = drainForProxy();
    const match = matchNetworkEntry(networkEntries, 'https://x.com', 'GET');
    expect(match!.response).toEqual({ first: true });
  });

  it('skips consumed entries', () => {
    mockNetworkOnce('https://x.com', 200, { once: true });
    const { networkEntries } = drainForProxy();
    networkEntries[0]!.consumed = true;
    expect(matchNetworkEntry(networkEntries, 'https://x.com', 'GET')).toBeUndefined();
  });
});

// ── matchApiEntry ─────────────────────────────────────────────────────────────

describe('matchApiEntry', () => {
  it('matches Octokit-style route on api.github.com', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const { apiEntries } = drainForProxy();
    const match = matchApiEntry(apiEntries, 'https://api.github.com/repos/owner/repo', 'GET');
    expect(match).toBeDefined();
    expect(match!.response).toEqual({ full_name: 'a/b' });
  });

  it('does not match wrong method', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    expect(matchApiEntry(apiEntries, 'https://api.github.com/repos/owner/repo', 'POST')).toBeUndefined();
  });

  it('does not match non-github URLs', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    expect(matchApiEntry(apiEntries, 'https://other.com/repos/owner/repo', 'GET')).toBeUndefined();
  });

  it('skips entry when url is not a valid URL (catch { continue } branch)', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    expect(matchApiEntry(apiEntries, 'not-a-valid-url', 'GET')).toBeUndefined();
  });

  it('skips consumed entries', () => {
    mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    apiEntries[0]!.consumed = true;
    expect(matchApiEntry(apiEntries, 'https://api.github.com/repos/owner/repo', 'GET')).toBeUndefined();
  });
});

// ── recordApiHit ──────────────────────────────────────────────────────────────

describe('recordApiHit', () => {
  it('records a call on the matching entry handle', () => {
    const h = mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const { apiEntries } = drainForProxy();
    recordApiHit(apiEntries, 'GET /repos/{owner}/{repo}', '/repos/owner/repo', 'GET', { authorization: 'Bearer x' }, null);
    expect(h.called).toBe(true);
    expect(h.calls[0]!.url).toBe('/repos/owner/repo');
    expect(h.calls[0]!.requestHeaders['authorization']).toBe('Bearer x');
    expect(h.calls[0]!.matchedPattern).toBe('GET /repos/{owner}/{repo}');
  });

  it('does not record when pattern does not match any entry (false branch)', () => {
    const h = mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    recordApiHit(apiEntries, 'GET /users/{username}', '/users/alice', 'GET', {}, null);
    expect(h.called).toBe(false);
  });

  it('marks once entry as consumed when hit', () => {
    mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const { apiEntries } = drainForProxy();
    recordApiHit(apiEntries, 'GET /repos/{owner}/{repo}', '/repos/owner/repo', 'GET', {}, null);
    expect(apiEntries[0]!.consumed).toBe(true);
  });
});

// ── recordNetworkHit ──────────────────────────────────────────────────────────

describe('recordNetworkHit', () => {
  it('records a call on the matching entry handle', () => {
    const h = mockNetwork('https://example.com/api', 200, { ok: true });
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://example.com/api', 'POST', { 'content-type': 'application/json' }, '{"x":1}', { ok: true }, 'https://example.com/api');
    expect(h.called).toBe(true);
    expect(h.calls[0]!.requestBody).toBe('{"x":1}');
    expect(h.calls[0]!.response).toEqual({ ok: true });
    expect(h.calls[0]!.matchedPattern).toBe('https://example.com/api');
  });

  it('does not record if no entry matches', () => {
    const h = mockNetwork('https://example.com/api', 200, {});
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://other.com', 'GET', {}, null, {}, 'other');
    expect(h.called).toBe(false);
  });

  it('matches via substring when matcher is not a valid URL (catch branch)', () => {
    const h = mockNetwork('/api', 200, { ok: true });
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://example.com/api/v2', 'GET', {}, null, { ok: true }, '/api');
    expect(h.called).toBe(true);
    expect(h.calls[0]!.url).toBe('https://example.com/api/v2');
  });

  it('matches via RegExp matcher', () => {
    const h = mockNetwork(/example\.com\/test/, 200, { data: true });
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://example.com/test', 'GET', {}, null, { data: true }, '/example.com/test/');
    expect(h.called).toBe(true);
  });

  it('does not match with function matcher (else branch — matched=false)', () => {
    const h = mockNetwork(() => true, 200, {});
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://example.com/api', 'GET', {}, null, {}, '');
    expect(h.called).toBe(false);
  });

  it('marks once entry as consumed when hit', () => {
    mockNetworkOnce('https://example.com/api', 200, { ok: true });
    const { networkEntries } = drainForProxy();
    recordNetworkHit(networkEntries, 'https://example.com/api', 'GET', {}, null, { ok: true }, 'https://example.com/api');
    expect(networkEntries[0]!.consumed).toBe(true);
  });
});

// ── pruneConsumedOnce ─────────────────────────────────────────────────────────

describe('pruneConsumedOnce', () => {
  it('removes consumed once api entries from the global registry', () => {
    mockGitHubApiOnce({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    apiEntries[0]!.consumed = true;
    pruneConsumedOnce();
    expect(drainForProxy().apiEntries).toHaveLength(0);
  });

  it('removes consumed once network entries from the global registry', () => {
    mockNetworkOnce('https://x.com', 200, {});
    const { networkEntries } = drainForProxy();
    networkEntries[0]!.consumed = true;
    pruneConsumedOnce();
    expect(drainForProxy().networkEntries).toHaveLength(0);
  });

  it('does not remove non-once entries even if consumed flag is set', () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': {} });
    const { apiEntries } = drainForProxy();
    apiEntries[0]!.consumed = true;
    pruneConsumedOnce();
    expect(drainForProxy().apiEntries).toHaveLength(1);
  });

  it('does not remove once entries that are not yet consumed', () => {
    mockNetworkOnce('https://x.com', 200, {});
    pruneConsumedOnce();
    expect(drainForProxy().networkEntries).toHaveLength(1);
  });

  it('is safe to call when no mocks are registered', () => {
    expect(() => pruneConsumedOnce()).not.toThrow();
  });
});
