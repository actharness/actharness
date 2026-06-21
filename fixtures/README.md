# Fixtures

Worked examples of `actharness` testing real `action.yml`s — not a conformance suite. Each fixture is a small, focused action paired with a `.test.ts` showing the intended author experience: how to call `actharness()`, register mocks, and assert with the matchers. New fixtures get added as new capabilities ship; this isn't a fixed v0.1-only set.

Most fixtures live directly under `fixtures/` and run as part of the `fixtures` pnpm workspace package (no real npm dependencies needed). A few — `node-api/`, `node-greet/`, `checkout-workspace/` — are their own standalone npm-managed projects (real `package.json`/`node_modules`, run directly via the CLI) because they need real npm dependencies (`@actions/core`, `@actions/github`, `axios`) or a real `npm ci` to be faithful.

| Fixture | Exercises |
| --- | --- |
| `greet/` | The **walking skeleton** — parse, input default + `INPUT_*`, `${{ inputs.* }}` and `${{ steps.*.outputs.* }}`, `ShellSandbox` + real `$GITHUB_OUTPUT`, composite output resolution, a matcher. Start here. |
| `release/` | A mocked `uses: actions/checkout@v4` (assert `with:`), an `if:` skip (`dry-run`), and `$GITHUB_ENV` threading between steps. |
| `checkout-workspace/` | `options.workspace` seeding gated on a `uses: actions/checkout@*` step: no file access before checkout, real `npm ci` after, and a local node sub-action reading a seeded file via `GITHUB_WORKSPACE`. Standalone npm project. |
| `conditions/` | Matrix context, `jobStatus`, and the `success()`/`failure()`/`cancelled()` status functions in `if:` expressions. |
| `context/` | GitHub context and event payload field injection. |
| `diagnostics/` | Failures, annotations, step outputs, `continue-on-error`, and mock call counts. |
| `env/` | Env seeding, step-level env overrides, `working-directory`, and `$GITHUB_PATH`. |
| `annotations-extended/` | `::notice::`, `::debug::`, `::add-mask::`, and annotation `RegExp` matching. |
| `global-mocks/` | Scope-chain mock resolution across the global mock registry. |
| `mock-dynamic/` | Dynamic mock implementations, re-stubbing, `unmock`, and `resetMocks`. |
| `secrets/` | Passing secrets to an action via `RunInput.secrets`. |
| `node-api/` | Node action fixture — Octokit API call via `mockGitHubApi`, plus `fetch`/`axios` network mocking with `mockNetwork`. Standalone npm project. |
| `node-greet/` | Node action fixture — basic input/output, `process.exit` trap. Standalone npm project. |

The `.test.ts` files are the documentation — read them alongside [docs/API.md](../docs/API.md) for the full matcher/mock surface.

`coverage/` here is a generated report directory (from running `actharness test --coverage`), not a fixture.
