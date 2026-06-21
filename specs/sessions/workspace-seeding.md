# Workspace seeding (`workspace` repurposed + new `tempDir`) — handoff spec

**Status: IMPLEMENTED.** Built as checkout-gated seeding (see "Open fork" section below — resolved in favor of option (b)), with one related fix scoped out to its own spec (`specs/sessions/node-sandbox-cwd-fidelity.md`, since implemented — node actions now get `cwd` set to the workspace via `child_process.fork`). Summary of what shipped:

- `ActharnessOptions.workspace` (seed-source path) and `tempDir` (parent dir) per the design below.
- `ExecutionCall` gained an `options: ActharnessOptions` field (`packages/core/src/executor-registry.ts`) so it threads from `action-runner.ts` → `composite-executor.ts` → `step-runner.ts`.
- The actual copy happens in `execUsesStep` (`packages/core/src/step-runner.ts`), gated on the `uses:` ref matching `actions/checkout(@.*)?`, firing regardless of whether that step resolves as mock/noop/real. A bad `options.workspace` path throws `ConfigError`, which the existing per-step try/catch in the step loop turns into a failed step (not a rejected `run()`) — consistent with how every other step error is already handled.
- Tests: `packages/core/test/step-runner.test.ts` ("checkout-gated workspace seeding" describe block) covers the gating, error cases, and seed-source immutability. `packages/core/test/action-runner.test.ts` keeps only a resolution-only test (the behavioral tests moved, since that file's fake-executor harness has no step loop to exercise gating).
- End-to-end integration fixture: `fixtures/checkout-workspace/` — a composite action with `[before-checkout shell check] → [actions/checkout@v4] → [npm ci] → [shell file read] → [local node sub-action file read via GITHUB_WORKSPACE]`, run via the real CLI. Confirms all three originally-requested scenarios (npm ci after checkout, shell+JS file access, no access before checkout) end-to-end with real `npm ci` and a real local node action.
- Found and fixed along the way: `composite-executor.ts` was hardcoding `actharnessOptions: {}` instead of forwarding the real options — meaning `options.shell.default` (and now `options.workspace`) silently never reached the step loop for composite actions. Fixed as part of threading `options` through, since it was required to make this feature work at all.
- Found and explicitly deferred (not implemented, separate spec written): node actions have no `cwd` set to the workspace at all, and `process.chdir()` is impossible inside `worker_threads` (verified directly, not assumed) — see `specs/sessions/node-sandbox-cwd-fidelity.md`. The `fixtures/checkout-workspace` node sub-action works around this today via `process.env.GITHUB_WORKSPACE` rather than a bare relative path.

Original proposal preserved below for context.

This is the **second, corrected revision** of this spec. An earlier draft proposed *extending* `ActharnessOptions.workspace` to `'temp' | string | { from: string }`. That draft is superseded — see "Why the first draft was wrong" below before reading further, so the next session doesn't reintroduce the same mistake.

## How we got here

The user asked: what happens when an action under test needs files that would normally come from `actions/checkout` — e.g. a `run: npm ci` step, or a node/shell script that reads a file expected to exist in the repo?

Investigation (grounded in the actual code, not guesses) found:

1. **The workspace is always empty.** `runAction()` in `packages/core/src/action-runner.ts:114-118` creates a fresh `mkdtempSync` directory per run:
   ```ts
   const workspaceBase = options.workspace === 'temp' || !options.workspace
     ? tmpdir()
     : options.workspace;
   const workspace = mkdtempSync(join(workspaceBase, 'actharness-ws-'));
   mkdirSync(workspace, { recursive: true });
   ```
   Nothing copies files into it. `options.workspace` as a custom string only changes *where* the temp dir is created (its parent), not its contents — `mkdtemp` always produces an empty, uniquely-named directory.

2. **`actions/checkout@v4` is not specially handled.** Remote `uses:` refs default to mock policy `'noop'` (`packages/core/src/mock-resolver.ts`) — checkout just warns and does nothing. No checkout executor/mock exists anywhere in source; the only "checkout" reference in the whole test suite is a test that registers a mock but never exercises it (`packages/composite/test/integration.test.ts:120-132`).

3. **`run:` shell steps execute with `cwd` inside that same empty workspace** (`packages/composite/src/shell-sandbox.ts`), so e.g. `npm ci` would run against a directory with no `package.json` — it would just fail.

4. **A mock callback cannot see the workspace path today.** `ActionMockImpl` (`packages/types/src/index.ts:264-267`) is typed `(call: { with, env }) => ...` — no `context`/`workspace` field exists in the type or at the call site (`packages/core/src/step-runner.ts:156-160` only forwards `{ with: withInputs, env: callEnv }`). So "write a `mockCheckout()` helper that copies files when the checkout step runs" would require a core change to thread the workspace path into the mock call — more invasive than the alternative below.

### Design decisions made, in order

1. **Mechanism: extend the `workspace` option, not a checkout-specific mock.** Two approaches were discussed — (A) a `mockCheckout()` helper tied to the `actions/checkout` step (more "realistic," but only fires if the action has that step, and needs the core change in point 4 above), vs (B) a general workspace-seeding option that applies to every run regardless of whether checkout is mocked. **User picked (B).**

2. **Always copy, never in-place.** "Point at the real repo root" was considered as either copying its contents into the disposable temp dir, or using that real directory in-place with no copy. In-place was rejected: `runAction()` unconditionally `rmSync`s the workspace after every run unless `keepWorkspace` is set (`action-runner.ts:172-174`) — in-place would delete the user's real files after every test run. **User picked: always copy.** This means the existing cleanup logic needs zero changes — what gets deleted is still always a throwaway copy, regardless of whether the seed source was a fixture dir or a real repo.

3. **One seed-source field, not two.** An early sketch proposed separate `root` (copy a real repo as a base layer) and `seed` (copy a fixture dir on top, to override a few files) fields, to support "real repo + a couple of test-specific overrides." **User rejected this — one field only, no layering.** If that combo is ever needed, the caller can build it themselves outside this feature (e.g. pre-copy a fixture dir into a real-repo checkout before calling `actharness()`).

### Why the first draft of this spec was wrong, and the correction

The first draft proposed widening the *existing* `workspace` option:
```ts
// WRONG — superseded
workspace?: 'temp' | string | { from: string };
```
The bug: today's `workspace` already does a job — `'temp'` or a custom string controls **where the disposable temp dir is created** (its parent directory; see `action-runner.ts:114-117`). The `{ from: string }` object form had no slot for that parent-dir string at all, so the proposed type union silently meant "pick one capability or the other" — anyone using `workspace: '/custom/parent'` today would have no way to *also* get seeding. That's a real loss of expressiveness, not just a naming nit. The user caught this directly: *"if you introduce `{ from: string }`, it will break it — only temp will be allowed, not a parent anymore."*

**The fix, after going back and forth on naming:** since nothing in the codebase consumes the seeding behavior yet and this library has no real users (confirmed with the user — no backward-compatibility cost to weigh), the cleanest fix is to **repurpose `workspace` itself** for the new seed-source meaning, and **introduce a new field for the old parent-dir meaning** rather than nesting both inside one option. Naming went through a few iterations:
- `workspaceDir` was rejected for the parent-dir field — *"it collides with `workspace`... and makes a clear confusion"* (visually/conceptually too close to the field whose meaning just changed).
- Settled on **`tempDir`** — describes exactly what it is, zero overlap with `workspace`'s new meaning, and the name itself already implies "temp," so the awkward `'temp'` string literal (needed today because `workspace` doesn't inherently imply temp-ness) can be dropped: `tempDir?: string`, where omitting it defaults to `os.tmpdir()`.

