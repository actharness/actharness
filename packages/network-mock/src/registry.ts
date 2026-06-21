import type {
  GitHubApiRoutes,
  NetworkMatcher,
  NetworkMock,
  NetworkMockCall,
} from '@actharness/types';
import { currentScope, currentStack } from '@actharness/core';
import type { ScopeRegistry } from '@actharness/core';

// ── NetworkMockHandle ─────────────────────────────────────────────────────────

export class NetworkMockHandle implements NetworkMock {
  readonly calls: NetworkMockCall[] = [];
  get called(): boolean { return this.calls.length > 0; }
  get callCount(): number { return this.calls.length; }
  clear(): void { this.calls.length = 0; }
  _record(call: NetworkMockCall): void { this.calls.push(call); }
}

// ── Response descriptor returned by factory functions ─────────────────────────

export interface MockResponseDescriptor {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

// ── Serializable matcher shape (sent to the sandbox child process via IPC) ────

export type SerializedMatcher = string | { source: string; flags: string };

// ── Pending mock entries (held in parent process) ─────────────────────────────

export interface ApiMockEntry {
  pattern: string;
  response: Record<string, unknown> | unknown[];
  handle: NetworkMockHandle;
  once?: boolean;
  consumed?: boolean;
}

export interface NetworkMockEntry {
  matcher: NetworkMatcher;
  status: number;
  /** Static response body. Undefined when response is a factory function. */
  response: unknown;
  /** Optional response headers for static responses. */
  responseHeaders?: Record<string, string>;
  /** Factory called with (url, method, body) when response is a function. */
  responseFactory: ((url: string, method: string, body: string | null) => MockResponseDescriptor) | null;
  handle: NetworkMockHandle;
  once?: boolean;
  consumed?: boolean;
}

// ── Serialized form for the Node IPC path ─────────────────────────────────────

export interface SerializedNetworkMock {
  matcher: SerializedMatcher | null;
  /** True when the original matcher was a function — resolved by the parent on each request. */
  hasMatcherFunction: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  hasFactory: boolean;
}

export interface DrainedForNode {
  apiMocks: Array<{ pattern: string; response: Record<string, unknown> | unknown[] }>;
  networkMocks: SerializedNetworkMock[];
  apiEntries: ApiMockEntry[];
  networkEntries: NetworkMockEntry[];
}

// ── Scope-aware registry ──────────────────────────────────────────────────────
// Network mock entries are stored per-scope using the ALS scope stack from
// @actharness/core. drainForProxy/Node walks the stack innermost-first so
// inner-scope registrations match before outer-scope ones — the same "inner
// overrides outer" behaviour that action mocks get from lookupMock().

interface ScopeNetworkState {
  apiEntries: ApiMockEntry[];
  networkEntries: NetworkMockEntry[];
}

const _scopeState = new WeakMap<ScopeRegistry, ScopeNetworkState>();

function getScopeState(scope: ScopeRegistry): ScopeNetworkState {
  let state = _scopeState.get(scope);
  if (!state) {
    state = { apiEntries: [], networkEntries: [] };
    _scopeState.set(scope, state);
  }
  return state;
}

export function mockGitHubApi(routes: GitHubApiRoutes): NetworkMock {
  const handle = new NetworkMockHandle();
  const state = getScopeState(currentScope());
  for (const [pattern, response] of Object.entries(routes)) {
    if (typeof response === 'function') {
      throw new TypeError(
        `mockGitHubApi: function responses are not supported; provide a plain object or array for route '${pattern}'`,
      );
    }
    state.apiEntries.push({ pattern, response: response as Record<string, unknown> | unknown[], handle });
  }
  return handle;
}

export function mockGitHubApiOnce(routes: GitHubApiRoutes): NetworkMock {
  const handle = new NetworkMockHandle();
  const state = getScopeState(currentScope());
  for (const [pattern, response] of Object.entries(routes)) {
    if (typeof response === 'function') {
      throw new TypeError(
        `mockGitHubApiOnce: function responses are not supported; provide a plain object or array for route '${pattern}'`,
      );
    }
    state.apiEntries.push({ pattern, response: response as Record<string, unknown> | unknown[], handle, once: true });
  }
  return handle;
}

export function mockNetwork(
  matcher: NetworkMatcher,
  status: number,
  response: unknown,
  headers?: Record<string, string>,
): NetworkMock {
  const handle = new NetworkMockHandle();
  const isFactory = typeof response === 'function';
  const entry: NetworkMockEntry = {
    matcher,
    status,
    response: isFactory ? undefined : response,
    responseFactory: isFactory
      ? (response as (url: string, method: string, body: string | null) => MockResponseDescriptor)
      : null,
    handle,
  };
  if (!isFactory && headers) entry.responseHeaders = headers;
  getScopeState(currentScope()).networkEntries.push(entry);
  return handle;
}

export function mockNetworkOnce(
  matcher: NetworkMatcher,
  status: number,
  response: unknown,
  headers?: Record<string, string>,
): NetworkMock {
  const handle = new NetworkMockHandle();
  const isFactory = typeof response === 'function';
  const entry: NetworkMockEntry = {
    matcher,
    status,
    response: isFactory ? undefined : response,
    responseFactory: isFactory
      ? (response as (url: string, method: string, body: string | null) => MockResponseDescriptor)
      : null,
    handle,
    once: true,
  };
  if (!isFactory && headers) entry.responseHeaders = headers;
  getScopeState(currentScope()).networkEntries.push(entry);
  return handle;
}

// ── Drain helpers ─────────────────────────────────────────────────────────────
// Walk the scope stack innermost-first so test-scope entries appear before
// describe-scope entries, which appear before file-scope entries.
// First-match-wins in matchApiEntry/matchNetworkEntry gives inner-scope priority.
// Entries are object references — consumed/once flags propagate back to the
// originating scope's state without any feedback protocol.

export function drainForProxy(): { apiEntries: ApiMockEntry[]; networkEntries: NetworkMockEntry[] } {
  const stack = currentStack();
  const apiEntries: ApiMockEntry[] = [];
  const networkEntries: NetworkMockEntry[] = [];
  for (let i = stack.length - 1; i >= 0; i--) {
    const state = _scopeState.get(stack[i]!);
    if (state) {
      apiEntries.push(...state.apiEntries);
      networkEntries.push(...state.networkEntries);
    }
  }
  return { apiEntries, networkEntries };
}

export function drainForNode(): DrainedForNode {
  const { apiEntries, networkEntries } = drainForProxy();

  const networkMocks: SerializedNetworkMock[] = networkEntries.map((e) => {
    const isFunction = typeof e.matcher === 'function';
    let serialized: SerializedMatcher | null;
    if (isFunction) {
      serialized = null;
    } else if (e.matcher instanceof RegExp) {
      serialized = { source: e.matcher.source, flags: e.matcher.flags };
    } else {
      serialized = e.matcher as string;
    }
    const mock: SerializedNetworkMock = {
      matcher: serialized,
      hasMatcherFunction: isFunction,
      status: e.status,
      body: e.responseFactory ? undefined : e.response,
      hasFactory: e.responseFactory !== null,
    };
    if (e.responseHeaders) mock.headers = e.responseHeaders;
    return mock;
  });

  return {
    apiMocks: apiEntries.map(e => ({ pattern: e.pattern, response: e.response })),
    networkMocks,
    apiEntries,
    networkEntries,
  };
}

// ── Hit recording helpers (used by js-sandbox parent after IPC messages) ──────

export function recordApiHit(
  entries: ApiMockEntry[],
  pattern: string,
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  requestBody: string | null,
): void {
  for (const entry of entries) {
    if (entry.pattern === pattern) {
      if (entry.once) entry.consumed = true;
      entry.handle._record({
        url,
        method,
        requestHeaders,
        requestBody,
        response: entry.response,
        matchedPattern: pattern,
      });
    }
  }
}

export function recordNetworkHit(
  entries: NetworkMockEntry[],
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  requestBody: string | null,
  response: unknown,
  matchedPattern: string,
): void {
  for (const entry of entries) {
    const m = entry.matcher;
    let matched: boolean;
    if (typeof m === 'string') {
      try {
        const u = new URL(m);
        matched = url === u.href || url === (u.pathname + (u.search || ''));
      } catch {
        matched = url.includes(m);
      }
    } else if (m instanceof RegExp) {
      matched = m.test(url);
    } else {
      matched = false;
    }
    if (matched) {
      if (entry.once) entry.consumed = true;
      entry.handle._record({ url, method, requestHeaders, requestBody, response, matchedPattern });
      break;
    }
  }
}

// ── Match helpers (used by proxy path and node parent for matcher evaluation) ──

export function matchNetworkEntry(
  entries: NetworkMockEntry[],
  url: string,
  method: string,
): NetworkMockEntry | undefined {
  for (const entry of entries) {
    if (entry.consumed) continue;
    const m = entry.matcher;
    let matched: boolean;
    if (typeof m === 'string') {
      try {
        const mu = new URL(m);
        const parsed = new URL(url);
        matched = parsed.origin === mu.origin &&
          (parsed.pathname + (parsed.search || '')) === (mu.pathname + (mu.search || ''));
      } catch {
        matched = url.includes(m);
      }
    } else if (m instanceof RegExp) {
      matched = m.test(url);
    } else {
      matched = m(url, method);
    }
    if (matched) return entry;
  }
  return undefined;
}

export function matchApiEntry(
  entries: ApiMockEntry[],
  url: string,
  method: string,
): ApiMockEntry | undefined {
  for (const entry of entries) {
    if (entry.consumed) continue;
    const spaceIdx = entry.pattern.indexOf(' ');
    const mockMethod = entry.pattern.slice(0, spaceIdx).toUpperCase();
    const pathTemplate = entry.pattern.slice(spaceIdx + 1);
    const pathRegex = new RegExp(
      '^' + pathTemplate.replace(/\{[^}]+\}/g, '[^/?]+') + '(\\?.*)?$',
    );
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if (
      parsed.hostname === 'api.github.com' &&
      method.toUpperCase() === mockMethod &&
      pathRegex.test(parsed.pathname)
    ) {
      return entry;
    }
  }
  return undefined;
}

export function resetNetworkMocks(): void {
  _scopeState.delete(currentScope());
}

export function pruneConsumedOnce(): void {
  for (const scope of currentStack()) {
    const state = _scopeState.get(scope);
    if (!state) continue;
    for (let i = state.apiEntries.length - 1; i >= 0; i--) {
      if (state.apiEntries[i]!.once && state.apiEntries[i]!.consumed) {
        state.apiEntries.splice(i, 1);
      }
    }
    for (let i = state.networkEntries.length - 1; i >= 0; i--) {
      if (state.networkEntries[i]!.once && state.networkEntries[i]!.consumed) {
        state.networkEntries.splice(i, 1);
      }
    }
  }
}
