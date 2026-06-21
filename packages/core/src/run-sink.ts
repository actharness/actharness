// Process-global run observation channel.
// Symbol.for survives the dual ESM/CJS module boundary within one worker.
// core notifies; @actharness/coverage subscribes — core never imports coverage.

import type { RunResult, PythonCoverageData } from '@actharness/types';

export interface RunResultMeta {
  sourceFile: string | undefined;
  inputsExercised?: Record<string, 'provided' | 'default'>;
  /** v0.2: raw V8 script coverage from the JsSandbox worker, keyed by source file path. */
  jsCoverage?: unknown;
  /** Shell coverage from composite run: steps. */
  shellCoverage?: Array<{ path: string; lineHits: Record<number, number> } | { path: string; pythonCoverageData: PythonCoverageData } | { path: string; nodeCoverageData: { path: string; v8Data: unknown }[] }> | undefined;
}

export type RunListener = (result: RunResult, meta: RunResultMeta) => void;

const SINK_KEY = Symbol.for('actharness.runSink');

type Global = typeof globalThis & { [key: symbol]: RunListener[] | undefined };

export function registerRunListener(fn: RunListener): void {
  const g = globalThis as Global;
  if (!g[SINK_KEY]) g[SINK_KEY] = [];
  g[SINK_KEY]!.push(fn);
}

export function notifyRunSink(result: RunResult, meta: RunResultMeta): void {
  const g = globalThis as Global;
  const listeners = g[SINK_KEY] ?? [];
  for (const fn of listeners) fn(result, meta);
}
