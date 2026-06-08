# `@actspec/fixtures`

Realistic `github`/`runner` context defaults and event-payload factories, so test authors don't hand-roll envelopes. Also the source of the defaults `@actspec/core` applies when a `run()` omits context.

## Owns (public surface)
[API.md §12](../../docs/API.md):
```ts
export const contexts: {
  github(overrides?: DeepPartial<GitHubContext>): GitHubContext;
  runner(overrides?: DeepPartial<RunnerContext>): RunnerContext;
};
export const events: {
  push(o?: DeepPartial<PushEvent>): PushEvent;
  pull_request(o?: DeepPartial<PullRequestEvent>): PullRequestEvent;
  workflow_dispatch(o?: DeepPartial<WorkflowDispatchEvent>): WorkflowDispatchEvent;
};
```
(v0.1 ships these three events; more `on:` events arrive with v0.4 trigger work. Keep the registry open.)

## Depends on
`@actspec/types` only. Pure data + builders; no side effects. Does **not** depend on `@actspec/core`.

## Behavior (MUST)
- **The field schemas + default values are pinned in [docs/CONTEXTS.md](../../docs/CONTEXTS.md)** — match them exactly (this is the contract `${{ github.* }}`/`${{ runner.* }}` resolve against). Type the full webhook payloads from `@octokit/webhooks-types` rather than re-transcribing.
- Each factory returns a **complete, internally-consistent** object (e.g. `github.repository` + `repository_owner` agree; `push` payload's `ref` matches `github.ref` when both are defaulted).
- Overrides are **deep-merged** over defaults (arrays replace, objects merge).
- Defaults are deterministic and sourced from `@actspec/types` (single source of truth — both `core` and `fixtures` import `GITHUB_DEFAULTS`/`RUNNER_DEFAULTS` from `@actspec/types`; neither defines its own).
- Event payloads mirror the **real GitHub webhook shape** for the covered events (enough fidelity that `github.event.*` dereferences in expressions resolve as on a real runner).

## Acceptance
- `contexts.github()` with no args → documented defaults; with `{ repository: 'a/b' }` → owner derived/overridable, rest intact.
- `events.pull_request({ action: 'opened', number: 42 })` → a payload where `github.event.pull_request.number` and `.action` resolve via the expression engine.
- Deep-merge: nested override doesn't drop sibling defaults.
- Core integration: a `run()` with no `github`/`runner` uses these defaults verbatim.

## Done-when
Three event factories + two context factories, real-shape payloads, deep-merge correct, core consumes the same defaults; per [CONVENTIONS DoD](../../docs/CONVENTIONS.md#definition-of-done-every-module).
