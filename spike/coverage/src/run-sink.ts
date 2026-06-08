// D1: process-global run sink — core notifies, coverage subscribes.
// Keyed by Symbol.for so it survives ESM/CJS dual-package boundary within one worker.

import type { FileCoverageData } from 'istanbul-lib-coverage';
import type { RunResult, JobResult } from './types.js';

export type ActionRunPayload = {
  kind: 'action';
  result: RunResult;
  sourceFile: string;
  actionDir: string;
  jsLineCoverage?: FileCoverageData[];
};

export type WorkflowJobPayload = {
  kind: 'job';
  sourceFile: string;
  jobId: string;
  ran: boolean;
  outcome: JobResult['outcome'];
};

export type RunSinkPayload = ActionRunPayload | WorkflowJobPayload;

export type RunListener = (payload: RunSinkPayload) => void;

const SINK_KEY = Symbol.for('actspec.runSink');

export function registerRunListener(fn: RunListener): void {
  const g = globalThis as Record<symbol, RunListener[]>;
  if (!g[SINK_KEY]) g[SINK_KEY] = [];
  g[SINK_KEY].push(fn);
}

export function notifyRunSink(payload: RunSinkPayload): void {
  const g = globalThis as Record<symbol, RunListener[] | undefined>;
  const listeners = g[SINK_KEY] ?? [];
  for (const fn of listeners) fn(payload);
}
