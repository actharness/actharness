import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import * as tls from 'node:tls';
import { ensureSessionCa, cleanupSessionCa } from '../src/ca-cert.js';
import { ProxyMockServer, headersToRecord } from '../src/proxy-server.js';
import { NetworkMockHandle } from '../src/registry.js';
import type { CaBundle } from '../src/ca-cert.js';
import type { ApiMockEntry, NetworkMockEntry, MockResponseDescriptor } from '../src/registry.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeNetworkEntry(
  matcher: string | RegExp | ((url: string, method: string) => boolean),
  status: number,
  response: unknown,
  factory?: (url: string, method: string, body: string | null) => import('../src/registry.js').MockResponseDescriptor,
): NetworkMockEntry {
  return {
    matcher,
    status,
    response: factory ? undefined : response,
    responseHeaders: undefined,
    responseFactory: factory ?? null,
    handle: new NetworkMockHandle(),
  };
}

function makeApiEntry(pattern: string, response: Record<string, unknown>): ApiMockEntry {
  return { pattern, response, handle: new NetworkMockHandle() };
}

async function proxyRequest(opts: {
  port: number;
  method?: string;
  url: string;
  body?: string;
  headers?: Record<string, string>;
}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: opts.port,
        method: opts.method ?? 'GET',
        path: opts.url,
        headers: opts.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

/**
 * Makes a CONNECT tunnel through the proxy, upgrades to TLS, sends one HTTP
 * request, and returns the parsed status + body.
 *
 * Pass `connectHost` without a port to exercise the no-colon branch
 * (line 100 false branch in _handleConnect).
 *
 * Pass `garbageHead` to append raw bytes after the CONNECT headers so they
 * land in the `head` Buffer of the 'connect' event (line 112 true branch).
 */
async function httpsConnect(opts: {
  proxyPort: number;
  hostname: string;
  path: string;
  method?: string;
  ca: CaBundle;
  connectHost?: string;
  garbageHead?: string;
}): Promise<{ status: number; body: string } | 'tls-error'> {
  const connectTarget = opts.connectHost ?? `${opts.hostname}:443`;
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: opts.proxyPort });
    socket.once('error', reject);

    socket.once('connect', () => {
      const connectMsg =
        `CONNECT ${connectTarget} HTTP/1.1\r\nHost: ${connectTarget}\r\n\r\n` +
        (opts.garbageHead ?? '');
      socket.write(connectMsg);

      let buf = '';
      const onData = (chunk: Buffer) => {
        buf += chunk.toString('binary');
        if (!buf.includes('\r\n\r\n')) return;
        socket.removeListener('data', onData);

        if (!buf.startsWith('HTTP/1.1 200')) {
          socket.destroy();
          return reject(new Error(`CONNECT failed: ${buf.split('\r\n')[0]}`));
        }

        const tlsSocket = tls.connect({
          socket,
          servername: opts.hostname,
          ca: [opts.ca.certPem],
          rejectUnauthorized: true,
        });

        tlsSocket.once('error', () => resolve('tls-error'));

        tlsSocket.once('secureConnect', () => {
          const method = opts.method ?? 'GET';
          // Use HTTP/1.0 to avoid chunked transfer encoding in the response
          tlsSocket.write(
            `${method} ${opts.path} HTTP/1.0\r\nHost: ${opts.hostname}\r\n\r\n`,
          );

          const chunks: Buffer[] = [];
          tlsSocket.on('data', (c: Buffer) => chunks.push(c));
          tlsSocket.once('end', () => {
            const raw = Buffer.concat(chunks).toString();
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headerPart = raw.slice(0, headerEnd >= 0 ? headerEnd : raw.length);
            const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
            const statusMatch = headerPart.match(/^HTTP\/\d+\.\d+\s+(\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;
            resolve({ status, body });
          });
          tlsSocket.once('close', () => {
            const raw = Buffer.concat(chunks).toString();
            if (chunks.length === 0) { resolve('tls-error'); return; }
            const headerEnd = raw.indexOf('\r\n\r\n');
            const headerPart = raw.slice(0, headerEnd >= 0 ? headerEnd : raw.length);
            const body = headerEnd >= 0 ? raw.slice(headerEnd + 4) : '';
            const statusMatch = headerPart.match(/^HTTP\/\d+\.\d+\s+(\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1]!, 10) : 0;
            resolve({ status, body });
          });
        });
      };

      socket.on('data', onData);
    });
  });
}

// ── Suite setup ───────────────────────────────────────────────────────────────

let ca: CaBundle;
let proxy: ProxyMockServer;

beforeAll(async () => {
  ca = await ensureSessionCa();
  proxy = new ProxyMockServer(ca);
  await proxy.start();
});

afterAll(async () => {
  await proxy.stop();
  cleanupSessionCa();
});

