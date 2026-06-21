# actharness — Roadmap

> Thinking space for what's done, what's next, and what's deliberately deferred. Complements the version specs in `specs/versions/` (detail), [ARCHITECTURE.md](ARCHITECTURE.md) (design), and [DECISIONS.md](DECISIONS.md) (rationale).

---

## Version milestones

| Version | Status | Adds | Coverage gained |
|---------|--------|------|-----------------|
| **v0.0** | published | `@actharness/expressions` standalone — full engine, corpus (459 vectors), fuzz CI | none (no test framework yet) |
| **v0.1** | published | `using: composite` — ShellSandbox, conformance corpus, CLI (`actharness test` / `actharness run` / `actharness init`) | step · `if:`-branch · input/default · output |
| **v0.2** | in progress | `using: node20/24/…` — JsSandbox, net mock | + JS lines · branches · functions · statements (V8/Istanbul) · sh/bash/pwsh/python/node-shell line coverage |
| **v0.3** | planned | `using: docker` — ContainerSandbox (mock / docker / podman backends) | (Docker actions covered as steps) |
| **v0.4** | planned | Workflows — WorkflowRunner, job DAG, matrix, reusable workflows | + job coverage · `needs:` edges |
| **v0.5+** | future | Future `using:` types; new executors | inherits step + branch free |

---

## Coverage roadmap

The coverage layer is **cross-cutting** — it ships in v0.1 and deepens as executors are added. Each layer is independent; a missing layer doesn't block others.

| Layer | Metric | Status | Notes |
|-------|--------|--------|-------|
| Step coverage | `steps` | ✅ v0.1 | which steps ran vs were skipped |
| `if:`-branch coverage | `ifBranches` | ✅ v0.1 | each `if:` seen both true AND false |
| Input/default coverage | `inputs` | ✅ v0.1 | declared inputs + defaults exercised |
| Output coverage | `outputs` | ✅ v0.1 | declared outputs actually produced |
| JS statement coverage | `jsStatements` | ✅ v0.2 | V8 inspector API inside JsSandbox worker; near-free via Istanbul |
| JS branch coverage | `jsBranches` | ✅ v0.2 | V8 inspector API inside JsSandbox worker; near-free via Istanbul |
| JS function coverage | `jsFunctions` | ✅ v0.2 | V8 inspector API inside JsSandbox worker; near-free via Istanbul |
| JS line coverage | `jsLines` | ✅ v0.2 | V8 inspector API inside JsSandbox worker; near-free via Istanbul |
| sh line coverage | `shShellLines` | ✅ v0.2 (partial) | Line-only via `PS4`/`set -x`; branch, statement, and function coverage unsolved; see [sh/bash coverage](#shbash-coverage) below |
| bash line coverage | `bashShellLines` | ✅ v0.2 (partial) | Line-only via `PS4`/`set -x`; branch, statement, and function coverage unsolved |
| pwsh line coverage | `pwshShellLines` | ✅ v0.2 (partial) | Line-only via `Set-PSBreakpoint` per line; branch/statement/function coverage unsolved |
| Python coverage | `pythonShellLines` · `pythonShellStatements` · `pythonShellBranches` | ✅ v0.2 | Via `coverage.py`; statement + branch + line |
| `shell: node` coverage | `nodeShellLines` · `nodeShellStatements` · `nodeShellBranches` | ✅ v0.2 | V8 inspector API; same mechanism as JsSandbox |
| Job coverage | `jobs` | v0.4 | workflow jobs run/skipped; `needs:` edges taken |
| `github.workflow_ref` derivation | — | v0.4 | currently a fixed synthetic string; derive from the workflow file path + `github.repository` + `github.ref` when `WorkflowRunner` is built — only meaningful when a real workflow file exists |
| Expression sub-branch | — | later, hard | sub-conditions inside `${{ a && b \|\| c }}`; needs AST instrumentation in `@actharness/expressions` |

---

## Deferred features

Explicitly deferred — not forgotten. The seams support them; they ship when the core is validated and trusted.

| Feature | Rationale |
|---------|-----------|
| `@actharness/gen` — typed-action codegen (`action.yml` → `Action<In, Out>`) | Post-v0.1; depends on a stable public surface |
| CLI `--record` / replay | Useful but not v0.1-blocking |
| Hardened isolation (`isolation: vm \| container \| deny-net`) | Opt-in upgrade path; default is hermeticity for determinism, not containment |
| Shell command stubs — `actharness.mockShellCommand` per runtime (bash/sh, pwsh, python, `shell: node`) | Deferred; approach TBD — per-runtime PATH injection or script wrapping |
| sh/bash/pwsh full coverage (branches, statements, functions) | Line-only is implemented (v0.2); full coverage is unsolved — approach TBD; see below |
| ~~pwsh global-state reset between steps (U1/L3)~~ | **✅ Done (v0.1 post-ship).** Each step now runs in a fresh `Runspace` created and disposed inside the pwsh host loop — `$global:` variables, functions, modules, and `$PSDefaultParameterValues` are fully isolated between steps. When a step uses `Add-Type -TypeDefinition`, the session process is rolled so the next step starts with a clean AppDomain. Static .NET fields on pre-compiled DLL types are a residual gap; opt-in `pwshIsolation: 'process'` provides full isolation at ~500ms/step cost. |

---

## sh/bash coverage

Shell script coverage (lines, branches, statements, and functions inside `run:` steps) is the one coverage layer without a complete solution.

### Current state

`PS4`/`set -x` trace parsing is implemented in v0.2 and gives **line coverage only** (`shShellLines` / `bashShellLines` metrics). This is a partial solution — it does not capture branches, statements, or function calls. It activates automatically when `--coverage` is passed (no external dependencies).

**This must be replaced or extended.** Line-only coverage is not the end goal.

### Options for full coverage

| Approach | Coverage | Cross-platform | External dep |
| -------- | -------- | :-: | :-: |
| `kcov` (ptrace + DWARF) | lines + branches | Linux only | system binary |
| `bashcov` (Ruby DEBUG trap) | lines only | Linux/macOS | Ruby |
| `PS4` + `set -x` trace parsing | lines only | all shells | none ← **current** |
| Build from scratch (TS sh/bash parser + instrumenter) | lines + branches + statements + functions | all shells | none |

### Open questions (to resolve before scheduling the full solution)

- What is the target coverage: lines + branches only, or also statements and functions?
- Is an external dependency (`kcov`) acceptable, or must the solution be zero-dep?
- How do we map tool output back to `action.yml` YAML line ranges? The script is extracted from YAML, so line numbers don't directly correspond.
- Does this belong in actharness proper or as a separately installable plugin?
