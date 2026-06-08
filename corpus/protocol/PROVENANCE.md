# Protocol corpus — provenance & harvest status

Records **how this corpus was produced** and **how complete it is** against the
runner-file / workflow-command behavior the `core` protocol gate requires
([PROTOCOL.md](../../docs/PROTOCOL.md) — encode/decode round-trip).
Complements [NOTICE](NOTICE) (which covers *license/attribution*); this file covers
*what was actually done* so the status is **explicit, never inferred**.

> Why this exists: like the expression corpus, the protocol corpus's status was only
> *implied* — NOTICE says the vectors are "*derived from*" the toolkit + runner, which
> does not say whether the set is a seed or a completed enumeration. This document
> resolves that and is kept current as the protocol work lands.

## Status

| Field | Value |
|-------|-------|
| **Status** | `SEED` — round-trip + edge-case vectors that pin the encoding, **not** an exhaustive enumeration |
| **As of** | 2026-06-05 |
| **Cases committed** | **16** — `commands.json` 9, `env-files.json` 7 |
| **Full enumeration run?** | **No / unconfirmed** — see *Evidence* below |
| **Upstream commit/ref reflected** | **UNRECORDED** — to be captured when the protocol corpus is validated |
| **Gate met?** | The committed cases must pass round-trip ([PROTOCOL.md](../../docs/PROTOCOL.md)); **coverage of the full command/env-file surface is not yet claimed** |

## Evidence this is a seed
- The corpus is labelled a **"seed"** in [README](README.md) and [PROTOCOL.md](../../docs/PROTOCOL.md#conformance-corpus).
- It pins the **load-bearing** behaviors (the `%25`-decoded-last rule, heredoc + CVE guard, `stop-commands`, escaping edge cases) with a small number of representative cases — not every command/property permutation.
- The repo contains **no vendored copies** of the upstream sources, only the curated JSON.

> If a fuller enumeration *was* run, it is **not evident in the repo** and must be captured here rather than assumed.

## Sources reflected (see [NOTICE](NOTICE) for license)
- `actions/toolkit` — `packages/core/src/command.ts`, `file-command.ts`, `utils.ts` (the **producer** / encoding side every JS action uses).
- `actions/runner` — `src/Runner.Worker/ActionCommandManager.cs` (the **consumer** / parsing side).

## Open work (to reconcile + complete here)
Owned by the `core` protocol implementation (the [PROTOCOL.md](../../docs/PROTOCOL.md) gate):
1. Pin the **upstream commit/ref** the vectors reflect; record it above.
2. Decide and record whether the seed is **sufficient** for the gate or whether the full command/env-file surface should be enumerated; expand if needed.
3. Update the **Status** table (→ `expanded` / `complete`, with the new case count and date) as the work advances.

## Change log
- **2026-06-05** — `SEED` (16 cases). Provenance documented; full enumeration not yet run/committed.
