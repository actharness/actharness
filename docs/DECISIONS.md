# actspec — Design decisions

The **rationale** behind the choices that aren't obvious from the specs alone — the *why*, the alternatives we rejected, and where each is enforced. The **what-to-do** is mirrored **inline** in the specs/docs (linked per entry), so reading a single spec is enough; this file is the reasoning, not a substitute for it.

> **Build principle: no workarounds in v0.1.** Whatever v0.1 genuinely needs is built fully and properly — never stubbed, faked, or half-validated to save time. Only capabilities whose first real use is v0.2+ may wait. Recorded in [CONVENTIONS → Build philosophy](CONVENTIONS.md#build-philosophy).

Each entry is **D&lt;n&gt;**, with *Decision / Why / Rejected / Enforced in*.

---

## D1 — Coverage observes runs via a global run sink

**Decision.** `@actspec/core` exposes a process-global listener registry — `registerRunListener(fn)`, keyed on `globalThis[Symbol.for('actspec.runSink')]`. `run()` notifies it with the finished `RunResult`. `@actspec/coverage` registers in its setup entry; **core never imports coverage**.

**Why.** Every `RunResult` must reach the `CoverageCollector`, yet core must not depend on coverage (the package DAG) and coverage must stay passive (zero execution impact). A sink keyed by `Symbol.for` survives the dual ESM/CJS boundary and is shared within one worker process — the unit Jest/Vitest parallelize on.

**Rejected.** (a) Core importing coverage — breaks the dependency DAG. (b) An in-memory singleton collector — each test *file* runs in its own worker, so it would only ever see one file's runs. (c) Wiring through the matchers setup — couples two independent packages.

**Implementation note (from coverage spike, updated for actspec test).** The coverage spike proved the disk-first fragment mechanism under both Vitest and Jest. In the final design, `actspec test` (built on `node:test`) owns the full coverage lifecycle: each worker flushes its fragment when its test file completes, and the CLI merges all fragments after all workers exit. No `setupFiles`/`globalTeardown` configuration is required — the runner manages it transparently via `--coverage`. The Jest/Vitest flush-timing heuristics (`globalThis.afterAll` detection, `process.on('beforeExit')` fallback) proved in the spike are not needed in the final implementation; they remain documented in the spike findings for completeness.

**Enforced in.** [core.md](../specs/modules/core.md) behavior 4 · [coverage.md](../specs/modules/coverage.md) behavior 1 · [ARCHITECTURE → Future-proofing invariants](ARCHITECTURE.md#future-proofing-invariants).

## D2 — YAML parser preserves positions

**Decision.** Core parses manifests with `yaml` (eemeli) and keeps `line:col` ranges on every node (steps, `if:`, `with:`, `outputs`), normalizing to a `ParsedAction` carrying `{ value, range }`.

**Why.** Two features need per-node positions: source-mapped errors (`action.yml:line:col` with a caret) and coverage's step→statement / `if:`→branch line ranges. `yaml`'s CST exposes ranges directly.

**Rejected.** `js-yaml` — common and fast, but doesn't surface per-node ranges without hand-rolled position tracking. The position requirement is **binding**; the specific library is the default.

**Enforced in.** [core.md](../specs/modules/core.md) behavior 1 · [CONVENTIONS → tooling](CONVENTIONS.md#build-lint-test-tooling-defaults-swappable).

## D3 — Composite status evolves with step conclusions

**Decision.** Inside a composite, a running status starts `success` and flips to `failure` on the first step whose **conclusion** is `failure` (i.e. *after* `continue-on-error` is applied). `success()` holds only while that status is `success` and the injected `jobStatus` isn't `failure`/`cancelled`; `failure()` once a prior step failed; `always()` always; `cancelled()` from `jobStatus`.

**Why.** The runner's default step guard is `if: success()`, so a real (non-c-o-e) failure must skip later default-`if` steps — otherwise conclusions diverge from GitHub. A `continue-on-error` failure must *not* flip status (the outcome≠conclusion split).

**Rejected.** Treating `jobStatus` as a single fixed input for the whole run — would keep `success()` true after a mid-composite failure and mis-run steps the runner skips.

**Enforced in.** [composite.md](../specs/modules/composite.md) behavior 1 · [ARCHITECTURE → Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics).

## D4 — One workspace per top-level run; env-files per step

**Decision.** One shared `GITHUB_WORKSPACE` temp dir per **top-level** `run()`, reused by nested local `uses: ./child`. Env-files (`GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}`) are fresh **per step**; `$GITHUB_ENV`/`$GITHUB_PATH` accumulate forward, `$GITHUB_OUTPUT` is per-step → `steps.<id>.outputs`.

**Why.** Mirrors the runner: a composite and the local actions it calls share one workspace, but each step gets its own output/env files. Shared workspace makes local-action recursion "just work"; per-step files keep `steps.<id>.outputs` correct.

**Rejected.** A fresh workspace per child action — breaks actions that write a file for a later step to read, and diverges from the runner.

**Enforced in.** [core.md](../specs/modules/core.md) behavior 8 · [ARCHITECTURE → Coverage (isolation invariant)](ARCHITECTURE.md#coverage-cross-cutting-all-versions).

## D5 — Expression gate is the full vendored corpus plus fuzz

**Decision.** v0.0's expression-engine gate is **green on the full vendored vector tables** (the C# runner's + `nektos/act`'s expression test cases, harvested as data) **plus our own parser/eval fuzzer**. A *live* differential run against `nektos/act` is **optional and non-blocking**.

**Why.** The authoritative ground truth already exists as data — act's and the runner's own test tables — so harvesting them in full validates against the best reference (the runner) with zero external runtime. A live act check adds value only on novel generated inputs, needs the external Go binary in CI, and act is a known-imperfect oracle (its object-compare *throws*; we follow the runner). Under *no workarounds*, the full data harvest — not the 149-row seed — is the v0.0 bar.

**Rejected.** (a) A seed-only gate — a workaround that under-validates the foundation. (b) A blocking live-act differential — drags a Go/Docker dependency into CI for an imperfect oracle.

**Enforced in.** [versions/v0.0.md](../specs/versions/v0.0.md) gate · [expressions.md](../specs/modules/expressions.md) acceptance + done-when · [EXPRESSIONS → Conformance corpus](EXPRESSIONS.md#conformance-corpus) · [CONVENTIONS → CI matrix](CONVENTIONS.md#ci-matrix).

## D6 — hashFiles ships its real algorithm in v0.1

**Decision.** Core registers a real `hashFiles`: glob the patterns under `GITHUB_WORKSPACE`; in globber (sorted) order SHA-256 each file's bytes; concatenate the digests and SHA-256 the concatenation → lowercase hex; `''` if nothing matches. Overridable via the `functions` hook; pinned by a fixture. (`G15` number→string likewise gets a dedicated implementation — JS has no native G15.)

**Why.** hashFiles is part of the v0.0 expression surface and cache-key composite steps use it constantly — a placeholder would make those tests meaningless (a workaround). Real-but-overridable keeps determinism available without faking the default.

**Rejected.** A deterministic placeholder by default — a workaround for the most common real use of the function.

**Enforced in.** [EXPRESSIONS → Functions](EXPRESSIONS.md#functions) · [expressions.md](../specs/modules/expressions.md) behavior.

---

## Project, tooling & process

*(These were already asserted in the docs before being explicitly ratified; recorded here with their rationale so they're owned, not inherited.)*

## D7 — Monorepo over polyrepo

**Decision.** One repository; each `@actspec/*` is independently published.

**Why.** The packages share core types (`ExecutionCall`, `RunResult`, `StepResult`) and a single change often spans several (adding `phase` touched core + composite + matchers + coverage) — atomic in a monorepo, a publish-and-bump chain across repos. They are tightly coupled, not team-divergent, so polyrepo's upside doesn't apply.

**Rejected.** Polyrepo — only pays off for loosely-coupled or separately-owned packages; neither holds here.

**Enforced in.** [ARCHITECTURE → Package layout](ARCHITECTURE.md#package-layout-pnpm-monorepo) · [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging).

## D8 — pnpm as the package manager

**Decision.** pnpm workspaces (`workspace:*`), pinned via the `packageManager` field + `corepack`.

**Why.** The decisive axis for a **publish-many** monorepo is **phantom-dependency safety** — a package importing something it never declared works in-repo (a sibling hoisted it) but breaks when installed standalone. Three-way trade-off for this project:

| Dimension (this repo) | pnpm | npm workspaces | yarn berry |
|---|---|---|---|
| Phantom-dep safety (publish correctness) | ✅ strict by default | ❌ weak (flat hoist hides) | ✅✅ PnP / ⚠️ node-modules loose |
| Workspace ergonomics | ✅ excellent | ◑ basic | ✅ excellent |
| Install speed / disk | ✅✅ fastest | ◑ slowest | ✅ fast |
| Toolchain compatibility | ✅ broad | ✅✅ maximum | ⚠️ PnP needs SDK |
| Cross-OS incl. Windows | ✅ fine | ✅✅ fewest surprises | ✅ fine |
| Onboarding | ◑ corepack one-liner | ✅✅ ships with Node | ◑ corepack + SDK |
| Default for TS lib monorepos | ✅ de-facto | ✅ lags | ✅ stronger opinion |

pnpm wins: strict enough to catch publish-breaking phantom deps, fast, best multi-package ergonomics, broadly tool-compatible, with `corepack` neutralizing the onboarding cost.

**Rejected.** **npm workspaces** — defensible only if "zero extra tool" outranks phantom-dep safety, and only with `publint` + a pack-and-import CI backstop. **yarn berry** — PnP's hard isolation taxes tooling (SDK/config); node-modules mode loses the strictness edge, so it rarely wins here.

**Enforced in.** [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging).

## D9 — Dual ESM + CJS output

**Decision.** Every package publishes both ESM and CJS with type declarations.

**Why.** actspec loads inside consumers' Node projects, and a meaningful share still use CommonJS tooling; shipping both lets users `import` *or* `require()` it. The cost — emitting two formats and minding the dual-package hazard — is worth the adoption reach.

**Rejected.** ESM-only — simpler build/exports, but CJS consumers can't `require()` it. CJS-only — legacy, blocks modern ESM consumers.

**Enforced in.** [CONVENTIONS → Language & runtime](CONVENTIONS.md#language--runtime).

## D10 — Node 20+ floor

**Decision.** Source targets Node 20+.

**Why.** Node 18 reached end-of-life (Apr 2025); 20 is a modern, broadly-available floor and lets us use 20-era APIs without guards.

**Rejected.** Node 18 (EOL — supporting an unmaintained runtime). Node 22 (smaller audience for little gain on a test library).

**Enforced in.** [CONVENTIONS → Language & runtime](CONVENTIONS.md#language--runtime).

## D11 — Package split (13 packages)

**Decision.** Ship the packages as laid out: `core`, `expressions`, `composite`, `node`, `docker`, `workflow`, `coverage`, `matchers`, `fixtures`, `types`, `gen`, `cli`, plus the meta `actspec` — 13 independently-published packages + meta.

**Why.** The split maps 1:1 to the plugin architecture (executors/orchestrators register into `core`), so consumers install only what they need and `@actspec/expressions` keeps its independent life. These boundaries are what make adding an executor/orchestrator additive rather than a refactor.

**Rejected.** Coarser grouping — simpler releases, but couples independently-useful pieces (the standalone expression engine) and blurs the executor-as-plugin model.

**Enforced in.** [ARCHITECTURE → Package layout](ARCHITECTURE.md#package-layout-pnpm-monorepo) · [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging).

## D12 — MIT license

**Decision.** MIT.

**Why.** Permissive, and aligned with GitHub's Actions runner (also MIT) — which keeps mirroring its expression/protocol test vectors clean, provided we attribute in `NOTICE`. The whole conformance-corpus strategy ([D5](#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)) leans on this license alignment.

**Rejected.** Apache-2.0 — also permissive but adds a patent grant + `NOTICE` obligations, and diverges from the runner's MIT, complicating vendoring its MIT-licensed vectors.

**Enforced in.** [LICENSE](../LICENSE) · [ARCHITECTURE → License & attribution](ARCHITECTURE.md#license--attribution) · [README](../README.md).

## D13 — changesets for releases, commitizen for commits

**Decision.** Versioning + publishing via **changesets**. Commit experience via **commitizen** (prompts a `scope` from a `scope-enum` of the package names) + **commitlint**, enforced by a **husky** `commit-msg` hook. The two layers are **independent**: changesets owns releases; commitizen/commitlint only shape commit messages.

**Why.** For a 12-package **interdependent** pnpm monorepo, the deciding axis is **release reliability** (maintainer's stated #1 priority: no release bugs).

| For this repo | changesets | semantic-release (+ wrapper) | release-please |
|---|---|---|---|
| Manual effort | small changeset file per change (CI-enforced) | Conventional Commits | Conventional Commits |
| Monorepo / interdependent versions | ✅ first-class | ⚠️ needs `multi-semantic-release`; bug-prone here | ◑ more config |
| `workspace:*` publishing | ✅ native | ⚠️ hand-wired | ◑ |
| Changelog + bump control | ✅ curated, explicit | inferred from commits | inferred |
| Reliability for this graph | ✅ high | ⚠️ risk in dependent-bumps/publish | ◑ |

semantic-release's *core* is solid but single-package; the monorepo layer (`multi-semantic-release`) concentrates bug-risk exactly where this graph is heaviest — cross-package dependent bumps, pnpm `workspace:*` publishing, and coupling to semantic-release internals. changesets is purpose-built for this shape, battle-tested, and actively maintained. commitizen/commitlint are kept because they're **independent of the release tool**, so the wanted "which package?" commit prompt is preserved without taking on semantic-release's monorepo risk.

**Rejected.** **semantic-release** (+ `multi-semantic-release`) — fails the no-bugs bar for this interdependent graph. **release-please** — commit-driven, more monorepo config, weaker curated-changelog control. **Manual** — error-prone across 12 interdependent versions/changelogs.

**Enforced in.** [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging) + [Commit conventions](CONVENTIONS.md#commit-conventions) · DoD ("a changeset describes the change").

## D14 — Build & quality toolchain

**Decision.** *(All swappable defaults — chosen for fit, not locked forever.)*
- **Build:** `tsup` (esbuild + dts) → dual ESM+CJS per package; a single package may drop to rollup/unbuild if it needs special bundling.
- **Lint/format:** ESLint (typescript-eslint, **type-aware**) + Prettier.
- **Unit test runner:** Vitest — for actspec's own package tests (expression engine, parser, protocol, etc.).
- **Integration test runner:** `actspec test` — the walking skeleton and module acceptance scenarios (real action execution through the full stack) run via `actspec test`, dogfooding the runner.
- **CI matrix:** {Linux, macOS, Windows} × {Node 20, 22, 24}.
- **Public-API gate:** API Extractor — a committed API report; a surface change without review fails CI.
- **Packaging checks:** `@arethetypeswrong/cli` + `publint` — validate dual ESM/CJS export resolution.

**Why.** `tsup` gives dual output with near-zero config across 12 packages (rollup considered — more control, but more config ×12; reserved per-package). **ESLint over Biome** specifically because **type-aware** rules are needed to enforce the determinism ban (no `Date.now`/`Math.random`/`randomUUID` — see [CONVENTIONS → Determinism](CONVENTIONS.md#determinism-the-librarys-own-behavior)); Biome's type-aware linting is too limited for that today. **Vitest** for unit tests is the natural fit — it tests TypeScript logic (expression evaluator, protocol parser, etc.) without needing a real `action.yml`. **`actspec test`** for integration tests dogfoods the runner on real action fixtures, providing a final end-to-end validation of the stack (the walking skeleton and module acceptance scenarios). The **full OS×Node matrix** matters because real `run:` shell execution is OS-sensitive. **API Extractor** backs the "no breaking changes v0.1→v0.4" semver promise; **attw + publint** catch dual-package ([D9](#d9--dual-esm--cjs-output)) resolution bugs.

**Rejected.** rollup/unbuild as the *default* (config ×12); Biome (can't robustly enforce the determinism ban); Jest as unit runner (Vitest is faster and better ESM support); narrower CI (misses OS-specific shell behavior).

**Enforced in.** [CONVENTIONS → Build, lint, test tooling](CONVENTIONS.md#build-lint-test-tooling-defaults-swappable) + [CI matrix](CONVENTIONS.md#ci-matrix) + [Public API stability](CONVENTIONS.md#public-api-stability).

## Architecture & fidelity — ratified from the existing docs

*(These were already reasoned in [ARCHITECTURE](ARCHITECTURE.md) but never explicitly ratified; confirmed here so they're owned. The inline "what" already lives in the docs linked per entry.)*

## D15 — Real shell/JS execution, not emulation

**Decision.** `run:` steps spawn the **real** declared shell with GitHub's faithful wrapper (`bash --noprofile --norc -eo pipefail`, …) in a temp workspace with scoped env; (v0.2) real JS in a sandbox. Default isolation = scoped env; hardened isolation (`vm`/`container`/`deny-net`) is an opt-in upgrade.

**Why.** The only path to runner fidelity — emulating shell semantics is infeasible and would break the "matches the runner" promise. Costs accepted explicitly: the shell must be present (cross-OS), a process spawns per step, and it is **not a security boundary** (test trusted actions).

**Rejected.** Emulating/interpreting the shell (infeasible, lossy). Requiring all `run:` stubbed by default (loses the real-bash fidelity that is the product's point — kept as the opt-in `shell:false`).

**Enforced in.** [ARCHITECTURE → Sandboxes](ARCHITECTURE.md#sandboxes) + [Shell execution fidelity](ARCHITECTURE.md#fidelity--semantics) + [Threat model](ARCHITECTURE.md#threat-model) · API.md `ActspecOptions.shell`/`isolation`.

## D16 — Unmocked `uses:` policy: local→real, remote→noop

**Decision.** An unmocked `uses:` → **local** refs (`./`, `../`) execute for real (recurse); **remote** refs (`owner/repo@ref`, `docker://…`) are inert success + a warning annotation. Overridable per-ref/globally to `error`/`noop`/`real` (`real` resolves local paths only).

**Why.** Jest-like "your own local code just runs" with zero ceremony; hermetic (no network) for remote; the warning keeps the gap visible rather than silent. Teams wanting strictness flip the default to `error`.

**Rejected.** Everything→`error` (ceremony even for local composition — offered as opt-in). Everything→`noop` (local actions you own silently don't run, hides real gaps).

**Enforced in.** [ARCHITECTURE → Mocking model](ARCHITECTURE.md#mocking-model--two-distinct-surfaces-one-mental-model-mock-your-dependencies) · API.md `ActspecOptions.unmockedUses` · [core.md](../specs/modules/core.md) behavior 6.

## D17 — Determinism frozen by default

**Decision.** Fixed clock, seeded RNG, stable `GITHUB_RUN_ID`/`RUNNER_TEMP`/workspace paths by default; opt into real time/random per field.

**Why.** A testing library must own its nondeterminism — frozen defaults make `toMatchSnapshot()` stable and tests reproducible out of the box.

**Rejected.** Real-by-default — churny snapshots, non-reproducible tests; the opposite of what a test tool should default to.

**Enforced in.** [ARCHITECTURE → Determinism](ARCHITECTURE.md#determinism-frozen-by-default) · API.md `Determinism` · [CONVENTIONS → Determinism](CONVENTIONS.md#determinism-the-librarys-own-behavior) · [core.md](../specs/modules/core.md) behavior 7.

## D18 — Hand-written Pratt expression parser

**Decision.** `tokenize → parse (Pratt / precedence-climbing) → evaluate`, hand-written, no generator.

**Why.** Full control of caret-precise error messages + source positions, zero codegen/runtime dependency, and a small operator-precedence grammar fits Pratt cleanly. Fast.

**Rejected.** A parser generator (worse positions, adds a dependency, overkill for this grammar). Plain recursive descent (more boilerplate per precedence level for no gain).

**Enforced in.** [ARCHITECTURE → Expression engine](ARCHITECTURE.md#expression-engine-actspecexpressions--the-hard-part) · [EXPRESSIONS → Pipeline](EXPRESSIONS.md#pipeline) · [expressions.md](../specs/modules/expressions.md).

## D19 — Istanbul coverage-map representation

**Decision.** Emit coverage as an **Istanbul map** (step→statement at its YAML range, `if:`→branch true/false; v0.2 JS lines as real line coverage).

**Why.** Unlocks the entire Istanbul reporter set (html/lcov/cobertura/json) and makes `coverage-final.json` mergeable with users' JS coverage via `nyc merge` — for little cost. Caveat stated openly: a `.yml` appears as a "source file" whose statements are steps (positions are YAML).

**Rejected.** A custom format (build every reporter, lose the ecosystem + mergeability). LCOV-only (no html/cobertura/json-summary, weaker merge).

**Enforced in.** [ARCHITECTURE → Coverage](ARCHITECTURE.md#coverage-cross-cutting-all-versions) · [coverage.md](../specs/modules/coverage.md) · API.md §9.

## D20 — Standalone, zero-dep expression engine

**Decision.** `@actspec/expressions` is published standalone with zero `@actspec/*` deps (ideally zero runtime deps).

**Why.** No complete JS implementation of the GitHub Actions expression language exists — real community value — and a standalone package forces clean boundaries. Consistent with the package split ([D11](#d11--keep-the-12-package-split)).

**Rejected.** Folding it into `@actspec/core` (loses community value + boundary discipline; contradicts D11).

**Enforced in.** [ARCHITECTURE → Expression engine](ARCHITECTURE.md#expression-engine-actspecexpressions--the-hard-part) + [Package layout](ARCHITECTURE.md#package-layout-pnpm-monorepo) · [expressions.md](../specs/modules/expressions.md) · API.md §7.

## D21 — Mock surface: keep the split (not unified)

**Decision.** Two mock entries, by dependency kind: `mock(ref)` for `uses:` dependencies (unified across composite/node/docker), and `mockGitHubApi`/`mockNetwork` (v0.2) for a JS action's *internal* Octokit/fetch. **Not** collapsed into one `mock(target)`.

**Why.** A `uses:` target ("an action you call") and a JS action's internal calls are genuinely different dependency kinds; honest typing beats one overloaded entry that would dispatch by sniffing the target string (ambiguous: a `uses:` ref vs an API route). The v0.1 surface (`mock` + `mockShellCommand`) is unaffected.

**Rejected.** Unify into `mock(target)` — "one mental model," but more magic, ambiguous typing, weaker type-checking. *(Previously tracked as the open question O1; now decided. Revisitable if a v0.2 sandbox spike reveals a clean unification — but it is not an open item.)*

**Enforced in.** API.md §2 ("Why one `mock()`…") + §5 · [ARCHITECTURE → Known design tension](ARCHITECTURE.md#known-design-tension-resolved--d21).

## D22 — `run:` substitution is literal (reproduce the injection footgun)

**Decision.** `${{ }}` substitution into `run:` scripts is **literal text** — reproduce GitHub's script-injection behavior; do **not** sanitize/escape.

**Why.** A faithful tester must let tests **catch** injection vulnerabilities in the action under test; sanitizing would diverge from the runner and hide real bugs.

**Rejected.** Sanitize/escape interpolated values — safer-feeling, but diverges from the runner and hides the action's real injection bugs, defeating the tester's purpose.

**Enforced in.** [ARCHITECTURE → Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics) + [Sandboxes](ARCHITECTURE.md#sandboxes) · [composite.md](../specs/modules/composite.md) behavior 1.

## D23 — Golden-captures testing strategy

**Decision.** Adopt golden captures — record a real GitHub run's observable output (outputs, env-file writes, annotations) for a **small** set of real actions, commit them, and assert actspec reproduces them. Start small in v0.1; grow over time.

**Why.** End-to-end fidelity evidence beyond the unit corpora (expression/protocol) — makes the fidelity claims falsifiable against real runs. Cost (capture infra + maintenance) is kept proportionate by starting small.

**Rejected.** Corpora-only (no real-action end-to-end proof). A full capture suite up front (disproportionate for v0.1).

**Enforced in.** [ARCHITECTURE → Trust: conformance](ARCHITECTURE.md#trust-conformance-against-the-real-runner).

## D24 — TypeScript strictness + no-`any`

**Decision.** `tsconfig`: `strict: true` plus `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`; no `any` in public types (internal `any` only with a `// reason` comment).

**Why.** The published types *are* the product's contract — maximal type-safety (checked index access, exact optional props) protects every consumer.

**Rejected.** `strict`-only / allowing `any` — weaker guarantees on exactly the surface consumers depend on.

**Enforced in.** [CONVENTIONS → Language & runtime](CONVENTIONS.md#language--runtime).

## D25 — sideEffects false with the registration entry excepted

**Decision.** Every `package.json` declares `"sideEffects": false` **except** the executor-registration module, which is listed in the `sideEffects` array. Executors register into `core` via that one side-effectful entry.

**Why.** Two goals collide: tree-shaking for consumers (`sideEffects: false`) vs. "installing `@actspec/docker` teaches the runtime about `using: docker`" (an import side effect a bundler could drop). Excepting *only* the registration entry keeps both — pure modules stay tree-shakeable, registration is never pruned.

**Rejected.** `sideEffects:false` everywhere + an explicit `register()` call (changes the install-to-enable ergonomics). Import-time self-registration with no exception (executor packages then can't be `sideEffects:false`, losing tree-shaking).

**Enforced in.** [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging) · [ARCHITECTURE → Package layout](ARCHITECTURE.md#package-layout-pnpm-monorepo).

## D26 — actspec ships its own `expect()` — no Jest or Vitest peer dependency

**Decision.** `@actspec/matchers` ships actspec's **own** `expect()` implementation with custom matchers (`toHaveSucceeded`, `toHaveFailed`, `toHaveRunStep`, etc.). No Jest or Vitest dependency — not a hard dep, not a peer dep.

**Why.** Requiring consumers to install Jest or Vitest just to use actspec's matchers creates two problems: (1) `jest.mock()`/`vi.mock()` alongside `action.mock()` is a conceptual collision — two mock surfaces with different mental models; (2) peer-dep version skew makes `expect.extend` fragile (matchers may register on the wrong instance). actspec's own `expect()` avoids both: one mock concept (`action.mock()`), zero peer-dep surface. `actspec test` injects `expect` into `globalThis`; direct import (`import { expect } from '@actspec/matchers'`) is also supported.

**Rejected.** Jest/Vitest peer dep with `expect.extend` — the original design; dropped because of mock-surface confusion and peer-dep fragility. A single bundled framework dependency — would force consumers onto a specific version.

**Enforced in.** [CONVENTIONS → Monorepo & packaging](CONVENTIONS.md#monorepo--packaging) · [matchers.md](../specs/modules/matchers.md) · [cli.md](../specs/modules/cli.md).

## D27 — Event payloads typed from `@octokit/webhooks-types`

**Decision.** Type webhook event payloads from `@octokit/webhooks-types` (a types-only dependency); pin which fields the factories fill by default; don't hand-transcribe schemas.

**Why.** Authoritative, exhaustive, and stays in sync with real GitHub shapes; hand-rolled schemas drift.

**Rejected.** Hand-roll/vendor a subset — no dependency, but manual maintenance and drift from real webhook shapes.

**Enforced in.** [CONTEXTS → Event payloads](CONTEXTS.md#event-payloads) · [fixtures.md](../specs/modules/fixtures.md).

## D28 — `timeout-minutes` captured, not wall-clock enforced

**Decision.** Record the declared `timeout-minutes` (step + job) and make it assertable; expose `timedOut` only when a test opts into real time. Not enforced by default.

**Why.** Under the frozen clock ([D17](#d17--determinism-frozen-by-default)) a real timeout is meaningless; enforcing wall-clock would make tests time-dependent and flaky.

**Rejected.** Enforce real wall-clock timeouts — conflicts with frozen determinism, introduces timing flakiness.

**Enforced in.** [ARCHITECTURE → Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics) + [Coverage boundary](ARCHITECTURE.md#coverage-boundary) · API.md `StepResult.timeout`.

## D29 — Mask `add-mask` values + all provided secrets

**Decision.** Every `::add-mask::` value **and** every provided secret is replaced with `***` in captured stdout/stderr, `--json` output, and snapshots.

**Why.** Matches the runner and prevents secrets leaking into committed snapshots.

**Rejected.** Mask only explicit `::add-mask::` — a secret passed via run input could leak into a committed snapshot.

**Enforced in.** [PROTOCOL → Masking](PROTOCOL.md#what-actspec-implements) · [ARCHITECTURE → Runner protocol](ARCHITECTURE.md#runner-protocol) · API.md (secrets auto-masked).

## D30 — Ship a snapshot serializer

**Decision.** Register a snapshot serializer that normalizes volatile bits (temp paths) and masks secrets.

**Why.** Makes `toMatchSnapshot()` of a `RunResult` stable and leak-free out of the box (with frozen determinism).

**Rejected.** Default serialization — volatile temp paths churn snapshots and secrets aren't normalized away.

**Enforced in.** [ARCHITECTURE → Typed actions & fixtures](ARCHITECTURE.md#typed-actions--fixtures) + [Diagnostics](ARCHITECTURE.md#diagnostics-that-explain-failures) · API.md §13.

## D31 — One `ActspecError` hierarchy

**Decision.** A single base `ActspecError { code, source? }` with subclasses (`ExpressionError`, `MissingMockError`, `ParseError`, …); no bare `Error` across a package boundary; user-facing errors carry `action.yml:line:col`.

**Why.** Error quality is the product for a testing tool — consistent codes + source positions + typed `catch`.

**Rejected.** Plain `Error` objects — no code/source, weaker diagnostics, no typed catch.

**Enforced in.** [CONVENTIONS → Errors & diagnostics](CONVENTIONS.md#errors--diagnostics) · API.md §13.

## D32 — `actspec()` is synchronous

**Decision.** `actspec()`/`actspecWorkflow()` parse synchronously and return a handle; all execution is async, on `run()`.

**Why.** Mocks chain before `run()`, parse errors surface immediately, and the simplest test stays one line. Parsing needs no async.

**Rejected.** An async factory (`await actspec()`) — ceremony in every test body for no benefit.

**Enforced in.** API.md §1.

## D33 — Model the pre/main/post `phase` from v0.1

**Decision.** Every `StepResult` carries `phase: 'pre' | 'main' | 'post'` from v0.1. Composite populates `'main'`; JS/Docker (v0.2/v0.3) yield up to three.

**Why.** Keeps the pre/main/post lifecycle on the unified surface with **no new API later** — honors the additive-roadmap invariant. Adding `phase` in v0.2 would reshape `StepResult`, a breaking change to the very surface the semver promise protects.

**Rejected.** Introduce `phase` in v0.2 — reshapes a published type later.

**Enforced in.** API.md §4 (`StepResult.phase`) · [ARCHITECTURE → Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics).

## D34 — `runner.os` default is `'Linux'`, overridable

**Decision.** `runner.os` is a fixture with a fixed default of **`'Linux'`** (CI's common OS), overridable per run/handle/fixture. Shell resolution follows GitHub precedence; cross-platform shells (`bash`/`pwsh`/`sh`/`python`) execute natively on the host; an **explicitly** host-locked shell that's absent (`cmd` / legacy `powershell` off-Windows) **fails with a clear, actionable message** → stub the step or run the suite on that OS. **No OS emulation** — setting `runner.os` changes the context value, not the real shell.

**Why.** `runner.os` is only a *context value* — it drives `${{ runner.os }}` reads and default-shell selection, not real OS execution. So a fixed default is correct, and `'Linux'` is both the common CI target and **deterministic** across machines ([D17](#d17--determinism-frozen-by-default)). Override it to unit-test other-OS branch *logic* from any machine. Real execution of a host-locked shell needs the actual OS (e.g. a Windows CI runner); failing loud is honest — you can't run Windows on a Mac (Windows containers also need a Windows host).

**Rejected.** Default = the host OS (non-deterministic across machines — reconsidered once it was clear `runner.os` is just a context value, not real execution). Auto-detect, non-overridable (can't test other-OS logic). Silent fallback to an available shell (mis-executes). OS emulation/containers (infeasible on a Mac).

**Enforced in.** [CONTEXTS → runner context](CONTEXTS.md#runner-context) · [ARCHITECTURE → Cross-platform](ARCHITECTURE.md#cross-platform) + [Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics).

## D35 — `github.repository` uses a fixed synthetic default

**Decision.** `github.repository` defaults to `'owner/repo'` and `repository_owner` to `'owner'` — fixed, deterministic, obviously synthetic. Overridable per run (`github: { repository: 'my-org/my-action' }`). Fields built from `repository` (e.g. `workflow_ref`) follow the same fixed value.

**Why.** The original design (read git remote at runtime) breaks [D17](#d17--determinism-frozen-by-default): the same test produces different default contexts across machines and forks, making `toMatchSnapshot()` non-reproducible. The benefit was illusory — tests that depend on the exact repo name set it explicitly; tests that don't care work fine with any fixed value. Git-remote reading also adds a hidden runtime dependency that can fail in unusual CI environments and surprises users. A fixed synthetic placeholder is consistent with how every other context default works.

**Rejected.** Git-remote derivation (the original design — non-deterministic across forks/machines, breaks D17, surprising runtime side effect). Empty string (less clear than a named placeholder). A real-looking repo name (easily confused with a real dependency; wrong for every consumer).

**Enforced in.** [CONTEXTS → github context](CONTEXTS.md#github-context) · [D37](#d37--context--option-default-values).

## D36 — `MockResolver` recursion guard

**Decision.** The `MockResolver` always performs **cycle detection** across the nested `uses:` graph (a self-referential graph fails loudly) and enforces a **max-depth limit — default 50, configurable**.

**Why.** A self-referential or runaway-deep `uses:` graph must fail with a clear error rather than hang. 50 is generous for any realistic action/composite tree while catching accidental infinite recursion fast; configurable for the rare deep-but-legitimate graph.

**Rejected.** No limit (can hang). A much lower fixed limit (could trip legitimate deep trees). A much higher one (slower to catch runaways).

**Enforced in.** [ARCHITECTURE → Mocking model](ARCHITECTURE.md#mocking-model--two-distinct-surfaces-one-mental-model-mock-your-dependencies) · [core.md](../specs/modules/core.md) behavior 6.

## D37 — Context & option default values

**Decision.** Defaults (single-sourced in `@actspec/types`, imported by both `@actspec/core` and `@actspec/fixtures`; all overridable per run):
- **github:** `actor`/`triggering_actor` `octocat`, `sha` 40×`0`, `ref` `refs/heads/main` (`ref_name` `main`, `ref_type` `branch`), `run_id`/`run_number`/`run_attempt` `1`; `repository` `'owner/repo'`, `repository_owner` `'owner'` (fixed synthetic — [D35](#d35--githubrepository-uses-a-fixed-synthetic-default)).
- **runner:** `os` `Linux` ([D34](#d34--runneros-default-is-linux-overridable)), `arch` `X64` (fixed), `name` `actspec`, `tool_cache` `/opt/hostedtoolcache`, `environment` `github-hosted`.
- **run options:** `jobStatus` `success`, `diagnostics` `errors`, `workspace` `temp`, `isolation` `scoped`, `container` `mock` (v0.3).
- **coverage:** `reporters` `['text','html']`, `coverageDir` `./coverage`.

**Why.** Stable, obviously-synthetic defaults keep snapshots stable ([D17](#d17--determinism-frozen-by-default)) and the simplest test one line; each is overridable for the test that cares. `octocat` replaces the old library-name `actspec` for `actor`; `arch` stays a fixed `X64`, consistent with the fixed `runner.os`.

**Rejected.** Host-derived `arch` (non-deterministic). Git-HEAD `sha` (churns snapshots). Per-tool nested coverage dir (`./coverage/actspec`) — simplified to `./coverage`.

**Enforced in.** [CONTEXTS](CONTEXTS.md) · API.md §1/§9 · [types.md](../specs/modules/types.md) · [fixtures.md](../specs/modules/fixtures.md).

## D38 — Explicit deferrals (not open items)

**Decision.** Deferred, recorded explicitly:
- **v0.2** (node executor): `JsSandbox` (worker_thread), undici `MockAgent` for the GitHub API, c8 V8→Istanbul JS-line coverage.
- **v0.3** (docker executor): `ContainerSandbox` backends (mock default / docker / podman).
- **opt-in / later:** bash-line coverage (kcov/bashcov), expression sub-branch coverage (AST instrumentation).
- **post-v0.1:** CLI `--record`/replay (needs the opt-in remote resolver), `@actspec/gen` codegen (`actspec gen`) — reserved (subcommand errors politely) until v0.1 is validated.

**Why.** Each is tied to a feature that doesn't exist in v0.1 (node=v0.2, docker=v0.3) or is deepening/ergonomics over a surface that must be proven first. Deferring keeps v0.1 focused — not workarounds, since v0.1 genuinely doesn't need them (the no-workarounds rule applies to what v0.1 *needs*).

**Rejected.** Pulling any into v0.1 (broadens an unproven, composite-only core).

**Enforced in.** [ARCHITECTURE → Scope discipline](ARCHITECTURE.md#scope-discipline--explicitly-deferred-past-v0.1) · [versions/v0.2.md](../specs/versions/v0.2.md) / [v0.3.md](../specs/versions/v0.3.md) · [gen.md](../specs/modules/gen.md) · [cli.md](../specs/modules/cli.md).

## D39 — Faithful reproduction, including footguns, is binding

**Decision.** actspec reproduces the runner's **observable** behavior faithfully — *including* its footguns (`run:` injection [[D22](#d22--run-substitution-is-literal-reproduce-the-injection-footgun)], advisory missing-required-input) — rather than "improving" on it. The specific behaviors (`INPUT_*` transform, expression coercion, protocol encoding/escaping, shell wrappers, pre/main/post ordering) are **dictated by the conformance corpora**, not independently chosen.

**Why.** A faithful tester must let tests catch the action's real bugs (including unsafe behavior); sanitizing for "safety/convenience" would hide real issues and break the "matches the runner" promise. These are requirements, not free decisions — which is why category-C items aren't separately ratifiable.

**Rejected.** Normalizing/sanitizing for safety or convenience (hides real bugs, diverges from the runner).

**Enforced in.** [ARCHITECTURE → Fidelity & semantics](ARCHITECTURE.md#fidelity--semantics) · the corpora ([EXPRESSIONS](EXPRESSIONS.md) + [PROTOCOL](PROTOCOL.md)).

## D40 — `JobResult` uses `Omit<RunResult, 'conclusion'>`, not `extends RunResult`

**Decision.** `JobResult` is defined as `interface JobResult extends Omit<RunResult, 'conclusion'> { conclusion: 'success' | 'failure' | 'skipped' | 'cancelled'; … }` rather than `extends RunResult` directly.

**Why.** TypeScript does not allow widening an inherited property — `interface JobResult extends RunResult { conclusion: 'success' | 'failure' | 'skipped' | 'cancelled' }` is a compile error because `RunResult.conclusion` is `'success' | 'failure'` and the subtype narrows, not widens. Jobs need the wider union because `if:` false → `'skipped'`; fail-fast → `'cancelled'`. `RunResult.conclusion` stays narrow intentionally — action results genuinely never have those values. `Omit` is the standard TypeScript pattern for this case. Confirmed by the workflow spike (H3 finding).

**Rejected.** `extends RunResult` directly — TypeScript compile error on the wider `conclusion`. Widening `RunResult.conclusion` to include `'skipped' | 'cancelled'` — incorrect for actions, which never produce those conclusions.

**Enforced in.** [API.md §10](API.md) · [specs/versions/v0.4.md](../specs/versions/v0.4.md) · [specs/modules/matchers.md](../specs/modules/matchers.md) (impl note on `toHaveRunJob`).

---

## D41 — `@actspec/types` is the zero-dep DAG root: types + defaults

**Decision.** Extract all public interfaces and default constants into a dedicated `@actspec/types` package with zero `@actspec/*` dependencies. `@actspec/core` imports from it and re-exports for consumers; `@actspec/fixtures` imports from it in place of its former `@actspec/core` types-only dep. This package sits at the bottom of the dependency DAG alongside `@actspec/expressions`.

**Why.** The previous design had `@actspec/fixtures` depending on `@actspec/core` for types, and `@actspec/core` depending on `@actspec/fixtures` for defaults — a circular dependency. Extracting types and defaults into a zero-dep package breaks the cycle cleanly: neither `core` nor `fixtures` depends on each other; both depend on `@actspec/types`. It also gives the "no package holds types except the types package" principle a concrete home — the shape of every public type is co-located with its default values, independently auditable.

**Rejected.** (a) `@actspec/core` owns defaults, `@actspec/fixtures` imports from core — breaks the circular dep but makes `fixtures` depend on `core`, heavier than needed for a pure-data package. (b) `peerDependencies` workaround — works but obscures the intended direction. (c) Alternate names (`@actspec/schema`, `@actspec/context-types`) — `@actspec/types` is the natural fit, freed by renaming the codegen package to `@actspec/gen` ([D38](#d38--explicit-deferrals-not-open-items)).

**Enforced in.** [ARCHITECTURE → Package layout](ARCHITECTURE.md#package-layout-pnpm-monorepo) · [types.md](../specs/modules/types.md) · [core.md](../specs/modules/core.md) · [fixtures.md](../specs/modules/fixtures.md).

---

*Recorded during an explicit decision session on 2026-06-05, before any v0.1 implementation. All decisions are ratified with the maintainer and mirrored inline in the specs/docs linked above: D1–D6 resolved under-specified seams; D7–D14 are project/tooling; D15–D39 ratify architecture, strategy, defaults, and explicit deferrals. D40 added post-session from the workflow spike (H3 finding). D41 added during doc review: shared types package breaks the fixtures ↔ core circular dependency; codegen package renamed to `@actspec/gen`.*
