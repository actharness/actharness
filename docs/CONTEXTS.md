# actspec — Contexts & event payloads

Pins the **shape and default values** of the contexts `@actspec/fixtures` provides and `@actspec/core` fills when a `run()` omits them. This is the contract `${{ github.* }}` / `${{ runner.* }}` resolve against. Under frozen [determinism](API.md), the starred defaults are **stable** (so snapshots don't churn).

## `github` context
Reference: GitHub Actions context docs + the runner's context population. Defaults below; every field is overridable via `RunInput.github`.

| Field | Default | Field | Default |
|-------|---------|-------|---------|
| `repository` | `'owner/repo'` (fixed synthetic, deterministic; overridable — [D35](DECISIONS.md#d35--githubrepository-uses-a-fixed-synthetic-default)) | `server_url` | `https://github.com` |
| `repository_owner` | `'owner'` | `api_url` | `https://api.github.com` |
| `repository_id` | `'1'` | `graphql_url` | `https://api.github.com/graphql` |
| `actor` | `octocat` | `ref` | `refs/heads/main` |
| `actor_id` | `'1'` | `ref_name` | `main` |
| `triggering_actor` | `octocat` | `ref_type` | `branch` |
| `event_name` | `push` | `ref_protected` | `false` |
| `event` | `{}` (the payload — see below) | `base_ref` / `head_ref` | `''` (set by PR events) |
| `sha` | `'0'.repeat(40)` ⭐ | `workflow` | `CI` |
| `run_id` | `'1'` ⭐ | `workflow_ref` | `'owner/repo/.github/workflows/ci.yml@refs/heads/main'` (follows `repository` default) |
| `run_number` | `'1'` | `job` | `test` |
| `run_attempt` | `'1'` | `token` | `ghs_` + masked stub (auto-masked) |
| `workspace` | the temp workspace ⭐ | `retention_days` | `'90'` |
| `action` | the running action's id | `path` / `env` | the `GITHUB_PATH`/`GITHUB_ENV` temp files |

`github.event` is the event payload; `github.event_path` points at a temp `event.json` actspec writes (so actions that read the file work).

## `runner` context
| Field | Default |
|-------|---------|
| `os` | `Linux` — a fixture (CI's common OS), deterministic, overridable ([D34](DECISIONS.md#d34--runneros-default-is-linux-overridable)) |
| `arch` | `X64` |
| `name` | `actspec` |
| `temp` | a stable temp dir ⭐ |
| `tool_cache` | `/opt/hostedtoolcache` |
| `environment` | `github-hosted` |
| `debug` | `''` (`'1'` enables `::debug::`) |

## Other contexts (sourced, not defaulted here)
`env` · `vars` · `secrets` · `inputs` · `matrix` — from `RunInput`. `job` (`{ status }`), `steps` (`steps.<id>.{outputs, outcome, conclusion}`), `needs`, `strategy` — produced by execution. `runner.os` drives the default shell ([Fidelity](ARCHITECTURE.md#fidelity--semantics)).

## Event payloads
v0.1 ships factories for **`push`**, **`pull_request`**, **`workflow_dispatch`** ([fixtures spec](../specs/modules/fixtures.md)). They must mirror the **real GitHub webhook shape** closely enough that `github.event.*` dereferences resolve as on a runner. Key fields actspec guarantees:

- **push** — `ref`, `before`, `after`, `repository{...}`, `pusher{name,email}`, `commits[]{ id, message, author{...}, added/modified/removed }`, `head_commit`.
- **pull_request** — `action` (`opened`/`synchronize`/…), `number`, `pull_request{ number, title, state, draft, head{ ref, sha, repo }, base{ ref, sha, repo }, user{...}, labels[]{ name }, merged }`, `repository{...}`.
- **workflow_dispatch** — `inputs{...}`, `ref`, `repository{...}`, `sender{...}`.

> **Full fidelity:** the *complete* webhook schemas are large and authoritative elsewhere — the build SHOULD type these from **[`@octokit/webhooks-types`](https://www.npmjs.com/package/@octokit/webhooks-types)** (or vendor the relevant subset) rather than re-transcribe. This doc pins the *contract*: which fields actspec's factories fill by default; the package supplies the exhaustive shape. Additional `on:` events are added with v0.4 trigger work.

## Build note
`@actspec/types` is the single source of these defaults — both `@actspec/core` and `@actspec/fixtures` import `GITHUB_DEFAULTS`/`RUNNER_DEFAULTS` from it; neither defines its own. Tests assert that an omitted `github`/`runner` yields exactly these values.
