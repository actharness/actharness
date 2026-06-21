// Parses action.yml / action.yaml into the ParsedAction model.
// Uses the `yaml` library (eemeli) with keepSourceTokens for line/col ranges.

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { parseDocument } from 'yaml';
import type { YAMLMap, Scalar, Node, ParsedNode } from 'yaml';
import type {
  ParsedAction,
  ParsedActionRuns,
  ParsedInput,
  ParsedOutput,
  ParsedStep,
  NodeRange,
} from '@actharness/types';
import { ParseError, ConfigError } from './errors.js';

// ── Range extraction ──────────────────────────────────────────────────────────

function nodeRange(node: Node | ParsedNode): NodeRange {
  const r = node.range!;
  return { start: r[0], end: r[1] };
}

export function scalarRange(map: YAMLMap, key: string): NodeRange | undefined {
  const raw = map.get(key, true) as unknown;
  if (raw && (raw as { range?: [number, number, number] }).range) {
    return nodeRange(raw as Node);
  }
  return undefined;
}

// ── Scalar helpers ────────────────────────────────────────────────────────────

function str(map: YAMLMap, key: string): string | undefined {
  const v = map.get(key);
  if (v === undefined || v === null) return undefined;
  return String(v);
}

function bool(map: YAMLMap, key: string): boolean | undefined {
  const v = map.get(key);
  if (v === undefined || v === null) return undefined;
  return Boolean(v);
}

export function strRecord(map: YAMLMap, key: string): Record<string, string> | undefined {
  const sub = map.get(key, true) as unknown as YAMLMap | null;
  if (!sub || !(sub instanceof Object) || !('items' in sub)) return undefined;
  const result: Record<string, string> = {};
  for (const pair of sub.items as { key: Scalar; value: Scalar }[]) {
    if (pair.key && pair.value !== undefined && pair.value !== null) {
      result[String(pair.key.value)] = String(pair.value.value ?? '');
    }
  }
  return result;
}

// ── Inputs ────────────────────────────────────────────────────────────────────

