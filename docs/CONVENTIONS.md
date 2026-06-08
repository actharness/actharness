# actspec — Build conventions

Rules for whoever (human or AI) implements actspec from these specs. The goal is that an implementer can pick up any module spec and build it **without re-deriving project-wide decisions**. Where a choice is a sensible default you may swap, it says *(default, swappable)*; everything else is binding.

## Build philosophy

**No workarounds in v0.1.** Whatever v0.1 genuinely needs is built **fully and properly** — never stubbed, faked, or half-validated to save time. The only things that may wait are capabilities whose first real use is v0.2+ (the node/docker executors, `JsSandbox`, typed-action codegen); deferring *those* is fine. The test for any scope cut is *"does v0.1 actually need this?"*, not *"can we ship something smaller?"*. Design rationale lives in [DECISIONS.md](DECISIONS.md) — and is **mirrored inline** wherever it applies, so reading one spec is enough (don't rely on the decision log alone).

## Spec contract (how to read a module spec)

Every `specs/modules/<m>.md` is **contract + acceptance**, not step-by-step instructions:

- **Responsibility** — what the module owns, in one paragraph.
- **Public API** — exact TypeScript types (the binding surface; cross-referenced to [API.md](API.md)).
- **Dependencies** — which `@actspec/*` packages it may import. **No cycles.**
- **Behavior** — normative rules (MUST/MUST NOT).
- **Acceptance** — the fixtures/tests that must pass. *You choose how to implement; the fixtures decide if you're done.*
- **Done-when** — the checklist that closes the module.

Prefer making an acceptance fixture pass over matching prose. If prose and a committed fixture disagree, **the fixture wins** (and flag it).

## Language & runtime

- **TypeScript**, `strict: true` (+ `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). No `any` in public types; internal `any` only with a `// reason` comment.
- Source targets **Node 20+**. Don't use APIs newer than the floor without a guard.
- **Dual ESM + CJS** output with type declarations. Consumers may be either.
- ESM-first source (`import`/`export`); no top-level `require`.
- **CJS packages in ESM context** — some dependencies (e.g. `istanbul-lib-coverage`, `istanbul-lib-report`, `istanbul-reports`) are CommonJS and do not expose named ESM exports. Under `"type": "module"`, named imports (`import { createCoverageMap } from 'istanbul-lib-coverage'`) fail at runtime. Use default import + destructure: `import pkg from 'istanbul-lib-coverage'; const { createCoverageMap } = pkg`. For packages used in multiple files, centralize this in a bridge module (e.g. `src/istanbul-compat.ts`) that re-exports with proper TypeScript types, rather than repeating the pattern at each callsite.

## Monorepo & packaging

- **pnpm workspaces + [changesets](https://github.com/changesets/changesets)** *(binding — see ARCHITECTURE → Package layout)*. One repo, each `@actspec/*` independently published.
- Layout per package:

  ```text
  packages/<name>/
    src/            # implementation; src/index.ts is the only public entry
    test/           # unit + acceptance (corpus/fixtures)
    package.json    # name @actspec/<name>, exports map (import/require/types), files: [dist]
    tsconfig.json   # extends ../../tsconfig.base.json
    CHANGELOG.md    # changesets-managed
  ```

- `package.json` MUST declare `"exports"` with `types`/`import`/`require`, `"sideEffects": false` — **except** the executor-registration entry, which is listed in the `sideEffects` array so bundlers don't tree-shake registration away ([D25](DECISIONS.md#d25--sideeffects-false-with-the-registration-entry-excepted)). No test-framework peer dependency ([D26](DECISIONS.md#d26--actspec-ships-its-own-expect----no-jest-or-vitest-peer-dependency)).
- Internal deps use `workspace:*`. **Respect the dependency DAG in each spec; no import cycles** (enforced in CI).

## Commit conventions

Commits follow **Conventional Commits**, authored via **commitizen** (prompt includes a `scope` chosen from a `scope-enum` of the package names — `core`, `expressions`, …) and enforced by **commitlint** through a **husky** `commit-msg` hook. This is **independent of releasing**: [changesets](#monorepo--packaging) owns versioning/publish; commit conventions only shape history + changelog clarity ([D13](DECISIONS.md#d13--changesets-for-releases-commitizen-for-commits)).

## Build, lint, test tooling *(defaults, swappable)*

- **Build:** `tsup` (esbuild) → dual `dist` + `.d.ts`.
- **YAML parsing:** `yaml` (eemeli) — **position-preserving** (CST node ranges), required for source-mapped errors + coverage line ranges ([D2](DECISIONS.md#d2--yaml-parser-preserves-positions)). *Binding: the position requirement; the lib is the default.*
- **Lint/format:** ESLint (typescript-eslint, **type-aware**) + Prettier. Type-aware rules are required to enforce the determinism ban (no `Date.now`/`Math.random`/`randomUUID`) — which is why ESLint over Biome here ([D14](DECISIONS.md#d14--build--quality-toolchain)).
- **Packaging checks:** `@arethetypeswrong/cli` + `publint` validate that the dual ESM/CJS exports resolve correctly — catching dual-package hazards from [D9](DECISIONS.md#d9--dual-esm--cjs-output).
- **Unit tests:** **Vitest** — for actspec's own package tests (expression engine, parser, protocol, mock resolver, etc.).
- **Integration tests:** **`actspec test`** — the walking skeleton and module acceptance scenarios (real action execution through the full stack) run via `actspec test`, dogfooding the runner on real `.test.ts` fixture files.

## Determinism (the library's own behavior)

The runtime is **deterministic by default** (frozen clock, seeded RNG, stable ids — see API.md `Determinism`). Implementations MUST route time/random/uuid/temp-path generation through an injected clock/RNG, never `Date.now()`/`Math.random()`/`crypto.randomUUID()` directly. This is both a product feature and what keeps the lib's own snapshot tests stable.

## Errors & diagnostics

- One error hierarchy from `@actspec/core`: `ActspecError { code: string; source?: { file; line; col } }`, with subclasses (`ExpressionError`, `MissingMockError`, `ParseError`, …). No throwing bare `Error` across a package boundary.
- User-facing errors carry **source position** (`action.yml:line:col`) and an actionable message. See API.md §13.

## Public API stability

- The unified surface (`actspec`, `actspecWorkflow`, `mock`/`run`/`expect`, matchers) follows **semver with no breaking changes across v0.1→v0.4** (ARCHITECTURE → API stability).
- Public API is snapshotted with **API Extractor** (or `@arethetypeswrong`); a public-surface change without a changeset fails CI.

## Definition of Done (every module)

1. Public API matches the module spec's types exactly.
2. All acceptance fixtures/tests green; coverage meets the module's threshold.
3. Lint + typecheck clean; no import cycles; no `any` in public types.
4. Dual ESM/CJS build emits and is importable both ways.
5. A **changeset** describes the change.
6. README with a minimal usage example.

## Protocol file permissions (Docker)

**`ContainerSandbox` MUST create protocol temp files with `chmod 0o666` (world-writable) before each `docker run` invocation.** Docker actions commonly run as a non-root user (`USER <uid>:<gid>` in the Dockerfile). The bind-mounted temp files are owned by the host user (typically the CI runner account). Without `0o666`, a non-root container user gets `Permission denied` when writing to `$GITHUB_OUTPUT`, the action silently produces no outputs, and the step passes (exit 0 from the write, not the action). This permission is set *before* calling `docker run`, not at temp-file creation time, because the files are shared across phases and must remain accessible at each phase.

This invariant applies to all five protocol files: `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STATE`, `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`.

## CI matrix

`{ Linux, macOS, Windows } × { Node 20, 22, 24 }`. The expression engine additionally runs the **full vendored conformance corpus + parser/eval fuzz** (the v0.0 gate); a **live differential** pass against `nektos/act` is **optional and non-blocking** ([D5](DECISIONS.md#d5--expression-gate-is-the-full-vendored-corpus-plus-fuzz)).
