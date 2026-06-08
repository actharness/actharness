# actspec — Build specs

Implementation specs for building actspec. Read these together with [docs/](../docs/) (the *why/what*); these are the *build-this* layer.

## How it's organized (two axes, no duplication)
- **`modules/<name>.md` — durable contracts.** What each `@actspec/*` package *is*: responsibility, public types, dependencies, behavior, acceptance, done-when. A module evolves across versions but has **one** spec.
- **`versions/vN.md` — milestones.** What to build *now*: which modules (and which slice of each), the build order, the integration checkpoint, and exit criteria. Versions **reference** modules; they don't re-spec them.

So "by module" and "by version" both exist — modules are the stable contracts, versions are the increments that point at them. Adding v0.2 doesn't fork the module specs; it extends them and adds `versions/v0.2.md`.

## Reading order
1. [docs/ARCHITECTURE.md](../docs/ARCHITECTURE.md) — the model (executors, orchestrators, the recursion).
2. [docs/API.md](../docs/API.md) — the public surface (the contract consumers see).
3. [docs/CONVENTIONS.md](../docs/CONVENTIONS.md) — how every module is built and "done."
4. **`versions/v0.1.md`** — start here to build; it sequences the module specs.
5. `modules/*.md` — the per-package contracts, in the order v0.1 lists them.

## Depth policy
**v0.1 is specified deep; v0.2–v0.4 are light** until v0.1 is built and validated — we don't detail-spec ahead of what the first build teaches us (ARCHITECTURE → Risks). `versions/v0.2.md`+ are intentionally thin pointers.

## Status

- `docs/EXPRESSIONS.md` + `corpus/expressions/` — **done** (grounded against the C# runner + act; **459 vectors**, fully harvested from `nektos/act` test tables; parser/eval fuzz not yet in CI — the one remaining v0.0 gate item).
- `versions/v0.1.md` + all 8 `modules/*.md` — **done** (v0.1 fully specified; `modules/types.md` is a deferred stub).
- `versions/v0.2.md`–`v0.4.md` — **light stubs** (promoted to full milestones as each prior version is validated).
