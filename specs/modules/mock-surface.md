# Mock surface — unified scoping model

Defines the behavioral contract for **all mock types** in actharness: action mocks, network mocks, and (v0.4) workflow mocks. All mock types follow the same scoping model, inspired by Jest/Vitest's `mockReturnValue` / `mockReturnValueOnce` pattern.

---

## Problem with the current state

Two mock types exist today with different scoping behavior:

| Type | Scope | Consumed on use? | How to clear |
|------|-------|-----------------|--------------|
| Action mocks (`actharness.mock(...)`) | Module-level (shared across all handles in the file) | No | `actharness.resetMocks()` |
| Network mocks (`mockNetwork(...)`, `mockGitHubApi(...)`) | Module-level | No — `drainForProxy/Node` snapshots via `.slice()` without clearing | `actharness.resetMocks()` (or `resetNetworkMocks()`) |

Neither type has a one-shot variant. Both leak between tests unless `resetMocks()` is called in `afterEach`. There is no way to register a mock that applies only once.

---

## Unified model

Every mock type has two registration variants:

- **`mock*(...)` — persistent**: applies every time the target is matched, until `resetMocks()` is called.
- **`mockOnce*(...)` — one-shot**: consumed the first time the target is matched. After consumption the registration is removed.

### Resolution order (per target, per invocation)

1. Drain the **`once` queue** for this target FIFO — if a `mockOnce` entry matches, consume it and use it.
2. If the `once` queue is empty, check for a **persistent `mock`** entry — if found, use it (not consumed).
3. If nothing matches — **no-mock behavior**: same as if no mock had been registered at all (follows `unmockedUses` for action mocks; lets the call through or errors as today for network/job mocks).

Multiple `mockOnce` calls for the same target stack as a FIFO queue:

```ts
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'first' } })
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'second' } })
actharness.mock('actions/checkout@v4',     { outputs: { ref: 'fallback' } })
// call 1 → 'first'  (consumed)
// call 2 → 'second' (consumed)
// call 3+ → 'fallback' (persistent, never consumed)
```

---

## Full API surface

### v0.1 — action mocks

```ts
// persistent
actharness.mock(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock

// one-shot
actharness.mockOnce(ref: string, def?: ActionMockDef | ActionMockImpl): ActionMock
```

`ref` is the `uses:` value (`'actions/checkout@v4'`, `'./.github/actions/setup'`, etc.).

### v0.2 — network mocks

```ts
// persistent
actharness.mockGitHubApi(routes: GitHubApiRoutes): NetworkMock
actharness.mockNetwork(matcher: NetworkMatcher, status: number, response: unknown, headers?: Record<string, string>): NetworkMock

// one-shot
actharness.mockGitHubApiOnce(routes: GitHubApiRoutes): NetworkMock
actharness.mockNetworkOnce(matcher: NetworkMatcher, status: number, response: unknown, headers?: Record<string, string>): NetworkMock
```

### v0.4 — workflow mocks

```ts
// persistent
actharness.mockJob(id: string, def?: JobMockDef | JobMockImpl): JobMock
actharness.mockReusable(ref: string, def?: JobMockDef | JobMockImpl): JobMock
actharness.mockService(name: string, def?: ServiceMockDef): ServiceMock

// one-shot
actharness.mockJobOnce(id: string, def?: JobMockDef | JobMockImpl): JobMock
actharness.mockReusableOnce(ref: string, def?: JobMockDef | JobMockImpl): JobMock
actharness.mockServiceOnce(name: string, def?: ServiceMockDef): ServiceMock
```

### Reset

```ts
actharness.resetMocks(): void
```

Clears **everything**: all persistent registrations and all unconsumed `once` queue entries, for all mock types. Also clears `.calls` on all returned handles. Equivalent to Jest's `resetAllMocks()`.

---

## Scoping — where to register

The mock system itself has no built-in scope detection. Scoping is controlled by **where in the test file the registration call appears** — exactly as Jest/Vitest spies work:

```ts
// file top — applies to every test in this file (persistent mock)
actharness.mock('actions/checkout@v4', { outputs: { ref: 'main' } })

describe('group', () => {
  beforeEach(() => {
    // re-registered before each test — effectively per-test
    actharness.mockNetworkOnce('https://api.example.com/data', 200, groupData)
  })

  afterEach(() => {
    actharness.resetMocks()
  })

  test('specific override', async () => {
    // innermost — the mockOnce queue drains first
    actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'feature' } })
    const result = await actharness('./action.yml').run()
    // checkout → 'feature' (once consumed); next call in same test → 'main' (persistent)
  })
})
```

`resetMocks()` in `afterEach` is the recommended pattern. There is no config-level `clearMocks: true` equivalent at this time — explicit cleanup is required.

---

## Network mock drain behavior change

**Today**: `drainForProxy()` and `drainForNode()` snapshot the registry via `.slice()` — mocks are never consumed, never removed.

**After this change**: the drain functions must **consume** `once` entries (remove them from the queue on match) and **retain** persistent entries (leave them in place for the next `run()`).

Concretely: when a network request matches a mock during a `run()`:
- If the matched entry was registered via `mockNetworkOnce` / `mockGitHubApiOnce` → remove it from the registry after serving the response.
- If the matched entry was registered via `mockNetwork` / `mockGitHubApi` → leave it in the registry.

---

## What does not change

- Return types: `mock()` and `mockOnce()` return the same `ActionMock` / `NetworkMock` / `JobMock` handle type. No new handle types.
- Match semantics: same matcher logic for each mock type (exact ref for action mocks, URL/RegExp/fn for network mocks, job id for job mocks).
- Call recording: `.calls` still accumulates across all invocations (both `once` and persistent hits) on the same handle, until `resetMocks()`.
- `unmockedUses` option: unchanged. Still controls what happens for action mocks that have no match.

---

## Acceptance

### A — mockOnce consumed, then persistent fallback

```ts
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'first' } })
actharness.mock('actions/checkout@v4',     { outputs: { ref: 'fallback' } })

const r1 = await actharness('./multi-step.yml').run()  // checkout called twice
// first call  → 'first'    (once consumed)
// second call → 'fallback' (persistent)
```

### B — mockNetworkOnce consumed, second run uses persistent

```ts
actharness.mockNetworkOnce('https://api.example.com/data', 200, { n: 1 })
actharness.mockNetwork(    'https://api.example.com/data', 200, { n: 0 })

const r1 = await actharness('./action.yml').run()
// request → { n: 1 }  (once consumed)

const r2 = await actharness('./action.yml').run()
// request → { n: 0 }  (persistent)
```

### C — once queue is FIFO

```ts
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'a' } })
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'b' } })

// call 1 → 'a', call 2 → 'b', call 3 → no-mock behavior
```

### D — resetMocks clears once queue

```ts
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'x' } })
actharness.resetMocks()

// no registration left — no-mock behavior applies
```

### E — persistent mock unaffected by consumption of once entries

```ts
actharness.mock('actions/checkout@v4', { outputs: { ref: 'stable' } })
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'once' } })

// call 1 → 'once' (consumed)
// call 2 → 'stable' (persistent, intact)
// call 3 → 'stable'
```
