import { describe, it, expect, vi } from 'vitest';

vi.mock('node:test', () => ({
  describe: vi.fn(), it: vi.fn(), test: vi.fn(),
  before: vi.fn(), after: vi.fn(), beforeEach: vi.fn(), afterEach: vi.fn(),
}));

vi.mock('@actharness/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@actharness/core')>();
  return { ...actual };
});

describe('lifecycle wrappers', () => {
  it('describe: captures scope and delegates to nodeDescribe', async () => {
    const { describe: wrapDescribe } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as { describe: ReturnType<typeof vi.fn> };

    const fn = vi.fn();
    wrapDescribe('suite', fn);
    const cb = nodeTest.describe.mock.calls[0]?.[1] as () => void;
    cb();
    expect(fn).toHaveBeenCalled();
  });

  it('it: captures scope and delegates to nodeIt', async () => {
    const { it: wrapIt } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as { it: ReturnType<typeof vi.fn> };

    const fn = vi.fn();
    wrapIt('test', fn);
    const cb = nodeTest.it.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();
    expect(fn).toHaveBeenCalled();
  });

  it('test: captures scope and delegates to nodeTest', async () => {
    const { test: wrapTest } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as { test: ReturnType<typeof vi.fn> };

    const fn = vi.fn();
    wrapTest('test', fn);
    const cb = nodeTest.test.mock.calls[0]?.[1] as () => Promise<void>;
    await cb();
    expect(fn).toHaveBeenCalled();
  });

  it('beforeEach: captures scope and delegates to nodeBeforeEach', async () => {
    const { beforeEach: wrapBeforeEach } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as { beforeEach: ReturnType<typeof vi.fn> };

    const fn = vi.fn();
    wrapBeforeEach(fn);
    const cb = nodeTest.beforeEach.mock.calls[0]?.[0] as () => Promise<void>;
    await cb();
    expect(fn).toHaveBeenCalled();
  });

  it('afterEach: captures scope and delegates to nodeAfterEach', async () => {
    const { afterEach: wrapAfterEach } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as { afterEach: ReturnType<typeof vi.fn> };

    const fn = vi.fn();
    wrapAfterEach(fn);
    const cb = nodeTest.afterEach.mock.calls[0]?.[0] as () => Promise<void>;
    await cb();
    expect(fn).toHaveBeenCalled();
  });

  it('before, after, beforeAll, afterAll are re-exported from node:test', async () => {
    const { before, after, beforeAll, afterAll } = await import('../src/lifecycle.js');
    const nodeTest = await import('node:test') as unknown as {
      before: ReturnType<typeof vi.fn>;
      after: ReturnType<typeof vi.fn>;
    };
    expect(before).toBe(nodeTest.before);
    expect(after).toBe(nodeTest.after);
    expect(beforeAll).toBe(nodeTest.before);
    expect(afterAll).toBe(nodeTest.after);
  });
});