## Final proposed design

### API shape

```ts
interface ActharnessOptions {
  // ... existing fields unchanged (unmockedUses, shell, keepWorkspace, determinism, diagnostics, isolation, defaults, container) ...

  /** Path to a directory to copy into the run's temp workspace before the action executes.
   *  Always a copy, never in-place — safe regardless of whether this points at a fixture dir
   *  or a real project root. Relative paths resolve against the calling test file's directory
   *  (same convention as the `source` argument to `actharness()`). Omit for the default: an
   *  empty workspace (today's behavior, unchanged). */
  workspace?: string | undefined;

  /** Parent directory under which the disposable temp workspace dir is created.
   *  Default: os.tmpdir(). This is unrelated to `workspace` above — it controls *where* the
   *  temp dir lives on disk, not what's copied into it. (This is the OLD `workspace` option,
   *  renamed — see specs/sessions/workspace-seeding.md for why.) */
  tempDir?: string | undefined;
}
```

**Naming clarification to document prominently, since the same English word is used for two related-but-distinct things in this codebase:** `options.workspace` (this new field — a static input path you provide) is NOT the same thing as `github.workspace` / `$GITHUB_WORKSPACE` (the resolved runtime path the action sees during execution, set via `store.github.workspace = workspace` at `action-runner.ts:145`, see `packages/core/src/context.ts`). `options.workspace` is *content that gets copied into* whatever directory becomes `github.workspace` at runtime. Call this out explicitly in `docs/API.md` next to both fields so the distinction isn't just tribal knowledge.

