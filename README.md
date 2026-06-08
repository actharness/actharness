# actspec

**Unit testing for GitHub Actions — Jest, but for `action.yml`.**

Test an action in isolation, hermetically, with no real GitHub runner and no network: mock external `uses:` calls, simulate the runner protocol (`$GITHUB_OUTPUT`, `$GITHUB_ENV`, …), evaluate the `${{ }}` expression language, and assert on which steps ran, what was passed to mocks, what outputs were set, and step conclusions — all behind one unified API regardless of action type.

```ts
import { actspec } from 'actspec';

const action = actspec('./action.yml');           // composite / node / docker — caller doesn't care
action.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });
const result = await action.run({ inputs: { name: 'World' } });

expect(result).toHaveSucceeded();
expect(result).toHaveOutput('greeting', 'Hello World');
```

> **Status: design + v0.1 specification complete; implementation pending.** This repository currently holds the full design and the build-ready v0.1 spec. The hardest pieces (the expression engine and the runner protocol) are **grounded against the GitHub runner's own source** with conformance corpora, not written from memory.

## Roadmap
v0.0 expressions → v0.1 composite → v0.2 node/JS → v0.3 docker → v0.4 workflows → v0.5+ future types. The unified `mock` / `run` / `expect` surface is stable across all of them (a new action type is a new executor, never new public API).

## Repository map
| Path | What |
|------|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The model: executors, orchestrators, fidelity, coverage, the deliberate boundary, risks |
| [docs/API.md](docs/API.md) | The public API surface (`actspec`, `run`, mocks, matchers, coverage, CLI) |
| [docs/CONVENTIONS.md](docs/CONVENTIONS.md) | How every module is built + Definition of Done + CI matrix |
| [docs/EXPRESSIONS.md](docs/EXPRESSIONS.md) | The `${{ }}` engine, grounded against the C# runner |
| [docs/PROTOCOL.md](docs/PROTOCOL.md) | The runner-file protocol + workflow commands, grounded against `@actions/toolkit` |
| [docs/CONTEXTS.md](docs/CONTEXTS.md) | `github`/`runner` context schemas + defaults; event payloads |
| [docs/DECISIONS.md](docs/DECISIONS.md) | The *why* behind key design decisions (rationale + rejected alternatives); the *what* is mirrored inline in the specs |
| [specs/](specs/) | Build specs — `versions/v0.1.md` (deep), `v0.2–v0.4` (stubs), `modules/*` (contracts) |
| [corpus/](corpus/) | Conformance corpora — `expressions/` (459 vectors, full harvest), `protocol/` |
| [fixtures/](fixtures/) | Canonical acceptance fixtures (start with `greet/`) |

## Building actspec (for the implementing agent)
1. **Step 0 — scaffold** a pnpm workspace per [CONVENTIONS](docs/CONVENTIONS.md): root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, changesets, lint/format, CI.
2. **Build in order** — follow the dependency DAG in [specs/versions/v0.1.md](specs/versions/v0.1.md): `expressions → core → composite → matchers → fixtures → coverage → cli`.
3. **First gate** — make the [walking skeleton](fixtures/greet/) pass end-to-end before fanning out.
4. Each module's contract + acceptance lives in [specs/modules/](specs/modules/); **a committed fixture/corpus outranks prose**.

## Not in scope
actspec is a *unit* tester, not an integration runner ([`act`](https://github.com/nektos/act) covers that) and not a linter ([`actionlint`](https://github.com/rhysd/actionlint) covers that). It does not reproduce the hosted-runner image or live backing services — those are mocked. See [ARCHITECTURE → Coverage boundary](docs/ARCHITECTURE.md#coverage-boundary).

## License
[MIT](LICENSE).
