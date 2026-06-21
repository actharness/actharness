import { describe, it, expect } from 'vitest';
import {
  ActionMockHandle,
  ScopeRegistry,
  fileRootRegistry,
  scopeALS,
  currentScope,
  currentStack,
  lookupMock,
  runInDescribeScope,
  runInTestScope,
  globalMock,
  globalMockOnce,
  globalResetMocks,
} from '../src/mock-scope.js';

// ── ActionMockHandle ──────────────────────────────────────────────────────────

describe('ActionMockHandle — initial state', () => {
  it('has called=false and callCount=0', () => {
    const h = new ActionMockHandle();
    expect(h.called).toBe(false);
    expect(h.callCount).toBe(0);
    expect(h.calls).toEqual([]);
  });
});

describe('ActionMockHandle — resolve()', () => {
  it('defaults to success and empty outputs', async () => {
    const h = new ActionMockHandle();
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.conclusion).toBe('success');
    expect(r.outputs).toEqual({});
  });

  it('records calls', async () => {
    const h = new ActionMockHandle();
    await h.resolve({ with: { k: 'v' }, env: { CI: '1' } });
    expect(h.called).toBe(true);
    expect(h.callCount).toBe(1);
    expect(h.calls[0]?.with['k']).toBe('v');
  });

  it('mockOutputs sets fixed outputs', async () => {
    const h = new ActionMockHandle();
    h.mockOutputs({ sha: 'abc' });
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['sha']).toBe('abc');
  });

  it('mockConclusion sets conclusion', async () => {
    const h = new ActionMockHandle();
    h.mockConclusion('failure');
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.conclusion).toBe('failure');
  });

  it('mockImplementation overrides conclusion', async () => {
    const h = new ActionMockHandle();
    h.mockImplementation(async () => ({ conclusion: 'failure' }));
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.conclusion).toBe('failure');
  });

  it('mockImplementation merges returned outputs with base outputs', async () => {
    const h = new ActionMockHandle();
    h.mockOutputs({ a: '1', b: '2' });
    h.mockImplementation(async () => ({ outputs: { b: 'override' } }));
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['a']).toBe('1');
    expect(r.outputs['b']).toBe('override');
  });

  it('defaults to empty env', async () => {
    const h = new ActionMockHandle();
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.env).toEqual({});
  });

  it('mockImplementation returning env merges with base env', async () => {
    const h = new ActionMockHandle();
    h._env = { BASE: 'base' };
    h.mockImplementation(async () => ({ env: { EXTRA: 'extra' } }));
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.env['BASE']).toBe('base');
    expect(r.env['EXTRA']).toBe('extra');
  });

  it('mockImplementationOnce fires only the first time', async () => {
    const h = new ActionMockHandle();
    h.mockOutputs({ val: 'base' });
    h.mockImplementationOnce(() => ({ outputs: { val: 'once' } }));
    const r1 = await h.resolve({ with: {}, env: {} });
    const r2 = await h.resolve({ with: {}, env: {} });
    expect(r1.outputs['val']).toBe('once');
    expect(r2.outputs['val']).toBe('base');
  });

  it('mockImplementation receiving null result falls back to base', async () => {
    const h = new ActionMockHandle();
    h.mockOutputs({ val: 'base' });
    h.mockImplementation(() => null as unknown as void);
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['val']).toBe('base');
  });
});

describe('ActionMockHandle — clear()', () => {
  it('resets call history and config', async () => {
    const h = new ActionMockHandle();
    h.mockOutputs({ x: '1' });
    h.mockConclusion('failure');
    await h.resolve({ with: {}, env: {} });
    h.clear();
    expect(h.callCount).toBe(0);
    expect(h.called).toBe(false);
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.conclusion).toBe('success');
    expect(r.outputs).toEqual({});
  });

  it('resets _hasPersistentRegistration so isEmpty() is true after clear', () => {
    const h = new ActionMockHandle();
    h._hasPersistentRegistration = true;
    h.clear();
    expect(h.isEmpty()).toBe(true);
  });
});

describe('ActionMockHandle — isEmpty()', () => {
  it('is true on a fresh handle', () => {
    expect(new ActionMockHandle().isEmpty()).toBe(true);
  });

  it('is false when _hasPersistentRegistration is set', () => {
    const h = new ActionMockHandle();
    h._hasPersistentRegistration = true;
    expect(h.isEmpty()).toBe(false);
  });

  it('is false when once queue has entries', () => {
    const h = new ActionMockHandle();
    h.mockImplementationOnce(() => undefined);
    expect(h.isEmpty()).toBe(false);
  });

  it('is true once the once queue is drained and no persistent registration', async () => {
    const h = new ActionMockHandle();
    h.mockImplementationOnce(() => undefined);
    await h.resolve({ with: {}, env: {} });
    expect(h.isEmpty()).toBe(true);
  });
});

// ── ScopeRegistry ─────────────────────────────────────────────────────────────

