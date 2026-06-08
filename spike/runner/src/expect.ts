export interface Matcher {
  readonly not: Matcher;
  // primitives
  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toBeDefined(): void;
  toBeTruthy(): void;
  toBeFalsy(): void;
  // numbers
  toBeGreaterThan(n: number): void;
  toBeGreaterThanOrEqual(n: number): void;
  toBeLessThan(n: number): void;
  toBeLessThanOrEqual(n: number): void;
  // collections / strings
  toHaveLength(n: number): void;
  toContain(item: unknown): void;
  toMatch(pattern: RegExp | string): void;
  // functions
  toThrow(): void;
  // actspec-specific
  toHaveSucceeded(): void;
  toHaveFailed(): void;
  toHaveOutput(key: string, expected?: string): void;
  toHaveBeenCalledWith(expected: Record<string, string>): void;
}

class AssertionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssertionError';
  }
}

function createMatcher(value: unknown, negated: boolean): Matcher {
  function assert(condition: boolean, failMsg: string, passMsg: string): void {
    if (negated ? condition : !condition) {
      throw new AssertionError(negated ? passMsg : failMsg);
    }
  }

  return {
    get not(): Matcher {
      return createMatcher(value, !negated);
    },

    toBe(expected: unknown): void {
      assert(
        value === expected,
        `Expected ${JSON.stringify(value)} to be ${JSON.stringify(expected)}`,
        `Expected ${JSON.stringify(value)} not to be ${JSON.stringify(expected)}`,
      );
    },

    toEqual(expected: unknown): void {
      assert(
        JSON.stringify(value) === JSON.stringify(expected),
        `Expected ${JSON.stringify(value)} to equal ${JSON.stringify(expected)}`,
        `Expected ${JSON.stringify(value)} not to equal ${JSON.stringify(expected)}`,
      );
    },

    toBeDefined(): void {
      assert(
        value !== undefined,
        `Expected value to be defined but got undefined`,
        `Expected value not to be defined`,
      );
    },

    toBeTruthy(): void {
      assert(
        !!value,
        `Expected ${JSON.stringify(value)} to be truthy`,
        `Expected ${JSON.stringify(value)} not to be truthy`,
      );
    },

    toBeFalsy(): void {
      assert(
        !value,
        `Expected ${JSON.stringify(value)} to be falsy`,
        `Expected ${JSON.stringify(value)} not to be falsy`,
      );
    },

    toBeGreaterThan(n: number): void {
      assert(
        (value as number) > n,
        `Expected ${value} to be greater than ${n}`,
        `Expected ${value} not to be greater than ${n}`,
      );
    },

    toBeGreaterThanOrEqual(n: number): void {
      assert(
        (value as number) >= n,
        `Expected ${value} to be >= ${n}`,
        `Expected ${value} not to be >= ${n}`,
      );
    },

    toBeLessThan(n: number): void {
      assert(
        (value as number) < n,
        `Expected ${value} to be less than ${n}`,
        `Expected ${value} not to be less than ${n}`,
      );
    },

    toBeLessThanOrEqual(n: number): void {
      assert(
        (value as number) <= n,
        `Expected ${value} to be <= ${n}`,
        `Expected ${value} not to be <= ${n}`,
      );
    },

    toHaveLength(n: number): void {
      const len = (value as { length: number }).length;
      assert(
        len === n,
        `Expected length ${len} to be ${n}`,
        `Expected length not to be ${n}`,
      );
    },

    toContain(item: unknown): void {
      const has = Array.isArray(value)
        ? value.includes(item)
        : typeof value === 'string' && value.includes(String(item));
      assert(
        has,
        `Expected ${JSON.stringify(value)} to contain ${JSON.stringify(item)}`,
        `Expected ${JSON.stringify(value)} not to contain ${JSON.stringify(item)}`,
      );
    },

    toMatch(pattern: RegExp | string): void {
      const str = value as string;
      const matched =
        typeof pattern === 'string' ? str.includes(pattern) : pattern.test(str);
      assert(
        matched,
        `Expected ${JSON.stringify(str)} to match ${pattern}`,
        `Expected ${JSON.stringify(str)} not to match ${pattern}`,
      );
    },

    toThrow(): void {
      const fn = value as () => unknown;
      let threw = false;
      try {
        fn();
      } catch {
        threw = true;
      }
      assert(
        threw,
        `Expected function to throw but it did not`,
        `Expected function not to throw but it did`,
      );
    },

    toHaveSucceeded(): void {
      const result = value as { conclusion: string };
      assert(
        result.conclusion === 'success',
        `Expected action to succeed but conclusion was '${result.conclusion}'`,
        `Expected action not to succeed`,
      );
    },

    toHaveFailed(): void {
      const result = value as { conclusion: string };
      assert(
        result.conclusion === 'failure',
        `Expected action to fail but conclusion was '${result.conclusion}'`,
        `Expected action not to fail`,
      );
    },

    toHaveOutput(key: string, expected?: string): void {
      const result = value as { outputs: Record<string, string> };
      if (expected === undefined) {
        assert(
          key in result.outputs,
          `Expected output '${key}' to be present; outputs were: ${JSON.stringify(result.outputs)}`,
          `Expected output '${key}' not to be present`,
        );
      } else {
        const actual = result.outputs[key];
        assert(
          actual === expected,
          `Expected output '${key}' to equal '${expected}' but got '${actual ?? '(missing)'}'`,
          `Expected output '${key}' not to equal '${expected}'`,
        );
      }
    },

    toHaveBeenCalledWith(expected: Record<string, string>): void {
      const mock = value as { calls: Array<{ with: Record<string, string> }> };
      const found = mock.calls.some(
        (call) => JSON.stringify(call.with) === JSON.stringify(expected),
      );
      const callStrings = mock.calls.map((c) => JSON.stringify(c.with)).join(', ');
      assert(
        found,
        `Expected mock to have been called with ${JSON.stringify(expected)}; actual calls: [${callStrings}]`,
        `Expected mock not to have been called with ${JSON.stringify(expected)}`,
      );
    },
  };
}

export function expect(value: unknown): Matcher {
  return createMatcher(value, false);
}
