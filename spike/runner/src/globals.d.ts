// Global type declarations injected into every test file by --import register.ts
// In the real @actspec/matchers package this ships as globals.d.ts; users add
// "types": ["@actspec/matchers/globals"] to their tsconfig.json once.

interface StubRunResult {
  conclusion: 'success' | 'failure';
  outputs: Record<string, string>;
  steps: Array<{
    id: string;
    name: string;
    ran: boolean;
    outcome: 'success' | 'failure' | 'skipped';
    conclusion: 'success' | 'failure' | 'skipped';
    phase: 'pre' | 'main' | 'post';
  }>;
  env: Record<string, string>;
  annotations: Array<{ level: string; message: string }>;
  stdout: string;
  stderr: string;
  step(id: string): StubRunResult['steps'][number] | undefined;
}

interface StubActionMock {
  calls: Array<{
    with: Record<string, string>;
    env: Record<string, string>;
    outputs: Record<string, string>;
  }>;
  called: boolean;
  callCount: number;
}

interface StubAction {
  mock(ref: string, def?: unknown): StubActionMock;
  run(input?: {
    inputs?: Record<string, string | number | boolean>;
    github?: Record<string, unknown>;
    env?: Record<string, string>;
  }): Promise<StubRunResult>;
}

interface ActspecMatcher {
  readonly not: ActspecMatcher;
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

declare function describe(name: string, fn: () => void): void;
declare function it(name: string, fn: () => void | Promise<void>): void;
declare function test(name: string, fn: () => void | Promise<void>): void;
declare function before(fn: () => void | Promise<void>): void;
declare function after(fn: () => void | Promise<void>): void;
declare function beforeEach(fn: () => void | Promise<void>): void;
declare function afterEach(fn: () => void | Promise<void>): void;
declare function beforeAll(fn: () => void | Promise<void>): void;
declare function afterAll(fn: () => void | Promise<void>): void;
declare function actspec(source: string): StubAction;
declare function expect(value: unknown): ActspecMatcher;
