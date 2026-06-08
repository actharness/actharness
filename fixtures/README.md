# Acceptance fixtures

Canonical `action.yml`s + reference tests for v0.1's acceptance scenarios ([specs/versions/v0.1.md](../specs/versions/v0.1.md)). Committed so the **first integration gate is unambiguous** — the build copies/imports these into the relevant package test setup (paths in the `.test.ts` files are illustrative).

| Fixture | Exercises |
|---------|-----------|
| `greet/` | The **walking skeleton** — parse, input default + `INPUT_*`, `${{ inputs.* }}` and `${{ steps.*.outputs.* }}`, `ShellSandbox` + real `$GITHUB_OUTPUT`, composite output resolution, a matcher. Pass this first. |
| `release/` | A mocked `uses: actions/checkout@v4` (assert `with:`), an `if:` skip (`dry-run`), and `$GITHUB_ENV` threading between steps. |

The `.test.ts` files show the intended author experience; they reference `actspec` + the matchers, which the build provides. More fixtures (failing step / `continue-on-error`, local `uses: ./`, determinism snapshot) are described in v0.1.md and added during the build.
