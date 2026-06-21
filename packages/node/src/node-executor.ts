import { join } from 'node:path';
import {
  registerExecutor,
  evalExpression,
  applyMasks,
} from '@actharness/core';
import type { ActionExecutor, ExecutionCall, ExecutionResult } from '@actharness/core';
import type { StepResult, Annotation } from '@actharness/types';
import { _runInSandboxWithMocks } from './js-sandbox.js';
import { drainForNode } from '@actharness/network-mock';

// ── NodeExecutor ──────────────────────────────────────────────────────────────

export const nodeExecutor: ActionExecutor = {
  handles(using: string): boolean {
    return /^node\d+$/.test(using);
  },

  async execute(call: ExecutionCall): Promise<ExecutionResult> {
    const { action, context } = call;
    const actionDir = action._dir ?? '';
    const steps: StepResult[] = [];
    const allAnnotations: Annotation[] = [];
    const allJsCoverage: unknown[] = [];
    const allOutputs: Record<string, string> = {};
    const masks = new Set<string>();
    let allStdout = '';
    let allStderr = '';

    // Accumulated STATE_* values threaded across pre → main → post
    let state: Record<string, string> = {};

    // Drain network mocks once for this run (all phases share the same mock definitions)
    const drained = drainForNode();

    // base env comes from the context store (includes GITHUB_*, RUNNER_*, INPUT_* vars)
    const baseEnv: Record<string, string> = { ...context.env };

    async function runPhase(
      phase: 'pre' | 'main' | 'post',
      entrypointFile: string,
      evaluatedIf?: { expression: string; result: boolean },
    ): Promise<{ conclusion: 'success' | 'failure' }> {
      const stateEnv: Record<string, string> = {};
      for (const [key, value] of Object.entries(state)) {
        stateEnv[`STATE_${key}`] = value;
      }

      const phaseEnv: Record<string, string> = {
        ...baseEnv,
        ...stateEnv,
      };

      const resolvedFile = call.options?.nodeSource?.[entrypointFile] ?? entrypointFile;
      const result = await _runInSandboxWithMocks(
        { entrypoint: join(actionDir, resolvedFile), env: phaseEnv, cwd: context.github.workspace },
        drained,
      );

      // Thread state to the next phase
      state = { ...state, ...result.state };

      // Accumulate env writes back into the context store
      for (const [k, v] of Object.entries(result.envVars)) {
        context.env[k] = v;
      }

      // Accumulate masks and apply to streams
      for (const m of result.masks) masks.add(m);
      const maskedStdout = applyMasks(result.stdout, masks);
      const maskedStderr = applyMasks(result.stderr, masks);

      allStdout += maskedStdout;
      allStderr += maskedStderr;
      allAnnotations.push(...result.annotations);
      allJsCoverage.push(...result.jsCoverage);
      // All phases write to the same conceptual GITHUB_OUTPUT (last-write-wins per key)
      Object.assign(allOutputs, result.outputs);

      const conclusion: 'success' | 'failure' = result.exitCode === 0 ? 'success' : 'failure';

      steps.push({
        id: phase,
        name: phase,
        phase,
        ran: true,
        outcome: conclusion,
        conclusion,
        outputs: result.outputs,
        if: evaluatedIf,
        annotations: result.annotations,
        stdout: maskedStdout,
        stderr: maskedStderr,
      });

      return { conclusion };
    }

    function skipPhase(phase: 'pre' | 'post', evaluatedIf: { expression: string; result: boolean }): void {
      steps.push({
        id: phase,
        name: phase,
        phase,
        ran: false,
        outcome: 'skipped',
        conclusion: 'skipped',
        outputs: {},
        if: evaluatedIf,
        annotations: [],
        stdout: '',
        stderr: '',
      });
    }

    // ── pre phase ─────────────────────────────────────────────────────────────
    if (action.runs.pre) {
      const preIf = action.runs['pre-if'];
      let evaluatedIf: { expression: string; result: boolean } | undefined;
      if (preIf) {
        evaluatedIf = { expression: preIf, result: Boolean(evalExpression(preIf, context, action._file)) };
      }
      if (evaluatedIf && !evaluatedIf.result) {
        skipPhase('pre', evaluatedIf);
      } else {
        await runPhase('pre', action.runs.pre, evaluatedIf);
        // pre failure does not stop main (GitHub Actions behavior)
      }
    }

    // ── main phase ────────────────────────────────────────────────────────────
    if (!action.runs.main) {
      throw new Error(`Node action at '${action._dir}' has no 'runs.main' entrypoint`);
    }
    const mainResult = await runPhase('main', action.runs.main);

    // ── post phase ────────────────────────────────────────────────────────────
    if (action.runs.post) {
      const postIf = action.runs['post-if'];
      let evaluatedIf: { expression: string; result: boolean } | undefined;
      if (postIf) {
        evaluatedIf = { expression: postIf, result: Boolean(evalExpression(postIf, context, action._file)) };
      }
      if (evaluatedIf && !evaluatedIf.result) {
        skipPhase('post', evaluatedIf);
      } else {
        await runPhase('post', action.runs.post, evaluatedIf);
      }
    }

    return {
      conclusion: mainResult.conclusion,
      outputs: allOutputs,
      env: context.env,
      steps,
      annotations: allAnnotations,
      stdout: allStdout,
      stderr: allStderr,
      jsCoverage: allJsCoverage,
    };
  },
};

// ── Registration (side-effect on import) ─────────────────────────────────────

registerExecutor(nodeExecutor);
