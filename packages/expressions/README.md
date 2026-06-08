# @actspec/expressions

Standalone JavaScript implementation of the [GitHub Actions `${{ }}`expression language](https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/evaluate-expressions-in-workflows-and-actions). Zero runtime dependencies.

## Install

```sh
npm install @actspec/expressions
```

## Usage

### Evaluate an expression

```ts
import { evaluate } from '@actspec/expressions';

evaluate('1 + 1');                          // 2  (number)
evaluate('true && null');                   // null
evaluate("contains('hello world', 'llo')"); // true
evaluate("format('Hello {0}!', 'world')"); // 'Hello world!'
```

### Evaluate a template string

A template may embed one or more `${{ }}` blocks in surrounding text. A template that is *exactly* one expression block preserves the expression's type; mixed templates coerce to string.

```ts
import { evaluateTemplate } from '@actspec/expressions';

evaluateTemplate('${{ true }}');                     // true  (boolean preserved)
evaluateTemplate('Result: ${{ 1 + 1 }}');            // 'Result: 2'
evaluateTemplate('Hello ${{ inputs.name }}!', {
  inputs: { name: 'world' },
});                                                  // 'Hello world!'
```

### Provide context

```ts
import { evaluate } from '@actspec/expressions';

evaluate('github.event_name == \'push\'', {
  github: { event_name: 'push' },
});
// true
```

### Error handling

```ts
import { evaluate, ExpressionError } from '@actspec/expressions';

try {
  evaluate('unknownFunc()');
} catch (err) {
  if (err instanceof ExpressionError) {
    console.error(err.message); // "Unknown function 'unknownFunc'"
  }
}
```

### hashFiles

`hashFiles` is the real implementation: it globs under `GITHUB_WORKSPACE` (or `process.cwd()`), SHA-256s each matched file, and returns the combined digest as a lowercase hex string. Override it per-call for deterministic tests:

```ts
import { evaluate } from '@actspec/expressions';

// Real implementation — reads from GITHUB_WORKSPACE
evaluate("hashFiles('**/*.lock')");

// Deterministic override in tests
evaluate("hashFiles('**/*.lock')", {
  functions: { hashfiles: () => 'abc123' },
});
```

### Lower-level access

```ts
import { tokenize, parse } from '@actspec/expressions';

const tokens = tokenize('1 + 2');
const ast    = parse(tokens);
```

## Conformance

Tested against a 443-vector corpus derived from `nektos/act`'s expression test suite, plus fast-check property fuzz tests. Matches the C# `actions/runner` behavior for all known divergences.

## License

MIT
