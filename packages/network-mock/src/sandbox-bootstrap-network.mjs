/**
 * Network interception fragment — imported by packages/node/src/sandbox-bootstrap.mjs.
 * Mounts undici MockAgent + @mswjs/interceptors for the forked sandbox child.
 *
 * Called with:
 *   { apiMocks, networkMocks, actionDir }
 *
 * networkMocks entries have the shape:
 *   { matcher: string | { source, flags } | null, hasMatcherFunction, status, body, headers, hasFactory }
 *
 * When hasMatcherFunction is true the child suspends the request, sends
 *   { type:'matchRequest', requestId, url, method, requestHeaders, requestBody, mockIndex }
 * to the parent and awaits a
 *   { type:'matchResponse', requestId, matched, status, body, headers, matchedPattern }
 * reply. The parent evaluates the function matcher (and factory if applicable) and records the hit.
 *
 * When hasFactory is true (and hasMatcherFunction is false) the child suspends the request, sends
 *   { type:'networkRequest', requestId, url, method, requestHeaders, requestBody }
 * to the parent and awaits a
 *   { type:'networkResponse', requestId, status, body, headers }
 * reply before completing the intercepted response.
 *
 * Static responses (hasFactory:false, hasMatcherFunction:false) are fulfilled immediately.
 *
 * After each matched response the child sends (except for hasMatcherFunction — parent records directly):
 *   { type:'apiHit', pattern, url, method, requestHeaders, requestBody }
 *   { type:'networkHit', matchedPattern, url, method, requestHeaders, requestBody, response }
 */

import path from 'path';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';

const _require = createRequire(import.meta.url);

// ── Pending factory round-trips: requestId → { resolve } ─────────────────────
const _pending = new Map();
let _pendingCount = 0;

// ── Pending function-matcher round-trips: requestId → { resolve } ─────────────
const _pendingMatches = new Map();
let _pendingMatchCount = 0;

process.on('message', (msg) => {
  if (msg && msg.type === 'networkResponse') {
    const pending = _pending.get(msg.requestId);
    if (pending) {
      _pending.delete(msg.requestId);
      _pendingCount--;
      pending.resolve({ status: msg.status, body: msg.body, headers: msg.headers });
      if (_pendingCount === 0 && _pendingMatchCount === 0) process.channel?.unref();
    }
  } else if (msg && msg.type === 'matchResponse') {
    const pending = _pendingMatches.get(msg.requestId);
    if (pending) {
      _pendingMatches.delete(msg.requestId);
      _pendingMatchCount--;
      pending.resolve(msg);
      if (_pendingCount === 0 && _pendingMatchCount === 0) process.channel?.unref();
    }
  }
});

// Send a networkRequest to parent and wait for the factory response.
function requestFactory(requestId, url, method, requestHeaders, requestBody) {
  _pendingCount++;
  process.channel?.ref();
  return new Promise((resolve, reject) => {
    _pending.set(requestId, { resolve, reject });
    process.send({ type: 'networkRequest', requestId, url, method, requestHeaders, requestBody });
  });
}

// Send a matchRequest to parent and wait for matcher evaluation + full response.
function requestMatch(requestId, url, method, requestHeaders, requestBody, mockIndex) {
  _pendingMatchCount++;
  process.channel?.ref();
  return new Promise((resolve) => {
    _pendingMatches.set(requestId, { resolve });
    process.send({ type: 'matchRequest', requestId, url, method, requestHeaders, requestBody, mockIndex });
  });
}

