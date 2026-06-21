import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { ShellNetworkScope } from '../src/shell-scope.js';
import { mockNetwork, mockGitHubApi, resetNetworkMocks } from '../src/registry.js';
import { cleanupSessionCa } from '../src/ca-cert.js';

beforeEach(() => {
  resetNetworkMocks();
});

afterEach(async () => {
  cleanupSessionCa();
});

// ── drainAndStart / isActive ──────────────────────────────────────────────────

describe('drainAndStart', () => {
  it('leaves scope inactive when registry is empty', async () => {
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    expect(scope.isActive()).toBe(false);
    await scope.stop();
  });

  it('starts the proxy when network mocks are registered', async () => {
    mockNetwork('https://example.com', 200, { ok: true });
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    expect(scope.isActive()).toBe(true);
    await scope.stop();
  });

  it('starts the proxy when GitHub API mocks are registered', async () => {
    mockGitHubApi({ 'GET /repos/{owner}/{repo}': { full_name: 'a/b' } });
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    expect(scope.isActive()).toBe(true);
    await scope.stop();
  });
});

// ── stop ──────────────────────────────────────────────────────────────────────

describe('stop', () => {
  it('sets isActive() to false', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    expect(scope.isActive()).toBe(true);
    await scope.stop();
    expect(scope.isActive()).toBe(false);
  });

  it('is safe to call when scope was never started', async () => {
    const scope = new ShellNetworkScope();
    await expect(scope.stop()).resolves.not.toThrow();
  });

  it('is safe to call twice', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    await scope.stop();
    await expect(scope.stop()).resolves.not.toThrow();
  });
});

// ── getProxyEnv ───────────────────────────────────────────────────────────────

describe('getProxyEnv', () => {
  it('returns empty object when scope is not active', () => {
    const scope = new ShellNetworkScope();
    expect(scope.getProxyEnv('/tmp/ca.crt')).toEqual({});
  });

  it('returns proxy env vars when scope is active', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();

    const env = scope.getProxyEnv('/tmp/test-ca.crt');

    expect(env['HTTP_PROXY']).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env['HTTPS_PROXY']).toBe(env['HTTP_PROXY']);
    expect(env['http_proxy']).toBe(env['HTTP_PROXY']);
    expect(env['https_proxy']).toBe(env['HTTP_PROXY']);
    expect(env['SSL_CERT_FILE']).toBe('/tmp/test-ca.crt');
    expect(env['CURL_CA_BUNDLE']).toBe('/tmp/test-ca.crt');
    expect(env['NODE_EXTRA_CA_CERTS']).toBe('/tmp/test-ca.crt');
    expect(env['REQUESTS_CA_BUNDLE']).toBe('/tmp/test-ca.crt');

    await scope.stop();
  });

  it('proxy URL uses the port the server is actually bound to', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();

    const env = scope.getProxyEnv('/tmp/ca.crt');
    const port = parseInt(new URL(env['HTTP_PROXY']!).port, 10);
    expect(port).toBeGreaterThan(0);

    await scope.stop();
  });
});

// ── getPwshPrefix ─────────────────────────────────────────────────────────────

describe('getPwshPrefix', () => {
  it('returns the PowerShell certificate bypass line', () => {
    const scope = new ShellNetworkScope();
    const prefix = scope.getPwshPrefix();
    expect(prefix).toContain('SkipCertificateCheck');
    expect(prefix).toContain('$PSDefaultParameterValues');
  });
});

// ── collectHits ───────────────────────────────────────────────────────────────

describe('collectHits', () => {
  it('does not throw when there are no hits', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();
    expect(() => scope.collectHits()).not.toThrow();
    await scope.stop();
  });

  it('is safe to call when scope is not active', () => {
    const scope = new ShellNetworkScope();
    expect(() => scope.collectHits()).not.toThrow();
  });

  it('records hits from proxy requests onto the mock handle', async () => {
    const h = mockNetwork('http://collecthits-test.com/resource', 200, { val: 1 });
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();

    const env = scope.getProxyEnv('/tmp/ca.crt');
    const proxyPort = parseInt(new URL(env['HTTP_PROXY']!).port, 10);

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: proxyPort, path: 'http://collecthits-test.com/resource' },
        (res) => { res.resume(); res.once('end', resolve); },
      );
      req.on('error', reject);
      req.end();
    });

    scope.collectHits();

    expect(h.called).toBe(true);
    expect(h.calls[0]!.url).toBe('http://collecthits-test.com/resource');

    await scope.stop();
  });
});

// ── stop — error swallowing ───────────────────────────────────────────────────

describe('stop — best-effort catch', () => {
  it('swallows errors from proxy.stop() and still clears isActive()', async () => {
    mockNetwork('https://example.com', 200, {});
    const scope = new ShellNetworkScope();
    await scope.drainAndStart();

    // Patch the internal proxy's stop() to reject, exercising the catch branch
    (scope as any)._proxy.stop = () => Promise.reject(new Error('stop failed'));

    await expect(scope.stop()).resolves.not.toThrow();
    expect(scope.isActive()).toBe(false);
  });
});
