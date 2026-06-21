// @actharness/shell — ShellSandbox, the run:/shell: step executor.
// Used by @actharness/composite today; intended to be shared with workflow-level
// testing once that lands, since shell semantics are identical in both contexts.

export { ShellSandbox } from './shell-sandbox.js';
export { parsePythonCoverageJson } from './python-coverage.js';
export type { PythonCoverageData } from './python-coverage.js';
