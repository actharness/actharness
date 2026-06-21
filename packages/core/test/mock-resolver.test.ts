import { describe, it, expect } from 'vitest';
import type { ActharnessOptions } from '@actharness/types';
import {
  MockRegistry,
  checkCycle,
  checkMaxDepth,
  DEFAULT_MAX_DEPTH,
} from '../src/mock-resolver.js';
import { ScopeRegistry, scopeALS } from '../src/mock-scope.js';
import { MissingMockError, ConfigError, CycleError, MaxDepthError } from '../src/errors.js';

const NO_OPTS: ActharnessOptions = {};
const ACTION_DIR = '/fake/action';

// Helper: run resolve() inside a scope that has the given ref mocked.
function resolveWithMock(
  ref: string,
  opts: ActharnessOptions = NO_OPTS,
): ReturnType<MockRegistry['resolve']> {
  const scope = new ScopeRegistry();
  scope.mock(ref);
  let res!: ReturnType<MockRegistry['resolve']>;
  scopeALS.run([scope], () => {
    res = new MockRegistry().resolve(ref, ACTION_DIR, opts);
  });
  return res;
}

describe('MockRegistry.resolve — policy (no explicit mock)', () => {
  it('returns real resolution for local ref with default options', () => {
    const res = new MockRegistry().resolve('./child-action', ACTION_DIR, NO_OPTS);
    expect(res.kind).toBe('real');
  });

  it('returns noop resolution for remote ref with default options', () => {
    const res = new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, NO_OPTS);
    expect(res.kind).toBe('noop');
  });

  it('noop includes the ref in the warning message', () => {
    const res = new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, NO_OPTS);
    expect(res.kind).toBe('noop');
    if (res.kind === 'noop') {
      expect(res.warning).toContain('actions/checkout@v4');
    }
  });

  it('throws MissingMockError when unmockedUses=error for remote', () => {
    expect(() =>
      new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, { unmockedUses: 'error' }),
    ).toThrow(MissingMockError);
  });

  it('throws MissingMockError when unmockedUses.remote=error', () => {
    expect(() =>
      new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, {
        unmockedUses: { remote: 'error' },
      }),
    ).toThrow(MissingMockError);
  });

  it('unmockedUses=noop for local still returns noop', () => {
    const res = new MockRegistry().resolve('./child', ACTION_DIR, { unmockedUses: 'noop' });
    expect(res.kind).toBe('noop');
  });

  it('throws ConfigError when unmockedUses=real for remote ref', () => {
    expect(() =>
      new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, { unmockedUses: 'real' }),
    ).toThrow(ConfigError);
  });

  it('object unmockedUses without remote key defaults remotePolicy to noop', () => {
    const res = new MockRegistry().resolve('actions/checkout@v4', ACTION_DIR, {
      unmockedUses: { local: 'error' },
    });
    expect(res.kind).toBe('noop');
  });

  it('local noop warning message includes action ref', () => {
    const res = new MockRegistry().resolve('./child', ACTION_DIR, { unmockedUses: 'noop' });
    expect(res.kind).toBe('noop');
    if (res.kind === 'noop') {
      expect(res.warning).toContain('./child');
    }
  });
});

describe('MockRegistry.resolve — scope-chain mock wins over policy', () => {
  it('returns mock resolution when ref is in scope chain', () => {
    const res = resolveWithMock('actions/checkout@v4');
    expect(res.kind).toBe('mock');
  });

  it('scope mock overrides unmockedUses=error policy', () => {
    const res = resolveWithMock('actions/checkout@v4', { unmockedUses: 'error' });
    expect(res.kind).toBe('mock');
  });

  it('scope mock overrides unmockedUses=real policy for remote ref', () => {
    const res = resolveWithMock('actions/checkout@v4', { unmockedUses: 'real' });
    expect(res.kind).toBe('mock');
  });

  it('scope mock for local ref resolves as mock (not real)', () => {
    const res = resolveWithMock('./local-child');
    expect(res.kind).toBe('mock');
  });
});

describe('checkCycle', () => {
  it('throws CycleError when ref is in path', () => {
    expect(() =>
      checkCycle(['/dir/a', '/dir/b'], '/dir/a'),
    ).toThrow(CycleError);
  });

  it('does not throw when ref is not in path', () => {
    expect(() =>
      checkCycle(['/dir/a', '/dir/b'], '/dir/c'),
    ).not.toThrow();
  });
});

describe('checkMaxDepth', () => {
  it('throws MaxDepthError when depth exceeds limit', () => {
    expect(() => checkMaxDepth(51, 50)).toThrow(MaxDepthError);
  });

  it('does not throw at or below limit', () => {
    expect(() => checkMaxDepth(50, 50)).not.toThrow();
    expect(() => checkMaxDepth(0)).not.toThrow();
  });

  it('uses DEFAULT_MAX_DEPTH when limit omitted', () => {
    expect(DEFAULT_MAX_DEPTH).toBe(50);
    expect(() => checkMaxDepth(DEFAULT_MAX_DEPTH + 1)).toThrow(MaxDepthError);
  });
});