### Path resolution

Relative `options.workspace` (seed source) paths should resolve the same way `actharness(source)` already resolves a relative `source` argument: relative to the **calling test file's directory**, not `process.cwd()`. The existing mechanism is `_dirFromStack(new Error().stack!)` in `packages/core/src/action-runner.ts:211-218`, called inside the public `actharness()` function (`action-runner.ts:226-232`) where the stack is still pointing at the real caller.

Concretely, in `actharness()`:
```ts
export function actharness(source: string, options: ActharnessOptions = {}): Action {
  const callerDir = _dirFromStack(new Error().stack!); // capture once, used for both
  if (source.startsWith('./') || source.startsWith('../')) {
    source = resolve(callerDir, source);
  }
  if (options.workspace && (options.workspace.startsWith('./') || options.workspace.startsWith('../'))) {
    options = { ...options, workspace: resolve(callerDir, options.workspace) };
  }
  const manifest = parseAction(source);
  return new ActionImpl(manifest, options);
}
```
(Sketch only — not yet validated against the real `ActionImpl`/options flow; the implementing session should re-check nothing downstream re-derives or clones `options` in a way that would undo this resolution, and that absolute `workspace` paths pass through untouched. `tempDir` does NOT need this caller-relative resolution treatment — it's a literal filesystem location, not a project-relative fixture reference, so it should behave like today's `workspace` string form: resolved as-is, or relative to `process.cwd()` if relative, matching current behavior exactly.)

### Implementation in `runAction()`

In `packages/core/src/action-runner.ts`, replace lines 114-118:
```ts
// current
const workspaceBase = options.workspace === 'temp' || !options.workspace
  ? tmpdir()
  : options.workspace;
const workspace = mkdtempSync(join(workspaceBase, 'actharness-ws-'));
mkdirSync(workspace, { recursive: true });
```
with:
```ts
// new
const workspaceParent = options.tempDir ?? tmpdir();
const workspace = mkdtempSync(join(workspaceParent, 'actharness-ws-'));
mkdirSync(workspace, { recursive: true });
if (options.workspace) {
  cpSync(options.workspace, workspace, { recursive: true });
}
```
using Node's built-in `fs.cpSync` (available Node 16.7+; this repo's `engines.node` is `>=22`, so no compatibility concern). Import `cpSync` alongside the existing `mkdtempSync, mkdirSync, rmSync` import from `node:fs` at the top of the file.

**Naming caution for the implementer:** the local variable `workspace` at this line (the actual created temp dir path) and the new option `options.workspace` (the seed source path) are now two different things with the same short name in the same function scope. Read `options.workspace` into a clearly-named local (e.g. `const seedFrom = options.workspace;`) before this block to avoid `cpSync(workspace, workspace)`-style mistakes while editing. Don't rename the existing local `workspace` variable itself — it's used consistently elsewhere in the function (e.g. `store.github.workspace = workspace` at line 145, the `rmSync(workspace, ...)` cleanup at line 173) and renaming it would touch more of the function than necessary.