describe('ScopeRegistry.mock()', () => {
  it('creates a handle on first call', () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('a/b@v1');
    expect(h).toBeDefined();
    expect(h.called).toBe(false);
  });

  it('returns the same handle for the same ref', () => {
    const reg = new ScopeRegistry();
    const h1 = reg.mock('a/b@v1');
    const h2 = reg.mock('a/b@v1');
    expect(h1).toBe(h2);
  });

  it('accepts an ActionMockDef with outputs', async () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('a/b@v1', { outputs: { result: '42' } }) as ActionMockHandle;
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['result']).toBe('42');
  });

  it('accepts an ActionMockDef with env', async () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('a/b@v1', { env: { MY_VAR: 'hello' } }) as ActionMockHandle;
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.env['MY_VAR']).toBe('hello');
  });

  it('accepts an ActionMockImpl function', async () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('a/b@v1', async () => ({ outputs: { x: 'fn' } })) as ActionMockHandle;
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['x']).toBe('fn');
  });
});

describe('ScopeRegistry.mockOnce()', () => {
  it('creates a handle that is consumed after one resolve', async () => {
    const reg = new ScopeRegistry();
    const h = reg.mockOnce('a/b@v1', { outputs: { val: 'once' } }) as ActionMockHandle;
    const r1 = await h.resolve({ with: {}, env: {} });
    expect(r1.outputs['val']).toBe('once');
    expect(h.isEmpty()).toBe(true);
  });

  it('falls back to persistent after once is consumed', async () => {
    const reg = new ScopeRegistry();
    reg.mock('a/b@v1', { outputs: { val: 'persistent' } });
    reg.mockOnce('a/b@v1', { outputs: { val: 'once' } });
    const h = reg.get('a/b@v1')!;
    const r1 = await h.resolve({ with: {}, env: {} });
    const r2 = await h.resolve({ with: {}, env: {} });
    expect(r1.outputs['val']).toBe('once');
    expect(r2.outputs['val']).toBe('persistent');
  });

  it('once queue is FIFO across multiple mockOnce calls', async () => {
    const reg = new ScopeRegistry();
    reg.mockOnce('a/b@v1', { outputs: { val: 'first' } });
    reg.mockOnce('a/b@v1', { outputs: { val: 'second' } });
    const h = reg.get('a/b@v1')!;
    const r1 = await h.resolve({ with: {}, env: {} });
    const r2 = await h.resolve({ with: {}, env: {} });
    expect(r1.outputs['val']).toBe('first');
    expect(r2.outputs['val']).toBe('second');
    expect(h.isEmpty()).toBe(true);
  });

  it('accepts an ActionMockImpl function', async () => {
    const reg = new ScopeRegistry();
    reg.mockOnce('a/b@v1', async () => ({ outputs: { x: 'fn-once' } }));
    const h = reg.get('a/b@v1')!;
    const r = await h.resolve({ with: {}, env: {} });
    expect(r.outputs['x']).toBe('fn-once');
    expect(h.isEmpty()).toBe(true);
  });

  it('returns the same handle for the same ref as mock()', () => {
    const reg = new ScopeRegistry();
    const h1 = reg.mock('a/b@v1');
    const h2 = reg.mockOnce('a/b@v1', { outputs: { x: '1' } });
    expect(h1).toBe(h2);
  });
});

describe('ScopeRegistry.resetMocks()', () => {
  it('removes all mocks from the registry', () => {
    const reg = new ScopeRegistry();
    reg.mock('a/b@v1');
    reg.mock('c/d@v2');
    reg.resetMocks();
    expect(reg.get('a/b@v1')).toBeUndefined();
    expect(reg.get('c/d@v2')).toBeUndefined();
  });

  it('clears call history on each handle', async () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('a/b@v1') as ActionMockHandle;
    await h.resolve({ with: {}, env: {} });
    expect(h.callCount).toBe(1);
    reg.resetMocks();
    expect(h.callCount).toBe(0);
  });
});

describe('ScopeRegistry.get()', () => {
  it('returns the handle when present', () => {
    const reg = new ScopeRegistry();
    const h = reg.mock('x/y@v1');
    expect(reg.get('x/y@v1')).toBe(h);
  });

  it('returns undefined for unknown ref', () => {
    const reg = new ScopeRegistry();
    expect(reg.get('unknown/ref@v1')).toBeUndefined();
  });
});

// ── Scope stack helpers ───────────────────────────────────────────────────────

describe('currentScope() / currentStack()', () => {
  it('outside any ALS returns fileRootRegistry', () => {
    expect(currentScope()).toBe(fileRootRegistry);
    expect(currentStack()).toEqual([fileRootRegistry]);
  });

  it('inside scopeALS.run() returns the last scope', () => {
    const s1 = new ScopeRegistry();
    const s2 = new ScopeRegistry();
    scopeALS.run([s1, s2], () => {
      expect(currentScope()).toBe(s2);
      expect(currentStack()).toEqual([s1, s2]);
    });
  });
});