export function parseInputs(
  inputsNode: YAMLMap | null | undefined,
): Record<string, ParsedInput> | undefined {
  if (!inputsNode) return undefined;
  const result: Record<string, ParsedInput> = {};
  for (const pair of inputsNode.items as { key: Scalar; value: YAMLMap | null }[]) {
    const name = String(pair.key.value);
    const def = pair.value;
    if (!def || !('get' in def)) {
      result[name] = {};
      continue;
    }
    const inp: ParsedInput = {};
    const desc = str(def, 'description');
    if (desc !== undefined) inp.description = desc;
    const req = bool(def, 'required');
    if (req !== undefined) inp.required = req;
    const dflt = def.get('default');
    if (dflt !== undefined && dflt !== null) inp.default = String(dflt);
    const dep = str(def, 'deprecationMessage');
    if (dep !== undefined) inp.deprecationMessage = dep;
    const keyNode = pair.key as unknown as { range?: [number, number, number] };
    const valNode = pair.value as unknown as { range?: [number, number, number] };
    if (keyNode.range && valNode.range) {
      inp._range = { start: keyNode.range[0], end: valNode.range[1] };
    }
    result[name] = inp;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Outputs ───────────────────────────────────────────────────────────────────

function parseOutputs(
  outputsNode: YAMLMap | null | undefined,
  _sourceText: string,
): Record<string, ParsedOutput> | undefined {
  if (!outputsNode) return undefined;
  const result: Record<string, ParsedOutput> = {};
  for (const pair of outputsNode.items as { key: Scalar; value: YAMLMap | null }[]) {
    const name = String(pair.key.value);
    const def = pair.value;
    const out: ParsedOutput = {};
    out._range = nodeRange(pair.value as unknown as Node);
    if (def && 'get' in def) {
      const desc = str(def, 'description');
      if (desc !== undefined) out.description = desc;
      const val = str(def, 'value');
      if (val !== undefined) out.value = val;
    }
    result[name] = out;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// ── Steps ─────────────────────────────────────────────────────────────────────

function parseSteps(
  runsNode: YAMLMap,
): ParsedStep[] {
  const stepsNode = runsNode.get('steps', true) as unknown;
  if (!stepsNode || !Array.isArray((stepsNode as { items?: unknown }).items)) return [];

  const steps: ParsedStep[] = [];
  for (const item of (stepsNode as { items: { value: YAMLMap; range?: [number, number, number] }[] }).items) {
    const stepMap = item.value ?? item;
    if (!stepMap || !('get' in stepMap)) continue;

    const step: ParsedStep = {};

    const id = str(stepMap as YAMLMap, 'id');
    if (id !== undefined) step.id = id;
    const name = str(stepMap as YAMLMap, 'name');
    if (name !== undefined) step.name = name;
    const ifExpr = str(stepMap as YAMLMap, 'if');
    if (ifExpr !== undefined) step.if = ifExpr;
    const uses = str(stepMap as YAMLMap, 'uses');
    if (uses !== undefined) step.uses = uses;
    const run = str(stepMap as YAMLMap, 'run');
    if (run !== undefined) step.run = run;
    const shell = str(stepMap as YAMLMap, 'shell');
    if (shell !== undefined) step.shell = shell;
    const wd = str(stepMap as YAMLMap, 'working-directory');
    if (wd !== undefined) step['working-directory'] = wd;

    const coe = (stepMap as YAMLMap).get('continue-on-error');
    if (coe !== undefined && coe !== null) {
      step['continue-on-error'] = typeof coe === 'string' ? coe : Boolean(coe);
    }

    const timeout = (stepMap as YAMLMap).get('timeout-minutes');
    if (timeout !== undefined && timeout !== null) {
      step['timeout-minutes'] = Number(timeout);
    }

    const withNode = strRecord(stepMap as YAMLMap, 'with');
    if (withNode) step.with = withNode;

    const envNode = strRecord(stepMap as YAMLMap, 'env');
    if (envNode) step.env = envNode;

    step._range = nodeRange(stepMap as unknown as Node);

    const ifRawNode = (stepMap as YAMLMap).get('if', true) as unknown;
    if (ifRawNode && (ifRawNode as { range?: [number, number, number] }).range) {
      step._ifRange = nodeRange(ifRawNode as Node);
    }

    steps.push(step);
  }
  return steps;
}

// ── Runs ──────────────────────────────────────────────────────────────────────

function parseRuns(runsNode: YAMLMap, filePath: string): ParsedActionRuns {
  const using = str(runsNode, 'using');
  if (!using) {
    throw new ParseError(`Missing required 'runs.using' in: ${filePath}`);
  }

  const runs: ParsedActionRuns = { using };

  if (using === 'composite') {
    runs.steps = parseSteps(runsNode);
  } else if (using === 'docker') {
    throw new ConfigError(
      `'runs.using: docker' (Docker executor) is planned for actharness v0.3 — ` +
      `only 'composite' is supported in v0.1`,
    );
  }

  const pre = str(runsNode, 'pre');
  if (pre !== undefined) {
    runs.pre = pre;
    runs._preRange = scalarRange(runsNode, 'pre');
  }
  const preIf = str(runsNode, 'pre-if');
  if (preIf !== undefined) {
    runs['pre-if'] = preIf;
    runs._preIfRange = scalarRange(runsNode, 'pre-if');
  }
  const main = str(runsNode, 'main');
  if (main !== undefined) {
    runs.main = main;
    runs._mainRange = scalarRange(runsNode, 'main');
  }
  const post = str(runsNode, 'post');
  if (post !== undefined) {
    runs.post = post;
    runs._postRange = scalarRange(runsNode, 'post');
  }
  const postIf = str(runsNode, 'post-if');
  if (postIf !== undefined) {
    runs['post-if'] = postIf;
    runs._postIfRange = scalarRange(runsNode, 'post-if');
  }
  const image = str(runsNode, 'image');
  if (image !== undefined) runs.image = image;

  return runs;
}

// ── Public API ────────────────────────────────────────────────────────────────

export function parseAction(source: string): ParsedAction {
  let filePath: string;
  let actionDir: string;

  if (source.endsWith('.yml') || source.endsWith('.yaml')) {
    filePath = resolve(source);
    actionDir = dirname(filePath);
  } else {
    const dir = resolve(source);
    const ymlPath = join(dir, 'action.yml');
    const yamlPath = join(dir, 'action.yaml');
    if (existsSync(ymlPath)) {
      filePath = ymlPath;
    } else if (existsSync(yamlPath)) {
      filePath = yamlPath;
    } else {
      throw new ParseError(`No action.yml or action.yaml found in: ${dir}`);
    }
    actionDir = dir;
  }

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    throw new ParseError(`Cannot read action file: ${filePath}`);
  }

  return parseActionYaml(raw, filePath, actionDir);
}

export function parseActionYaml(
  source: string,
  filePath: string,
  actionDir: string,
): ParsedAction {
  const doc = parseDocument(source, { keepSourceTokens: true });

  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const pos = (err as unknown as { pos: readonly [number, number] }).pos;
    throw new ParseError(
      `YAML parse error in ${filePath}: ${err.message}`,
      { file: filePath, line: 0, col: pos[0] },
    );
  }

  const root = doc.contents as YAMLMap | null;
  if (!root || !('get' in root)) {
    throw new ParseError(`Empty or invalid action file: ${filePath}`);
  }

  const name = str(root, 'name') ?? '';
  const description = str(root, 'description');

  const inputsNode = root.get('inputs', true) as YAMLMap | null | undefined;
  const inputs = parseInputs(inputsNode);

  const outputsNode = root.get('outputs', true) as YAMLMap | null | undefined;
  const outputs = parseOutputs(outputsNode, source);

  const runsNode = root.get('runs', true) as YAMLMap | null | undefined;
  if (!runsNode || !('get' in runsNode)) {
    throw new ParseError(`Missing required 'runs' field in: ${filePath}`);
  }

  const runs = parseRuns(runsNode, filePath);

  const action: ParsedAction = {
    name,
    runs,
    _file: filePath,
    _dir: actionDir,
  };
  if (description !== undefined) action.description = description;
  if (inputs) action.inputs = inputs;
  if (outputs) action.outputs = outputs;

  return action;
}