No change needed to the cleanup logic (`action-runner.ts:172-174`) — it still `rmSync`s the temp `workspace` dir (which now happens to contain copied files when `options.workspace` was set) unless `keepWorkspace` is set; the original seed-source directory is never written to or removed.

### Error handling to decide/implement

Not yet decided — flag for the implementing session to confirm with the user:
- `options.workspace` path doesn't exist → presumably should throw a clear `ConfigError` (consistent with how this repo handles other bad-config inputs, e.g. `dispatchAction`'s "No executor registered" error at `action-runner.ts:76-79`), rather than letting `cpSync` throw a raw `ENOENT`.
- `options.workspace` resolves to a file, not a directory → likewise, probably a clear `ConfigError` rather than a raw `cpSync` error.
- `options.tempDir` doesn't exist → this matches *today's* existing behavior for the old `workspace`-as-parent-dir use case (an absent custom parent already throws whatever `mkdtempSync` raises natively) — no behavior change proposed here, just confirm that's still acceptable now that it's a differently-named field.
- Large directories (e.g. seeding an entire real repo including `node_modules`/`.git`) — no special handling proposed; just flag as a known perf cost. Worth documenting "exclude `node_modules`/`.git` from your seed dir for speed" rather than building exclusion-pattern support into v1.

### Explicitly out of scope for this feature

