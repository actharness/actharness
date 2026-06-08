---
"@actspec/expressions": minor
---

Initial release of `@actspec/expressions` — a standalone, zero-runtime-dependency implementation of the GitHub Actions `${{ }}` expression language.

- Full Pratt parser and evaluator for all six expression types (null, boolean, number, string, array, object)
- All built-in functions: `contains`, `startsWith`, `endsWith`, `format`, `join`, `toJSON`, `fromJSON`, `hashFiles`
- `hashFiles` implemented with real SHA-256 glob matching (Node built-ins only); overridable via `ctx.functions` for deterministic tests
- Dual ESM/CJS build; verified with `@arethetypeswrong`
- 443-vector conformance corpus green; parser/eval fuzz (fast-check) in CI
- API Extractor snapshot committed; breaking-surface CI check in place
- 100% statement, branch, function, and line coverage
