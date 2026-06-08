// D2: extract per-step and per-job line ranges from the YAML CST (eemeli/yaml).
// Ranges are 1-based, matching Istanbul's StatementMap format.

import { parseDocument } from 'yaml';
import type { YAMLMap, YAMLSeq } from 'yaml';
import { readFileSync } from 'fs';

export interface StepRange {
  id: string;
  startLine: number;
  endLine: number;
  hasIf: boolean;
}

export interface JobRange {
  id: string;
  startLine: number;
  endLine: number;
}

function offsetToLine(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

export function extractStepRanges(yamlSource: string): StepRange[] {
  const doc = parseDocument(yamlSource, { keepSourceTokens: true });
  const root = doc.contents as YAMLMap | null;
  if (!root) return [];

  const runsNode = root.get('runs', true) as unknown as YAMLMap | null;
  if (!runsNode) return [];

  const stepsNode = runsNode.get('steps', true) as unknown as YAMLSeq | null;
  if (!stepsNode) return [];

  const ranges: StepRange[] = [];
  let stepIndex = 0;

  for (const item of stepsNode.items) {
    const step = item as YAMLMap;
    const id = (step.get('id') as string | null) ?? `step-${stepIndex}`;
    const hasIf = step.has('if');

    if (step.range) {
      const startLine = offsetToLine(yamlSource, step.range[0]);
      // range[1] is end of the node value; use it for end line.
      const endLine = offsetToLine(yamlSource, step.range[1] - 1);
      ranges.push({ id, startLine, endLine: Math.max(startLine, endLine), hasIf });
    } else {
      // Fallback: no range available (shouldn't happen with keepSourceTokens).
      ranges.push({ id, startLine: stepIndex + 1, endLine: stepIndex + 1, hasIf });
    }

    stepIndex++;
  }

  return ranges;
}

export function extractJobRanges(yamlSource: string): JobRange[] {
  const doc = parseDocument(yamlSource, { keepSourceTokens: true });
  const root = doc.contents as YAMLMap | null;
  if (!root) return [];

  const jobsNode = root.get('jobs', true) as unknown as YAMLMap | null;
  if (!jobsNode) return [];

  const ranges: JobRange[] = [];

  for (const pair of jobsNode.items) {
    const p = pair as { key: unknown; value: unknown };
    const id = String(p.key);
    const jobNode = p.value as YAMLMap & { range?: number[] };

    if (jobNode?.range) {
      const startLine = offsetToLine(yamlSource, jobNode.range[0]);
      const endLine = offsetToLine(yamlSource, jobNode.range[1] - 1);
      ranges.push({ id, startLine, endLine: Math.max(startLine, endLine) });
    } else {
      ranges.push({ id, startLine: ranges.length + 1, endLine: ranges.length + 1 });
    }
  }

  return ranges;
}

export function loadYamlSource(sourceFile: string): string {
  return readFileSync(sourceFile, 'utf8');
}
