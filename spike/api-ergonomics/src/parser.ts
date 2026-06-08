// Parses action.yml and workflow.yml files.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import type { ParsedAction, ParsedWorkflow } from './types.js';

export function parseAction(source: string): ParsedAction {
  let filePath = source;
  if (!source.endsWith('.yml') && !source.endsWith('.yaml')) {
    const yml = join(source, 'action.yml');
    const yaml = join(source, 'action.yaml');
    filePath = existsSync(yml) ? yml : yaml;
  }
  const raw = parse(readFileSync(filePath, 'utf8')) as ParsedAction;
  return raw;
}

export function parseWorkflow(filePath: string): ParsedWorkflow {
  const raw = parse(readFileSync(filePath, 'utf8')) as ParsedWorkflow;
  return raw;
}

export function resolveActionDir(source: string): string {
  if (source.endsWith('.yml') || source.endsWith('.yaml')) {
    return source.replace(/\/action\.ya?ml$/, '');
  }
  return source;
}