beforeEach(() => {
  proxy.loadMocks([], []);
});

// ── ProxyMockServer lifecycle ─────────────────────────────────────────────────

describe('ProxyMockServer', () => {
  it('listens on a non-zero port after start()', () => {
    expect(proxy.port).toBeGreaterThan(0);
  });

  it('stop() rejects when server is already closed', async () => {
    const p = new ProxyMockServer(ca);
    await p.start();
    await p.stop();
    await expect(p.stop()).rejects.toThrow();
  });
});

// ── HTTP plain requests ───────────────────────────────────────────────────────

describe('HTTP plain request', () => {
  it('returns 200 and JSON body for a matched static mock', async () => {
    const entry = makeNetworkEntry('http://example.com/api', 200, { ok: true });
    proxy.loadMocks([], [entry]);

    const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ ok: true });
  });

  it('returns 404 status when mock specifies 404', async () => {
    const entry = makeNetworkEntry('http://example.com/missing', 404, { error: 'not found' });
    proxy.loadMocks([], [entry]);

    const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/missing' });

    expect(status).toBe(404);
    expect(JSON.parse(body)).toEqual({ error: 'not found' });
  });

  it('returns 502 for an unregistered URL', async () => {
    proxy.loadMocks([], []);
    const { status } = await proxyRequest({ port: proxy.port, url: 'http://example.com/unknown' });
    expect(status).toBe(502);
  });

  it('returns raw string body with no auto content-type when mock body is a string', async () => {
    const entry: NetworkMockEntry = {
      matcher: 'http://example.com/text',
      status: 200,
      response: 'hello world',
      responseFactory: null,
      handle: new NetworkMockHandle(),
    };
    proxy.loadMocks([], [entry]);

    const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/text' });

    expect(status).toBe(200);
    expect(body).toBe('hello world');
  });

  it('applies custom responseHeaders from static mock entry', async () => {
    const entry: NetworkMockEntry = {
      matcher: 'http://example.com/custom',
      status: 201,
      response: 'created',
      responseHeaders: { 'x-request-id': 'abc123' },
      responseFactory: null,
      handle: new NetworkMockHandle(),
    };
    proxy.loadMocks([], [entry]);

    const result = await new Promise<{ status: number; headers: Record<string, string>; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxy.port, method: 'GET', path: 'http://example.com/custom', headers: {} },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({
              status: res.statusCode ?? 0,
              headers: res.headers as Record<string, string>,
              body: Buffer.concat(chunks).toString(),
            }));
          },
        );
        req.on('error', reject);
        req.end();
      },
    );

    expect(result.status).toBe(201);
    expect(result.headers['x-request-id']).toBe('abc123');
    expect(result.body).toBe('created');
  });

  it('factory can override status code via returned descriptor', async () => {
    const entry = makeNetworkEntry(
      'http://example.com/retry',
      200,
      undefined,
      () => ({ status: 429, body: 'rate limited', headers: { 'retry-after': '1' } }),
    );
    proxy.loadMocks([], [entry]);

    const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/retry' });

    expect(status).toBe(429);
    expect(body).toBe('rate limited');
  });

  it('calls factory with url, method, body and returns its result', async () => {
    const calls: Array<[string, string, string | null]> = [];
    const entry = makeNetworkEntry(
      'http://example.com/echo',
      200,
      undefined,
      (url, method, body) => {
        calls.push([url, method, body]);
        return { body: { echoed: body } };
      },
    );
    proxy.loadMocks([], [entry]);

    const { status, body } = await proxyRequest({
      port: proxy.port,
      url: 'http://example.com/echo',
      method: 'POST',
      body: '{"input":1}',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ echoed: '{"input":1}' });
    expect(calls[0]![1]).toBe('POST');
    expect(calls[0]![2]).toBe('{"input":1}');
  });

  it('matches RegExp matcher', async () => {
    const entry = makeNetworkEntry(/example\.com\/item\/\d+/, 200, { found: true });
    proxy.loadMocks([], [entry]);

    const { status } = await proxyRequest({ port: proxy.port, url: 'http://example.com/item/42' });
    expect(status).toBe(200);

    proxy.loadMocks([], [entry]);
    const { status: s2 } = await proxyRequest({ port: proxy.port, url: 'http://example.com/item/abc' });
    expect(s2).toBe(502);
  });

  it('matches function matcher', async () => {
    const entry = makeNetworkEntry(
      (url, method) => method === 'DELETE' && url.includes('/resource'),
      200,
      { deleted: true },
    );
    proxy.loadMocks([], [entry]);

    const { status: get } = await proxyRequest({ port: proxy.port, url: 'http://x.com/resource', method: 'GET' });
    expect(get).toBe(502);

    proxy.loadMocks([], [entry]);
    const { status: del } = await proxyRequest({ port: proxy.port, url: 'http://x.com/resource', method: 'DELETE' });
    expect(del).toBe(200);
  });
});