- This does **not** change how `uses: actions/checkout` resolves — it stays governed by the existing `unmockedUses` policy (`mock-resolver.ts`), independently. `options.workspace` just ensures files exist in the workspace regardless of whether checkout is mocked, real, or a no-op — it's a strictly simpler, more general mechanism than simulating checkout.
- No `mockCheckout()` helper, no simulated `sha`/`ref` checkout outputs — that's the rejected option (A) from "Design decisions made." If wanted later, it's additive (doesn't conflict with this feature) but needs the separate core change to thread workspace into mock calls (see point 4 in "How we got here").
- No layered/override seeding (the rejected `root` + `seed` two-field design) — single `workspace` field only, no composition with itself.

## Files to touch (implementation checklist for next session)

1. `packages/types/src/index.ts:377` — change `workspace?: 'temp' | string | undefined;` to `workspace?: string | undefined;` (repurposed meaning), and add a new field `tempDir?: string | undefined;` nearby (taking over the old `workspace` meaning).
2. `packages/core/src/action-runner.ts`:
   - `actharness()` (~line 226) — resolve relative `options.workspace` against the caller dir, same as `source` (see sketch above).
   - `runAction()` (~lines 114-118) — replace with the `tempDir`/`cpSync` version above. Extend the `node:fs` import to include `cpSync`.
   - Decide + implement the `ConfigError` cases above (missing dir, not-a-directory) for `options.workspace`.
3. **`packages/core/test/action-runner.test.ts:181-189`** — the test `'uses custom workspace dir when provided'` currently does:
   ```ts
   const action = actharness(dir, { workspace: wsDir });
   ```
   This **must** become `{ tempDir: wsDir }` to keep testing what its title claims. If missed, this test will silently stop testing the parent-dir behavior (it'll pass — `cpSync` of an empty directory is a harmless no-op — while testing nothing real). Audited during this session; this is the only existing test/code site using the old `workspace` meaning anywhere in the repo (confirmed via full-codebase grep — no CLI flag, no `ActharnessConfig` field, no other test file affected).
4. `docs/API.md:26-47` — update the `workspace?:` doc comment to its new meaning, add the new `tempDir?:` field with its doc comment, and add the `options.workspace` vs `github.workspace` clarification note from "Final proposed design" above.
5. `specs/modules/core.md` — bullet 8 ("Workspace") currently says: *"one shared `GITHUB_WORKSPACE` temp dir per top-level `run()` ... auto-removed unless `keepWorkspace`"*. Add a sentence once built: the workspace may optionally be seeded from a directory via `options.workspace` (copied in before the run, same auto-removal semantics applying to the copy), and its parent location is configurable via `options.tempDir`.
6. `docs/DECISIONS.md:417` — table entry `**run options:** ... workspace `temp` ...` — update to reflect the new field meanings.
7. Tests — new fixture(s) under `packages/core/test/fixtures/` exercising:
   - `workspace: <fixture dir>` with a relative path — a file from that dir is readable from within the run (e.g. assert via a step that the file exists, or via `context.github.workspace` + a direct `fs.readFileSync` in the test after `run()` if `keepWorkspace: true` is also set for inspection).
   - Absolute `workspace` path also works.
   - Missing `workspace` directory throws a clear error (not a raw `ENOENT`).
   - `tempDir` continues to work for its (renamed) original purpose — this is really just the existing test from point 3, moved to the new field name; treat it as a regression guard, not new coverage.
   - `workspace` and `tempDir` used together in the same call — confirm they compose (seed content copied into a temp dir created under the custom parent).
   - Without either option, behavior is byte-for-byte unchanged from today (regression guard — this is the more important test, since this is a widely-used, currently-stable code path).
   - The original seed-source directory is untouched after the run (nothing written back into it, no mutation) — copy-only confirmed both directions.

## Integration fixture tests requested (not yet written)

The user asked for end-to-end fixture tests (in the style of the `fixtures/node-api` work from an earlier session — real `npm install`/`npm ci`, real file access, not just unit-level checks on `runAction()`) covering:

1. **`npm ci` works after the workspace is seeded.** A fixture action with a `run: npm ci` step, seeded via `options.workspace` pointing at a small fixture dir containing a real `package.json` (+ lockfile). Assert the step succeeds and (e.g.) a installed package is actually resolvable in a follow-up step.
2. **A script (shell `run:` and a node action) can read a seeded file.** Two variants: a `run:` step doing something like `cat data.json` (already plausible today, since `ShellSandbox`'s `cwd` is the workspace — `packages/composite/src/shell-sandbox.ts:55`), and a node action reading the same file. **The node action variant surfaces a separate, pre-existing gap — see "Newly-found gap" below — write this test expecting to need `process.env.GITHUB_WORKSPACE`, not a bare relative path, until/unless that gap is fixed.**
3. **Files are NOT accessible before checkout runs.** A fixture with a step *before* a `uses: actions/checkout`-like step that tries to read a repo file and should fail/not find it, then a step *after* checkout that succeeds. **This test cannot be written against the design as currently specified — see "Open fork: eager vs. checkout-gated seeding" below. Resolve that fork first; the test's shape depends on which side is chosen.**

These should live alongside the `fixtures/node-api`-style pattern (a real npm-managed fixture dir, not the lightweight `fixtures/` workspace package) given the dependency on real `npm ci` behavior — see `fixtures/node-api/package.json` for the precedent (it's deliberately outside the pnpm workspace, with its own `package-lock.json`).

## Open fork: eager vs. checkout-gated seeding (found while scoping test #3, needs a decision)

The design as specified above copies `options.workspace` into the temp dir **once, in `runAction()`, before any step of the action runs** (right after `mkdtempSync`). That means a script step placed *before* a `uses: actions/checkout` step in the action under test would **already** see the seeded files — which does not match real GitHub Actions, where the workspace is empty until an actual checkout step populates it. The user explicitly wants test #3 above to assert that pre-checkout steps see no files (or wants confirmation of "another way to access the repo" if eager seeding is intentional/acceptable).

This was *not* surfaced in the original design discussion — it's a real gap in the spec as written so far, not a restatement of something already decided. Two ways to resolve it, **not decided yet, needs the user's call**:

- **(a) Keep eager seeding (current spec), document the limitation.** Simpler, no new plumbing. Workspace content is available from the start of the run, period — there's no notion of "before/after checkout" in this harness, because there's no real checkout execution model (`actions/checkout` is either mocked or no-op'd today, per "How we got here" point 2 — it never actually touches the filesystem). Test #3 as the user described it literally cannot pass under this design; it would need to be written as a documented-limitation test instead ("workspace content is available for the whole run, unconditionally") or dropped.
- **(b) Gate seeding on an actual checkout-like step executing.** This revives the previously-rejected option (A) from "How we got here" (a checkout-aware mechanism), but scoped narrower: instead of a user-authored `mockCheckout()` helper, the **mock-resolver or step-runner itself** could recognize when a `uses:` ref matches a checkout-action pattern (e.g. `actions/checkout@*`, possibly a configurable list) and perform the `options.workspace` copy at that point in the step loop, rather than upfront. This is a materially bigger change — it touches `packages/core/src/step-runner.ts` and/or `packages/core/src/mock-resolver.ts`, not just `action-runner.ts`, and needs its own design pass (e.g.: does it match by ref string pattern? does the user opt in explicitly, e.g. `options.workspace = { from: ..., seedOn: 'actions/checkout@*' }`, defaulting to eager if unset? what if the action under test never has a checkout step at all — does seeding just never happen, even though the user clearly wants the files?).

**This needs to go back to the user before either path is implemented.** Recommend asking: is the eager (a) behavior actually fine for your use case (i.e., do you only care that the files exist *somewhere* during the run, not about faithfully reproducing pre/post-checkout emptiness), or is the ordering fidelity in (b) load-bearing for what you're testing?

## Newly-found gap: node actions don't get `cwd` set to the workspace at all

While scoping test #2, found that **`packages/node/src/js-sandbox.ts` and `packages/node/src/worker-bootstrap.mjs` never set `cwd` or call `process.chdir()` anywhere** (confirmed via grep — zero hits for `cwd`/`chdir` in `packages/node/src/*`). The `Worker` spawned in `js-sandbox.ts:89` inherits the host process's working directory, not the run's `GITHUB_WORKSPACE`. Contrast with `packages/composite/src/shell-sandbox.ts:55`, which explicitly passes `cwd: opts.cwd` (the workspace) when spawning shell `run:` steps.

This is a **pre-existing gap, unrelated to and not introduced by the workspace-seeding feature** — it already affects today's node-action support (`runs: using: node22`) regardless of whether `options.workspace` ever gets implemented. A node action script doing `fs.readFileSync('./somefile.txt')` (relative path) will resolve against wherever the test process itself was launched from, not the seeded/real workspace — it would need `path.join(process.env.GITHUB_WORKSPACE, 'somefile.txt')` instead.

Not clear whether this is intentional (e.g., a deliberate fidelity simplification, since `@actions/core`-based actions are generally written to use `GITHUB_WORKSPACE` explicitly rather than assume cwd) or an actual bug relative to the real GitHub Actions runner's behavior (this session did not verify what the real runner does for `node20`/`node22` actions' starting cwd — that needs checking against real runner docs/behavior, not assumed). **Flag this for the user separately from the workspace-seeding decision** — it may warrant its own small fix (`process.chdir(workspace)` early in `worker-bootstrap.mjs`) regardless of how the eager-vs-gated fork above is resolved, since test #2 depends on knowing which behavior is correct.

## Open question for the user before implementation starts

Per `CLAUDE.md`, confirm before writing code:
1. Should `keepWorkspace: true` + `workspace: <seed dir>` be usable together for debugging (inspect the seeded+run workspace afterward)? Likely yes, no special-casing needed — `keepWorkspace` already just skips the `rmSync`, independent of how the dir was populated — but worth a one-line confirmation.
2. Confirm the missing-directory / not-a-directory error behavior described above is the desired UX (vs. e.g. silently no-op-ing, which this session does *not* recommend — a silent no-op on a typo'd path would be a confusing trap).
3. Sanity-check the renamed test in checklist item 3 reads correctly once changed (`'uses custom workspace dir when provided'` → maybe rename the test title too, e.g. `'uses custom tempDir when provided'`, for clarity).
4. **Resolve the eager-vs-checkout-gated seeding fork above** — this blocks writing integration test #3 and may change the API shape (e.g. adding a `seedOn` field) if (b) is chosen.
5. **Decide whether the node-executor cwd gap is in-scope to fix alongside this feature**, or a separate pre-existing issue to track independently — it blocks writing integration test #2 as a relative-path read; it's still writable today using `process.env.GITHUB_WORKSPACE` regardless of that decision.
