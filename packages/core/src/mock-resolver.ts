// MockRegistry — stateless policy resolver.
// Explicit mock lookup is now delegated to the scope chain (mock-scope.ts).
// Policy: local ./ → real by default; remote → noop + warning by default.

import type { ActharnessOptions } from '@actharness/types';
import { MissingMockError, ConfigError, CycleError, MaxDepthError } from './errors.js';
import { lookupMock } from './mock-scope.js';
import type { ActionMockHandle } from './mock-scope.js';

// ── MockResolution ────────────────────────────────────────────────────────────

export type MockResolution =
  | { kind: 'mock'; handle: ActionMockHandle }
  | { kind: 'real' }
  | { kind: 'noop'; warning: string };

// ── MockRegistry ──────────────────────────────────────────────────────────────

export class MockRegistry {
  /** Resolve a uses: ref given the configured policy. */
  resolve(
    ref: string,
    actionDir: string,
    options: ActharnessOptions,
  ): MockResolution {
    // Explicit mock from the current scope chain always wins
    const handle = lookupMock(ref);
    if (handle) return { kind: 'mock', handle };

    const isLocal = ref.startsWith('./') || ref.startsWith('../');
    const unmocked = options.unmockedUses;

    let localPolicy: 'error' | 'noop' | 'real';
    let remotePolicy: 'error' | 'noop' | 'real';

    if (typeof unmocked === 'string') {
      localPolicy = unmocked;
      remotePolicy = unmocked;
    } else if (unmocked && typeof unmocked === 'object') {
      localPolicy = unmocked.local ?? 'real';
      remotePolicy = unmocked.remote ?? 'noop';
    } else {
      localPolicy = 'real';
      remotePolicy = 'noop';
    }

    const policy = isLocal ? localPolicy : remotePolicy;

    if (policy === 'real') {
      if (!isLocal) throw new ConfigError(`unmockedUses: 'real' is not supported for remote refs ('${ref}'). Set unmockedUses to 'noop' or 'error', or add an explicit mock.`);
      return { kind: 'real' };
    }

    if (policy === 'error') throw new MissingMockError(ref);

    const warning = isLocal
      ? `Local action not mocked and real execution is disabled: ${ref}. Add actharness.mock('${ref}', ...).`
      : `Remote action "${ref}" is not mocked — returning no-op. Add actharness.mock('${ref}', ...) to test its effect.`;

    return { kind: 'noop', warning };
  }
}

// ── Recursion guard ───────────────────────────────────────────────────────────

export const DEFAULT_MAX_DEPTH = 50;

export function checkCycle(path: string[], ref: string): void {
  if (path.includes(ref)) throw new CycleError([...path, ref]);
}

export function checkMaxDepth(depth: number, max: number = DEFAULT_MAX_DEPTH): void {
  if (depth > max) throw new MaxDepthError(max);
}