// ── GitHub API matching ───────────────────────────────────────────────────────

describe('GitHub API (apiEntries)', () => {
  it('matches GET /repos/{owner}/{repo} and returns 200', async () => {
    const entry = makeApiEntry('GET /repos/{owner}/{repo}', { full_name: 'owner/repo' });
    proxy.loadMocks([entry], []);

    const { status, body } = await proxyRequest({
      port: proxy.port,
      url: 'http://api.github.com/repos/owner/repo',
    });

    expect(status).toBe(200);
    expect(JSON.parse(body)).toEqual({ full_name: 'owner/repo' });
  });

  it('returns 502 for wrong method', async () => {
    const entry = makeApiEntry('GET /repos/{owner}/{repo}', {});
    proxy.loadMocks([entry], []);

    const { status } = await proxyRequest({
      port: proxy.port,
      url: 'http://api.github.com/repos/owner/repo',
      method: 'POST',
    });

    expect(status).toBe(502);
  });
});

// ── Hit recording ─────────────────────────────────────────────────────────────

describe('getHits() / loadMocks()', () => {
  it('records a hit for each matched request', async () => {
    const entry = makeNetworkEntry('http://example.com/api', 200, { ok: true });
    proxy.loadMocks([], [entry]);

    await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });
    await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });

    const hits = proxy.getHits();
    expect(hits).toHaveLength(2);
    expect(hits[0]!.entryHandle).toBe(entry.handle);
    expect(hits[0]!.call.url).toBe('http://example.com/api');
    expect(hits[0]!.call.response).toEqual({ ok: true });
  });

  it('does not record a hit for unmatched requests', async () => {
    proxy.loadMocks([], []);
    await proxyRequest({ port: proxy.port, url: 'http://example.com/unknown' });
    expect(proxy.getHits()).toHaveLength(0);
  });

  it('loadMocks resets the hits array', async () => {
    const entry = makeNetworkEntry('http://example.com/api', 200, {});
    proxy.loadMocks([], [entry]);
    await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });
    expect(proxy.getHits()).toHaveLength(1);

    proxy.loadMocks([], []);
    expect(proxy.getHits()).toHaveLength(0);
  });

  it('records requestHeaders and requestBody', async () => {
    const entry = makeNetworkEntry('http://example.com/data', 201, {});
    proxy.loadMocks([], [entry]);

    await proxyRequest({
      port: proxy.port,
      url: 'http://example.com/data',
      method: 'POST',
      body: '{"key":"val"}',
      headers: { 'x-custom': 'header-value', 'content-type': 'application/json' },
    });

    const hit = proxy.getHits()[0]!;
    expect(hit.call.method).toBe('POST');
    expect(hit.call.requestBody).toBe('{"key":"val"}');
    expect(hit.call.requestHeaders['x-custom']).toBe('header-value');
  });
});

// ── HTTPS CONNECT tunnel ──────────────────────────────────────────────────────

describe('HTTPS CONNECT tunnel', () => {
  it('returns 200 and JSON body for a matched HTTPS mock', async () => {
    const entry = makeNetworkEntry('https://api.example.com/data', 200, { secure: true });
    proxy.loadMocks([], [entry]);

    const result = await httpsConnect({
      proxyPort: proxy.port,
      hostname: 'api.example.com',
      path: '/data',
      ca,
    });

    expect(result).not.toBe('tls-error');
    if (result !== 'tls-error') {
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ secure: true });
    }
  });

  it('returns 502 for unmatched HTTPS URL (entryHandle null branch)', async () => {
    proxy.loadMocks([], []);

    const result = await httpsConnect({
      proxyPort: proxy.port,
      hostname: 'api.example.com',
      path: '/unknown',
      ca,
    });

    expect(result).not.toBe('tls-error');
    if (result !== 'tls-error') {
      expect(result.status).toBe(502);
    }
  });

  it('serves GitHub API route via HTTPS CONNECT', async () => {
    const entry = makeApiEntry('GET /repos/{owner}/{repo}', { full_name: 'a/b' });
    proxy.loadMocks([entry], []);

    const result = await httpsConnect({
      proxyPort: proxy.port,
      hostname: 'api.github.com',
      path: '/repos/owner/repo',
      ca,
    });

    expect(result).not.toBe('tls-error');
    if (result !== 'tls-error') {
      expect(result.status).toBe(200);
      expect(JSON.parse(result.body)).toEqual({ full_name: 'a/b' });
    }
  });

  it('handles CONNECT without port (colonIdx === -1 branch)', async () => {
    // 'CONNECT example.com HTTP/1.1' — no :port, exercises the false branch of
    // `colonIdx !== -1 ? hostHeader.slice(0, colonIdx) : hostHeader`
    const entry = makeNetworkEntry('https://example.com/resource', 200, { found: true });
    proxy.loadMocks([], [entry]);

    const result = await httpsConnect({
      proxyPort: proxy.port,
      hostname: 'example.com',
      path: '/resource',
      ca,
      connectHost: 'example.com', // no port — forces the false branch
    });

    expect(result).not.toBe('tls-error');
    if (result !== 'tls-error') {
      expect(result.status).toBe(200);
    }
  }, 15000);

  it('exercises head.length > 0 branch and socket error handler', async () => {
    // Sending garbage bytes after CONNECT headers puts them in the `head` Buffer.
    // The server calls tlsSocket.unshift(head) (line 112 true branch).
    // The garbage bytes corrupt the TLS handshake → server socket emits 'error'
    // → socket.once('error', ...) handler fires (lines 148-151).
    proxy.loadMocks([], []);

    const result = await httpsConnect({
      proxyPort: proxy.port,
      hostname: 'example.com',
      path: '/irrelevant',
      ca,
      garbageHead: 'XXXXXXXXXX', // ends up in head buffer
    });

    // TLS will error on the client side because the server got corrupt data
    expect(result).toBe('tls-error');
  }, 10000);
});

