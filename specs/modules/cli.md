# `@actspec/cli`

Two commands: `actspec test` — the purpose-built test runner for GitHub Actions; `actspec run` — execute one action outside a test for local iteration.

## Owns (public surface)
The CLI ([API.md §14](../../docs/API.md)):
- `actspec test [pattern] [--coverage] [--reporter name] [--threshold k=n]…`
- `actspec run <action.yml> [--input k=v]… [--mock ref='json'] [--mock-file f] [--setup f.ts] [--event name] [--json]`
- `actspec init <action.yml>` — scaffold `action.test.ts`.
- `actspec types …` is **deferred** (depends on `@actspec/types`, post-v0.1) — reserve the subcommand.

## Depends on
`@actspec/core` + `@actspec/composite` (v0.1) + `@actspec/matchers` + `@actspec/coverage`.

---

## `actspec test`

The primary way to test actions. A purpose-built runner on top of Node's built-in `node:test` — no Jest or Vitest dependency.

### What it provides in every test file (globals)

`actspec test` injects these into `globalThis` before running each test file, so test files need zero imports:

```ts
describe, it, test, before, after, beforeEach, afterEach  // from node:test
actspec                                                    // from @actspec/core
expect                                                     // from @actspec/matchers
```

TypeScript types for all globals are declared in `@actspec/matchers/globals.d.ts`. Users add `"types": ["@actspec/matchers/globals"]` to their `tsconfig.json` once.

### Test file format

```ts
describe('greet action', () => {
  it('succeeds with valid inputs', async () => {
    const result = await actspec('./action.yml').run({ inputs: { name: 'World' } });
    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('greeting', 'Hello World');
  });

  it('mocks a dependency', async () => {
    const action = actspec('./action.yml');
    action.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });
    const result = await action.run({});
    expect(result).toHaveSucceeded();
  });
});
```

No `import` statements. No `jest.mock`. No `vi.mock`. `action.mock()` is the only mock concept.

### Coverage (`--coverage`)

`actspec test --coverage` runs the suite and emits an Istanbul coverage report. Coverage is built into the CLI — no `setupFiles`, no `globalTeardown`, no runner-level config needed. The CLI manages the full lifecycle: per-file fragment collection, parallel-safe merge, reporter emission, threshold enforcement.

Options (also settable in `actspec.config.ts`):
- `--reporter text|html|lcov|json|cobertura` (default: `text,html`)
- `--coverage-dir <path>` (default: `./coverage`)
- `--threshold ifBranches=80` (fail if below; multiple allowed)

### File discovery

Default pattern: `**/*.actspec.ts` and `**/*.test.ts` (excludes `node_modules`). Override: `actspec test 'src/**/*.actspec.ts'`.

### Parallelism

Each test file runs in its own worker (via `node:test`'s built-in parallel mode). Coverage fragments are collected per-worker and merged after all workers complete — the same disk-first pattern proven in the coverage spike.

---

## `actspec run`

Execute one action outside a test, over the **same runtime** so behavior matches the in-test path exactly. Runs and prints; it does **not** assert.

### Behavior (MUST)
- **No second mock DSL** — `--mock`/`--mock-file` are conveniences; `--setup ./mocks.ts` loads a module that calls the *same* `mock()`/`mockGitHubApi()` API (so a test and the CLI share one `setup(action)`). See [API.md §14 mocking model](../../docs/API.md).
- `--mock-file` is declarative YAML (`uses:`/`github-api:`/`shell:` blocks); `--setup` is code.
- Flags map 1:1 to `ActspecOptions`; what the CLI does, a test does.
- Output: human summary by default; `--json` prints the `RunResult` (serialized, secrets masked).
- Exit code: non-zero iff the action's `conclusion` is `failure`.
- **Deferred (post-v0.1):** `--record`/replay — reserve the flag, error politely if used.

---

## `actspec init`

Scaffolds `action.test.ts` for the given `action.yml`. The generated file is a runnable starting point using actspec's globals — no imports, no boilerplate.

---

## Acceptance
- `actspec test fixtures/greet/greet.test.ts` discovers and runs the file; pass/fail output shows step-level results.
- `actspec test --coverage` emits `coverage/index.html` and `coverage/coverage-final.json`; threshold flag fails the suite if unmet.
- `actspec run fixtures/greet/action.yml --input name=World --json` prints `outputs.greeting == "Hello World"` and exits 0 — **identical result to the in-test walking skeleton**.
- `--mock actions/checkout@v4='{"outputs":{"ref":"abc"}}'` and the equivalent `--mock-file` produce the same run.
- `actspec init` writes a runnable `action.test.ts` with no imports.

## Done-when
`test` (discovery + globals + parallel + coverage) + `run` + `init` work over the shared runtime; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