async function readBody(request) {
  try {
    const text = await request.text();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

function headersToRecord(headers) {
  const result = {};
  if (headers && typeof headers.forEach === 'function') {
    headers.forEach((value, key) => { result[key] = value; });
  } else if (headers && typeof headers === 'object') {
    for (const [k, v] of Object.entries(headers)) {
      if (v != null) result[k] = String(v);
    }
  }
  return result;
}

function buildResponse(rawBody, status, extraHeaders) {
  const responseHeaders = {};
  let body;
  if (typeof rawBody === 'string') {
    body = rawBody;
  } else {
    body = JSON.stringify(rawBody);
    responseHeaders['content-type'] = 'application/json';
  }
  if (extraHeaders) Object.assign(responseHeaders, extraHeaders);
  return new Response(body, { status, headers: responseHeaders });
}

export async function mountNetworkInterceptors({ apiMocks, networkMocks, actionDir }) {
  const hasMocks = (apiMocks?.length ?? 0) > 0 || (networkMocks?.length ?? 0) > 0;
  if (!hasMocks) return;

  const hasFunctionMatchers = (networkMocks ?? []).some(m => m.hasMatcherFunction);

  // ── undici MockAgent — npm undici-based clients ───────────────────────────
  let undici = null;
  try {
    const undiciPath = _require.resolve('undici', { paths: [actionDir] });
    undici = _require(undiciPath);
  } catch {
    try { undici = _require('undici'); } catch {
      process.stderr.write('[actharness] undici not available; npm-undici-based requests not mocked\n');
    }
  }

  if (undici) {
    const { MockAgent, setGlobalDispatcher } = undici;
    const agent = new MockAgent();
    // Only disable real connections when there are no function matchers.
    // Function matchers require MSW to evaluate; if disableNetConnect() is set,
    // undici blocks requests before MSW can intercept them.
    if (!hasFunctionMatchers) {
      agent.disableNetConnect();
    }

    for (const { pattern, response } of (apiMocks ?? [])) {
      const spaceIdx = pattern.indexOf(' ');
      const method = pattern.slice(0, spaceIdx).toUpperCase();
      const pathTemplate = pattern.slice(spaceIdx + 1);
      const pathRegex = new RegExp('^' + pathTemplate.replace(/\{[^}]+\}/g, '[^/?]+') + '(\\?.*)?$');
      const pool = agent.get('https://api.github.com');
      pool
        .intercept({ method, path: (p) => pathRegex.test(p) })
        .reply((opts) => {
          const requestHeaders = opts.headers ? headersToRecord(opts.headers) : {};
          process.send({ type: 'apiHit', pattern, url: opts.path, method, requestHeaders, requestBody: null });
          return { statusCode: 200, data: JSON.stringify(response), responseOptions: { headers: { 'content-type': 'application/json' } } };
        })
        .persist();
    }

    for (let i = 0; i < (networkMocks ?? []).length; i++) {
      const mock = networkMocks[i];
      // Skip function-matcher mocks in undici — they are evaluated by MSW via parent IPC.
      if (mock.hasMatcherFunction) continue;

      let origin = 'https://api.github.com';
      let pathTest;

      if (typeof mock.matcher === 'string') {
        try {
          const u = new URL(mock.matcher);
          origin = u.origin;
          const matchPath = u.pathname + (u.search ?? '');
          pathTest = (p) => p === matchPath;
        } catch {
          const substr = mock.matcher;
          pathTest = (p) => p.includes(substr);
        }
      } else {
        const re = new RegExp(mock.matcher.source, mock.matcher.flags);
        pathTest = (p) => re.test(p);
      }

      pool_intercept(agent, origin, pathTest, mock.status, mock.body, mock.hasFactory, mock.matcher);
    }

    setGlobalDispatcher(agent);
  }

  // ── @mswjs/interceptors — global fetch, http/https, axios, node-fetch ────
  try {
    const { BatchInterceptor } = await import('@mswjs/interceptors');
    const { default: nodePreset } = await import('@mswjs/interceptors/presets/node');

    const interceptor = new BatchInterceptor({ name: 'actharness-network', interceptors: nodePreset });
    interceptor.apply();

    interceptor.on('request', async ({ request, controller }) => {
      const url = request.url;
      const method = request.method.toUpperCase();
      const requestHeaders = headersToRecord(request.headers);
      const requestBody = await readBody(request.clone());

      let parsed;
      try { parsed = new URL(url); } catch { return; }

      // GitHub API routes
      for (const { pattern, response } of (apiMocks ?? [])) {
        const spaceIdx = pattern.indexOf(' ');
        const mockMethod = pattern.slice(0, spaceIdx).toUpperCase();
        const pathTemplate = pattern.slice(spaceIdx + 1);
        const pathRegex = new RegExp('^' + pathTemplate.replace(/\{[^}]+\}/g, '[^/?]+') + '(\\?.*)?$');
        if (
          parsed.hostname === 'api.github.com' &&
          method === mockMethod &&
          pathRegex.test(parsed.pathname)
        ) {
          process.send({ type: 'apiHit', pattern, url: parsed.pathname + (parsed.search ?? ''), method, requestHeaders, requestBody });
          await controller.respondWith(new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
          return;
        }
      }

      // Network mocks — iterate in order, function matchers resolved by parent
      for (let i = 0; i < (networkMocks ?? []).length; i++) {
        const mock = networkMocks[i];

        if (mock.hasMatcherFunction) {
          // Ask parent to evaluate function matcher (and factory if applicable).
          // Parent records the hit directly.
          const requestId = randomUUID();
          const result = await requestMatch(requestId, url, method, requestHeaders, requestBody, i);
          if (!result.matched) continue;

          await controller.respondWith(buildResponse(result.body, result.status, result.headers));
          return;
        }

        // Local matcher evaluation (string or RegExp)
        if (!matcherTest(mock.matcher, url)) continue;

        let finalBody = mock.body;
        let finalStatus = mock.status;
        let finalHeaders = mock.headers ? { ...mock.headers } : undefined;

        if (mock.hasFactory) {
          const requestId = randomUUID();
          try {
            const result = await requestFactory(requestId, url, method, requestHeaders, requestBody);
            finalBody = result.body;
            if (result.status !== undefined) finalStatus = result.status;
            if (result.headers) finalHeaders = { ...finalHeaders, ...result.headers };
          } catch {
            await controller.respondWith(new Response(
              JSON.stringify({ error: '[actharness] factory evaluation failed' }),
              { status: 500, headers: { 'content-type': 'application/json' } },
            ));
            return;
          }
        }

        const matchedPattern = typeof mock.matcher === 'string'
          ? mock.matcher
          : `/${mock.matcher.source}/${mock.matcher.flags}`;
        process.send({ type: 'networkHit', matchedPattern, url, method, requestHeaders, requestBody, response: finalBody });
        await controller.respondWith(buildResponse(finalBody, finalStatus, finalHeaders));
        return;
      }

      // Unmatched
      await controller.respondWith(new Response(
        JSON.stringify({ error: `[actharness] no mock registered for ${method} ${url}` }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      ));
    });
  } catch (err) {
    process.stderr.write(`[actharness] @mswjs/interceptors not mounted: ${err.message}\n`);
  }
}

function matcherTest(matcher, url) {
  if (typeof matcher === 'string') {
    try {
      const mu = new URL(matcher);
      const parsed = new URL(url);
      return parsed.origin === mu.origin &&
        (parsed.pathname + (parsed.search ?? '')) === (mu.pathname + (mu.search ?? ''));
    } catch {
      return url.includes(matcher);
    }
  }
  const re = new RegExp(matcher.source, matcher.flags);
  return re.test(url);
}

// undici MockAgent intercept helper for networkMocks (async factory not supported in undici reply callback)
function pool_intercept(agent, origin, pathTest, status, body, hasFactory, capturedMatcher) {
  const pool = agent.get(origin);
  pool
    .intercept({ path: pathTest })
    .reply((opts) => {
      const requestHeaders = opts.headers ? headersToRecord(opts.headers) : {};
      const matchedPattern = typeof capturedMatcher === 'string'
        ? capturedMatcher
        : `/${capturedMatcher.source}/${capturedMatcher.flags}`;
      // undici reply callback is sync — for factory mocks use the static body stub;
      // the MSW interceptor handles the async factory path for fetch/http/https.
      const replyBody = hasFactory ? {} : body;
      process.send({ type: 'networkHit', matchedPattern, url: opts.path, method: opts.method, requestHeaders, requestBody: null, response: replyBody });
      const bodyStr = typeof replyBody === 'string' ? replyBody : JSON.stringify(replyBody);
      const headers = typeof replyBody === 'string' ? {} : { 'content-type': 'application/json' };
      return { statusCode: status, data: bodyStr, responseOptions: { headers } };
    })
    .persist();
}