describe('lookupMock()', () => {
  it('outside any ALS returns undefined for unknown ref', () => {
    expect(lookupMock('no/such@v1')).toBeUndefined();
  });

  it('finds a mock in the current scope', () => {
    const scope = new ScopeRegistry();
    const h = scope.mock('a/b@v1');
    scopeALS.run([scope], () => {
      expect(lookupMock('a/b@v1')).toBe(h);
    });
  });

  it('inner scope overrides outer scope for the same ref', () => {
    const outer = new ScopeRegistry();
    const inner = new ScopeRegistry();
    outer.mock('a/b@v1', { outputs: { v: 'outer' } });
    const innerHandle = inner.mock('a/b@v1', { outputs: { v: 'inner' } });
    scopeALS.run([outer, inner], () => {
      expect(lookupMock('a/b@v1')).toBe(innerHandle);
    });
  });

  it('falls back to outer scope when inner has no mock for the ref', () => {
    const outer = new ScopeRegistry();
    const inner = new ScopeRegistry();
    const outerHandle = outer.mock('a/b@v1');
    scopeALS.run([outer, inner], () => {
      expect(lookupMock('a/b@v1')).toBe(outerHandle);
    });
  });

  it('returns undefined when handle is empty (once consumed, no persistent)', async () => {
    const scope = new ScopeRegistry();
    scope.mockOnce('a/b@v1', { outputs: { val: 'once' } });
    const h = scope.get('a/b@v1')!;
    await h.resolve({ with: {}, env: {} });
    scopeALS.run([scope], () => {
      expect(lookupMock('a/b@v1')).toBeUndefined();
    });
  });

  it('returns handle when once queue still has entries', () => {
    const scope = new ScopeRegistry();
    scope.mockOnce('a/b@v1', { outputs: { val: 'once' } });
    scopeALS.run([scope], () => {
      expect(lookupMock('a/b@v1')).toBeDefined();
    });
  });

  it('supports three-level scope chain (file → describe → test)', () => {
    const file = new ScopeRegistry();
    const describe = new ScopeRegistry();
    const test = new ScopeRegistry();
    const fileH = file.mock('a/b@v1');
    scopeALS.run([file, describe, test], () => {
      expect(lookupMock('a/b@v1')).toBe(fileH);
      const describeH = describe.mock('a/b@v1');
      expect(lookupMock('a/b@v1')).toBe(describeH);
      const testH = test.mock('a/b@v1');
      expect(lookupMock('a/b@v1')).toBe(testH);
    });
  });
});

// ── runInDescribeScope / runInTestScope ───────────────────────────────────────

describe('runInDescribeScope()', () => {
  it('runs fn in a new child scope appended to parentStack', () => {
    const parent = new ScopeRegistry();
    let innerScope: ScopeRegistry | undefined;
    runInDescribeScope([parent], () => {
      const stack = currentStack();
      expect(stack[0]).toBe(parent);
      expect(stack.length).toBe(2);
      innerScope = currentScope();
    });
    expect(innerScope).toBeDefined();
    expect(innerScope).not.toBe(parent);
  });

  it('supports nested describe scopes', () => {
    const file = new ScopeRegistry();
    let depth1Scope: ScopeRegistry | undefined;
    let depth2Scope: ScopeRegistry | undefined;
    runInDescribeScope([file], () => {
      depth1Scope = currentScope();
      const stack1 = currentStack();
      runInDescribeScope(stack1, () => {
        depth2Scope = currentScope();
        expect(currentStack().length).toBe(3);
        expect(currentStack()[0]).toBe(file);
        expect(currentStack()[1]).toBe(depth1Scope);
      });
    });
    expect(depth2Scope).not.toBe(depth1Scope);
  });
});

describe('runInTestScope()', () => {
  it('runs fn in a new child scope', async () => {
    const describe = new ScopeRegistry();
    let testScope: ScopeRegistry | undefined;
    await runInTestScope([describe], () => {
      testScope = currentScope();
    });
    expect(testScope).toBeDefined();
    expect(testScope).not.toBe(describe);
  });

  it('mocks registered in parent scope are visible inside test scope', async () => {
    const describe = new ScopeRegistry();
    const h = describe.mock('a/b@v1');
    await runInTestScope([describe], () => {
      expect(lookupMock('a/b@v1')).toBe(h);
    });
  });
});

// ── globalMock / globalResetMocks ─────────────────────────────────────────────

describe('globalMock() / globalMockOnce() / globalResetMocks()', () => {
  it('globalMock registers in the current scope', () => {
    const scope = new ScopeRegistry();
    scopeALS.run([scope], () => {
      const h = globalMock('a/b@v1');
      expect(scope.get('a/b@v1')).toBe(h);
    });
  });

  it('globalMockOnce registers a once entry in the current scope', async () => {
    const scope = new ScopeRegistry();
    await scopeALS.run([scope], async () => {
      globalMockOnce('a/b@v1', { outputs: { val: 'once' } });
      const h = scope.get('a/b@v1')!;
      const r = await h.resolve({ with: {}, env: {} });
      expect(r.outputs['val']).toBe('once');
      expect(h.isEmpty()).toBe(true);
    });
  });

  it('globalResetMocks clears the current scope', () => {
    const scope = new ScopeRegistry();
    scopeALS.run([scope], () => {
      globalMock('a/b@v1');
      globalResetMocks();
      expect(scope.get('a/b@v1')).toBeUndefined();
    });
  });
});
