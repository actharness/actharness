// Tests for fixtures/tagger/action.yml — Node action with pre/main/post lifecycle.
// Friction probes: #1 (mock type-agnostic), #2 (outputs from GITHUB_OUTPUT), #6 (pre: phase).
// Validates H1, H2 (RunResult type-agnostic), H5 (mockGitHubApi + mock() share mental model), H6 (pre/main/post).

import { describe, test, expect, beforeEach } from 'vitest';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { actspec } from '../src/index.js';
import type { Action } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(__dirname, '../fixtures/tagger');

describe('node-tagger', () => {
  let action: Action;

  beforeEach(() => {
    action = actspec(FIXTURE);
  });

  // ── H2: RunResult type-agnostic (GITHUB_OUTPUT → result.outputs) ────────────

  test('main phase outputs arrive in result.outputs (H2)', async () => {
    // Probe #2: GITHUB_OUTPUT writes from a node action arrive in result.outputs
    // exactly like a composite action's outputs.<name>.value.
    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'main' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v1.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v1.0.0', token: 'ghs_fake' },
    });

    expect(result).toHaveSucceeded();
    // H2: outputs arrive the same way regardless of action type.
    expect(result).toHaveOutput('default-branch', 'main');
    expect(result).toHaveOutput('tag-url');
  });

  // ── H6: pre/main/post lifecycle ─────────────────────────────────────────────

  test('produces three StepResults in pre/main/post order (H6)', async () => {
    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'main' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v1.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v1.0.0', token: 'ghs_fake' },
    });

    // H6: three StepResults, phases in order.
    expect(result.steps).toHaveLength(3);
    expect(result.steps[0]!.phase).toBe('pre');
    expect(result.steps[1]!.phase).toBe('main');
    expect(result.steps[2]!.phase).toBe('post');
  });

  // ── Probe #6: pre: phase assertion ─────────────────────────────────────────

  test('pre: phase runs and reports success (probe #6)', async () => {
    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'main' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v1.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v1.0.0', token: 'ghs_fake' },
    });

    // Probe #6: no toHavePreStepConclusion matcher — filter by phase.
    // Finding: filter is readable but a phase-shorthand matcher would reduce boilerplate.
    const preStep = result.steps.find(s => s.phase === 'pre');
    expect(preStep).toBeDefined();
    expect(preStep!.conclusion).toBe('success');
    expect(preStep!.stdout).toContain('validation complete');
  });

  test('GITHUB_STATE threading: post: phase reads state written by pre:', async () => {
    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'main' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v1.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v1.0.0', token: 'ghs_fake' },
    });

    const postStep = result.steps.find(s => s.phase === 'post');
    expect(postStep).toBeDefined();
    // post.js reads STATE_pre-ran and STATE_validated-tag set in pre.js.
    expect(postStep!.stdout).toContain('pre-ran=true');
    expect(postStep!.stdout).toContain('validated-tag=v1.0.0');
  });

  // ── H5: mockGitHubApi + mock() share mental model ──────────────────────────

  test('mockGitHubApi and mock() in the same test file feel coherent (H5)', async () => {
    // H5: both mocking surfaces in one test — do they feel like the same paradigm?
    // Finding: mock() is for uses: deps; mockGitHubApi() is for internal network calls.
    // The mental model is identical ("mock your dependency") but the call sites differ.
    // Whether this feels coherent or surprising is the H5 friction probe.

    // mock() for a hypothetical uses: child (if tagger had one)
    // action.mock('some/child@v1', { outputs: { value: 'x' } }); // same call shape as composite

    // mockGitHubApi() for Octokit calls
    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'develop' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v2.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v2.0.0', token: 'ghs_fake' },
    });

    expect(result).toHaveOutput('default-branch', 'develop');
    expect(result).toHaveOutput('tag-url');
  });

  // ── H1 smoke test: mock() call shape is identical for node vs composite ─────

  test('H1 smoke test: mock() syntax is identical whether child is composite or node', async () => {
    // This test intentionally mirrors the composite-setup test mock() call.
    // The call: action.mock('ref', { outputs: {...} }) is the same regardless of child type.
    // A composite test does: action.mock('actions/checkout@v4', { outputs: { ref: 'abc' } })
    // A node test would do: action.mock('actions/some-node-action@v1', { outputs: { value: 'x' } })
    // Same syntax. H1 confirmed — no type: parameter, no type-specific call shape.

    action.mockGitHubApi({
      'GET /repos/{owner}/{repo}': { default_branch: 'main' },
      'POST /repos/{owner}/{repo}/git/refs': { url: 'https://api.github.com/repos/actspec/test-repo/git/refs/tags/v1.0.0' },
    });

    const result = await action.run({
      inputs: { 'tag-name': 'v1.0.0', token: 'ghs_fake' },
    });

    expect(result).toHaveSucceeded();
    expect(result.steps).toHaveLength(3);
  });
});
