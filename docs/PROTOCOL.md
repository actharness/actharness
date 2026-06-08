# actspec — Runner protocol spec (`@actspec/core`)

Normative spec for the **runner-file protocol** and **stdout workflow commands** — how an action communicates outputs, env, state, paths, summaries, annotations, and masks. This is the **#2 fidelity surface** after the expression language; like that one, it is grounded in source, not memory.

## Sources (grounded)
- `actions/toolkit` — `packages/core/src/command.ts` (stdout commands + escaping), `file-command.ts` (env files + heredoc), `utils.ts` (`toCommandValue`). This is the **producer** side every JS action uses.
- `actions/runner` — `src/Runner.Worker/ActionCommandManager.cs` (the **consumer** that parses them).
- Round-trip rule: actspec writes the env-file paths an action appends to and **parses** what the action emits; it MUST reproduce the toolkit's encoding exactly so a real `@actions/core` action round-trips unchanged.

## `toCommandValue` (used everywhere a value is serialized)
`null`/`undefined` → `''`; `string` → itself; anything else → `JSON.stringify(value)`. (So an object output becomes its JSON text.)

## Stdout workflow commands
Format: `::name key=value,key=value::message` — one per line, written to stdout.

- Properties are emitted **only when truthy**, joined by `,`, as `key=escapeProperty(value)`.
- A bare command is `::name::message` (no properties) or `::name::` (no message).

### Escaping (binding — the easy-to-miss part)
| Context | Replacements (in order) |
|---------|--------------------------|
| **message** (`escapeData`) | `%`→`%25`, `\r`→`%0D`, `\n`→`%0A` |
| **property value** (`escapeProperty`) | `%`→`%25`, `\r`→`%0D`, `\n`→`%0A`, `:`→`%3A`, `,`→`%2C` |

**Parsing reverses these — and `%25`→`%` MUST be decoded *last***, otherwise a literal `%0A` in the source (encoded `%250A`) decodes wrongly. Decode `%0A`/`%0D`/`%3A`/`%2C` first, then `%25`.

### Command set actspec MUST parse
| Command | Notes |
|---------|-------|
| `error` / `warning` / `notice` | → `Annotation`. Props: `title`, `file`, `line` (startLine), `endLine`, `col` (startColumn), `endColumn`. |
| `debug` | → `Annotation{ level:'debug' }`. |
| `add-mask` | register the value as a secret → replace with `***` in all captured stdout/stderr. |
| `group` / `endgroup` | log grouping (cosmetic; preserve in captured logs). |
| `echo` `on`/`off` | toggles command echoing (cosmetic). |
| `stop-commands` `<token>` / `<token>` | **security**: stop interpreting `::commands::` until the matching token. MUST honor it (an action uses it to prevent log injection). |
| `set-output` *(deprecated)* | `::set-output name=x::v` → `steps.*.outputs`. Superseded by `$GITHUB_OUTPUT` but still emitted by old actions. |
| `save-state` *(deprecated)* | → `$GITHUB_STATE` equivalent. |
| `set-env` *(deprecated/removed)* | parse-and-warn; modern actions use `$GITHUB_ENV`. |
| `add-path` *(deprecated)* | → prepend PATH. |

## Env files
The runner sets these env vars to **temp file paths**; the action *appends* to them. actspec allocates the temp files per invocation, points the vars at them, and parses them **after each step** (env/path/state apply to subsequent steps; output to `steps.<id>.outputs`).

### Key-value files — `GITHUB_OUTPUT`, `GITHUB_ENV`, `GITHUB_STATE`
Two accepted line forms (actspec MUST parse both):
1. **Single line:** `NAME=VALUE`.
2. **Heredoc** (what modern `@actions/core` always writes):
   ```
   NAME<<ghadelimiter_<uuid>
   <value, possibly multi-line>
   ghadelimiter_<uuid>
   ```
   The delimiter is `ghadelimiter_` + a random UUID. **CVE guard:** the producer throws if the key or value contains the delimiter; a parser MUST treat a value containing its own delimiter as malformed. (This guard is the fix for the old `set-env` injection vuln — reproduce it so tests can catch unsafe actions.)
- `STATE_<name>` from `GITHUB_STATE` is exposed to the `post:` phase.

### Line files — `GITHUB_PATH`, `GITHUB_STEP_SUMMARY`
- `GITHUB_PATH`: each appended line is a directory **prepended** to `PATH` for later steps.
- `GITHUB_STEP_SUMMARY`: raw Markdown, appended; surfaced on the result, not parsed.

## What actspec implements
- **Write side:** allocate temp files, set `GITHUB_{OUTPUT,ENV,PATH,STATE,STEP_SUMMARY}` + the env an action expects; a real `@actions/core` "just works."
- **Read side:** after a step, parse the key-value/line files and the stdout command stream (honoring `stop-commands`, decoding in the correct order), producing `steps.<id>.outputs`, context `env`, `PATH`, state, annotations, masks.
- **Masking:** every `add-mask` value and every provided secret is replaced with `***` in captured logs and in `--json`/snapshot output.

## Conformance corpus
Seed under [corpus/protocol/](../corpus/protocol/) — round-trip cases (`encode`/`decode`) for commands and env-file forms, including the escaping edge cases (`%`, `\n`, `:` in props), multi-line heredocs, and `stop-commands`. The gate: encode-then-decode is identity, and decode matches the toolkit's output byte-for-byte.
