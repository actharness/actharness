/**
 * Node-sandbox spike — four scenarios validating H1–H7.
 *
 * Each describe block maps to one scenario from the spike spec.
 * The hypothesis tags (H1–H7) in test names are the exact spike gate items.
 */
import { describe, test, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { runAction } from '../src/runner.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const ACTIONS = join(__dir, '../actions');

// ── Scenario A — Baseline CJS ─────────────────────────────────────────────────

describe('Scenario A — Baseline CJS (H1, H2, H5)', () => {
  test('H2: INPUT_* env vars wired → @actions/core reads input, writes GITHUB_OUTPUT', async () => {
    const result = await runAction(join(ACTIONS, 'baseline'), {
      inputs: { greeting: 'Hello' },
    });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Hello World');
  });

  test('H5: explicit process.exit(1) does not kill test runner — conclusion is failure', async () => {
    // Empty greeting triggers process.exit(1) inside the action.
    const result = await runAction(join(ACTIONS, 'baseline'), {
      inputs: { greeting: '' },
    });
    // The test runner is still alive here — that IS the H5 validation.
    expect(result.conclusion).toBe('failure');
    expect(result.steps[0]!.exitCode).not.toBe(0);
  });

  test('H1: process.env isolation — two concurrent runs do not bleed INPUT_* into each other', async () => {
    const [r1, r2] = await Promise.all([
      runAction(join(ACTIONS, 'baseline'), { inputs: { greeting: 'Alpha' } }),
      runAction(join(ACTIONS, 'baseline'), { inputs: { greeting: 'Beta' } }),
    ]);
    expect(r1.outputs['message']).toBe('Alpha World');
    expect(r2.outputs['message']).toBe('Beta World');
  });

  test('H3: default input applied when input is omitted', async () => {
    // The action.yml default is "Hello"; omitting the input should use it.
    const result = await runAction(join(ACTIONS, 'baseline'), { inputs: {} });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['message']).toBe('Hello World');
  });
});

// ── Scenario B — ncc-bundled ──────────────────────────────────────────────────

describe('Scenario B — ncc-bundled (H4)', () => {
  test('H4: ncc bundle loads and executes — bundled require() resolves against bundle, not project node_modules', async () => {
    const result = await runAction(join(ACTIONS, 'bundled'), {
      inputs: { name: 'ncc' },
    });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, ncc!');
  });

  test('H4: ncc bundle uses action default when input omitted', async () => {
    const result = await runAction(join(ACTIONS, 'bundled'), { inputs: {} });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['greeting']).toBe('Hello, World!');
  });
});

// ── Scenario C — Octokit caller ───────────────────────────────────────────────

describe('Scenario C — Octokit caller (H6)', () => {
  test('H6: MockAgent intercepts @actions/github Octokit request inside the worker', async () => {
    const result = await runAction(join(ACTIONS, 'octokit'), {
      inputs: {
        token: 'ghs_fakefakefake',
        'issue-number': '42',
      },
      mockGitHubApi: {
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [
          { id: 1, body: 'First comment', user: { login: 'alice' } },
          { id: 2, body: 'Second comment', user: { login: 'bob' } },
        ],
      },
    });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['comment-count']).toBe('2');
  });

  test('H6: empty result list → comment-count of 0', async () => {
    const result = await runAction(join(ACTIONS, 'octokit'), {
      inputs: { token: 'ghs_fakefakefake', 'issue-number': '1' },
      mockGitHubApi: {
        'GET /repos/{owner}/{repo}/issues/{issue_number}/comments': [],
      },
    });
    expect(result.conclusion).toBe('success');
    expect(result.outputs['comment-count']).toBe('0');
  });
});

// ── Scenario D — pre/main/post lifecycle ──────────────────────────────────────

describe('Scenario D — pre/main/post lifecycle (H7)', () => {
  test('H7: pre → main → post run in order; GITHUB_STATE threads saveState to getState', async () => {
    const result = await runAction(join(ACTIONS, 'lifecycle'), {});

    expect(result.steps).toHaveLength(3);

    const pre  = result.steps.find(s => s.phase === 'pre')!;
    const main = result.steps.find(s => s.phase === 'main')!;
    const post = result.steps.find(s => s.phase === 'post')!;

    expect(pre).toBeDefined();
    expect(main).toBeDefined();
    expect(post).toBeDefined();

    expect(pre.conclusion).toBe('success');
    expect(main.conclusion).toBe('success');
    expect(post.conclusion).toBe('success');

    // Main confirms it ran.
    expect(main.outputs['main-ran']).toBe('true');

    // Post proves it received state written by pre.
    expect(post.outputs['cache-hit']).toBe('true');
  });

  test('H7: overall conclusion is success when all phases succeed', async () => {
    const result = await runAction(join(ACTIONS, 'lifecycle'), {});
    expect(result.conclusion).toBe('success');
  });
});