// ── once: consumed flag set on match ─────────────────────────────────────────

describe('once entries — consumed flag', () => {
  it('sets consumed on api entry when once:true matches', async () => {
    const entry: ApiMockEntry = { ...makeApiEntry('GET /repos/{owner}/{repo}', { full_name: 'a/b' }), once: true };
    proxy.loadMocks([entry], []);

    const { status } = await proxyRequest({ port: proxy.port, url: 'http://api.github.com/repos/owner/repo' });
    expect(status).toBe(200);
    expect(entry.consumed).toBe(true);
  });

  it('sets consumed on network entry when once:true matches', async () => {
    const entry: NetworkMockEntry = { ...makeNetworkEntry('http://example.com/once', 200, { ok: true }), once: true };
    proxy.loadMocks([], [entry]);

    const { status } = await proxyRequest({ port: proxy.port, url: 'http://example.com/once' });
    expect(status).toBe(200);
    expect(entry.consumed).toBe(true);
  });
});

// ── headersToRecord ───────────────────────────────────────────────────────────

describe('headersToRecord', () => {
  it('converts string header values', () => {
    const result = headersToRecord({ 'content-type': 'application/json', host: 'example.com' });
    expect(result['content-type']).toBe('application/json');
    expect(result['host']).toBe('example.com');
  });

  it('joins array header values with ", " (set-cookie branch)', () => {
    const result = headersToRecord({ 'set-cookie': ['a=1', 'b=2'] });
    expect(result['set-cookie']).toBe('a=1, b=2');
  });

  it('skips keys with undefined value', () => {
    // TypeScript allows undefined in IncomingHttpHeaders; the guard must handle it
    const result = headersToRecord({ 'x-missing': undefined } as any);
    expect(result['x-missing']).toBeUndefined();
  });
});

// ── Error handlers ────────────────────────────────────────────────────────────

describe('error handlers', () => {
  it('responds 502 when _handleHttp throws before headers sent', async () => {
    const proto = ProxyMockServer.prototype as any;
    const saved = proto._handleHttp;
    proto._handleHttp = async function () { throw new Error('simulated http error'); };
    try {
      const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });
      expect(status).toBe(502);
      expect(body).toContain('simulated http error');
    } finally {
      proto._handleHttp = saved;
    }
  });

  it('skips writing 502 when _handleHttp throws after headers already sent (false branch of !headersSent)', async () => {
    const proto = ProxyMockServer.prototype as any;
    const saved = proto._handleHttp;
    proto._handleHttp = async function (_req: any, res: any) {
      res.writeHead(200);
      res.end('already-sent');
      throw new Error('error after response done');
    };
    try {
      const { status, body } = await proxyRequest({ port: proxy.port, url: 'http://example.com/api' });
      expect(status).toBe(200);
      expect(body).toBe('already-sent');
    } finally {
      proto._handleHttp = saved;
    }
  });

  it('sends HTTP 502 on socket when _handleConnect throws (lines 35-36)', async () => {
    const proto = ProxyMockServer.prototype as any;
    const saved = proto._handleConnect;
    proto._handleConnect = async function () { throw new Error('simulated connect error'); };

    const received = await new Promise<string>((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port: proxy.port });
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
        let buf = '';
        socket.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          if (buf.includes('502') || buf.includes('Proxy error')) {
            socket.destroy();
            resolve(buf);
          }
        });
        socket.once('close', () => resolve(buf));
      });
    });

    proto._handleConnect = saved;
    expect(received).toContain('502 Proxy error');
    expect(received).toContain('simulated connect error');
  });
});
