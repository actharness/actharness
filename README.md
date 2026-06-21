<div align="center">
  <img src="icon.png" width="96" alt="actharness">
  <h1>actharness</h1>
  <p>Unit testing for GitHub Actions.</p>
  <a href="https://www.npmjs.com/package/actharness"><img src="https://img.shields.io/npm/v/actharness?color=3fb950&label=npm" alt="npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-3fb950" alt="license"></a>
</div>

<br>

Test composite actions locally, hermetically, with no real GitHub runner and no network. Mock external `uses:` calls, simulate the runner protocol (`$GITHUB_OUTPUT`, `$GITHUB_ENV`, …), evaluate `${{ }}` expressions, and assert on step results — all behind one unified API.

## Install

```bash
npm install --save-dev actharness
```

## Quick start

```yaml
# action.yml
name: Greet
inputs:
  name:
    default: nobody
outputs:
  greeting:
    value: ${{ steps.hello.outputs.greeting }}
runs:
  using: composite
  steps:
    - id: hello
      shell: bash
      run: echo "greeting=Hello ${{ inputs.name }}" >> "$GITHUB_OUTPUT"
```

```ts
// action.test.ts — no imports needed when running via `actharness test`

describe('greet action', () => {
  test('greets by name', async () => {
    const result = await actharness('./action.yml').run({ inputs: { name: 'World' } });

    expect(result).toHaveSucceeded();
    expect(result).toHaveOutput('greeting', 'Hello World');
  });

  test('applies input default', async () => {
    const result = await actharness('./action.yml').run();

    expect(result).toHaveOutput('greeting', 'Hello nobody');
  });
});
```

```bash
npx actharness test
```

## Mocking

Mock any `uses:` step by ref before running. The mock returns the declared outputs and records the `with:` it was called with.

```ts
describe('release action', () => {
  test('mocks a uses: step', async () => {
    const checkout = actharness.mock('actions/checkout@v4', { outputs: { ref: 'abc123' } });

    const result = await actharness('./action.yml').run({ inputs: { name: 'World' } });

    expect(result).toHaveSucceeded();
    expect(checkout).toHaveBeenCalledWith({ ref: 'main' });
  });
});
```

Use `mockOnce` to override exactly one invocation, then fall back to the persistent mock (or to unmocked behaviour if none is registered):

```ts
actharness.mock('actions/checkout@v4', { outputs: { ref: 'main' } });
actharness.mockOnce('actions/checkout@v4', { outputs: { ref: 'feature' } }); // first call only
```

Network calls inside JS and shell steps are intercepted via `mockNetwork` / `mockGitHubApi` (and their `*Once` siblings). `actharness.resetMocks()` clears all mocks and once-queues — call it in `afterEach`.

## Matchers

### Result matchers

```ts
expect(result).toHaveSucceeded()
expect(result).toHaveFailed()
expect(result).toHaveOutput(name, value)
expect(result).toHaveStep(id)                        // ran (not skipped)
expect(result).toHaveStepSucceeded(id)
expect(result).toHaveStepFailed(id)
expect(result).toHaveStepSkipped(id)
expect(result).toHaveStepOutput(id, name, value)
expect(result).toHaveAnnotation({ level?, message? })
```

### Step matchers

Pass `result.step('id')` directly — if the step is absent, all matchers throw `"Expected step to exist, but step was not found"`.

```ts
expect(result.step('build')).toHaveSucceeded()
expect(result.step('build')).toHaveFailed()
expect(result.step('build')).toHaveOutput(name, value)
expect(result.step('build')).toHaveAnnotation({ level?, message? })
expect(result.step('build')).toHaveStdoutContaining(substring)
expect(result.step('build')).toHaveStderrContaining(substring)
```

### Mock matchers

```ts
expect(checkout).toHaveBeenCalled()
expect(checkout).toHaveBeenCalledTimes(2)
expect(checkout).toHaveBeenCalledWith({ ref: 'main' })
```

All matchers support `.not` negation.

## Context and event fixtures

```ts
import { actharness, github, pushEvent } from 'actharness';

describe('context', () => {
  test('uses push event context', async () => {
    const result = await actharness('./action.yml').run({
      inputs: { name: 'World' },
      github: github({ event_name: 'push', repository: 'my-org/my-action' }),
      eventPayload: pushEvent({ ref: 'refs/heads/main' }),
    });

    expect(result).toHaveSucceeded();
  });
});
```

## Coverage

```bash
npx actharness test --coverage
npx actharness test --coverage --threshold steps=100 --threshold ifBranches=80
npx actharness test --coverage --threshold bashShellLines=80 --threshold jsLines=90
```

Emits Istanbul-compatible reports. Supported reporters: `text`, `text-summary`, `lcov`, `lcovonly`, `html`, `html-spa`, `json`, `json-summary`, `cobertura`, `clover`, `teamcity`, `none`. Coverage tracks which steps ran, which were skipped, and how each `if:` branch resolved.

## CLI

```bash
npx actharness test [pattern] [--coverage] [--reporter <name>] [--coverage-dir <dir>] [--threshold k=n] [--workers <n>]
npx actharness run <action.yml> [--input k=v] [--mock ref='{"outputs":{}}'] [--json]
npx actharness init <action.yml>   # scaffold action.test.ts
```

## Config file

Create `actharness.config.ts` (or `.js` / `.json`) in your project root to set defaults. CLI flags always override config.

```ts
// actharness.config.ts
export default {
  coverage: true,
  reporters: ['lcov', 'html', 'text'],
  coverageDir: 'coverage',
  workers: 4,
  thresholds: {
    // action
    steps: 100,
    ifBranches: 80,
    // shell
    shShellLines: 80,
    bashShellLines: 80,
    pwshShellLines: 80,
    pythonShellLines: 80,
    nodeShellLines: 80,
    // node .js files
    jsLines: 90,
  },
  patterns: ['**/*.test.ts'],
};
```

## Packages

| Package | Role |
| --- | --- |
| `actharness` | Meta-package — re-exports core, matchers, fixtures, composite, node |
| `@actharness/cli` | `actharness test`, `actharness run`, `actharness init` |
| `@actharness/core` | Parser, executor registry, mock resolver, run sink |
| `@actharness/composite` | Composite executor — step loop, `uses:` dispatch, env-file threading |
| `@actharness/shell` | Shell sandbox — bash, sh, pwsh, python, node subprocess execution |
| `@actharness/node` | Node executor — `runs.using: node<N>` actions |
| `@actharness/network-mock` | `mockNetwork` / `mockGitHubApi` (and `*Once` siblings) — proxy path for shells, IPC path for node |
| `@actharness/matchers` | `expect()` + result/step/mock matchers |
| `@actharness/fixtures` | GitHub context and event factories |
| `@actharness/coverage` | Istanbul-compatible step/branch/input coverage |
| `@actharness/expressions` | `${{ }}` expression evaluator |
| `@actharness/types` | Shared TypeScript interfaces |
| `@actharness/vscode` | VSCode extension — test explorer integration (ships via marketplace, not npm) |

## Not in scope

actharness is a *unit* tester — it does not boot a real runner or network. For full workflow integration testing, see [`act`](https://github.com/nektos/act). For linting, see [`actionlint`](https://github.com/rhysd/actionlint).

## License

[MIT](LICENSE).
