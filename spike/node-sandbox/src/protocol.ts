import { mkdtempSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface ProtocolFiles {
  output: string;
  env: string;
  state: string;
  path: string;
  summary: string;
  dir: string;
}

export function allocateProtocolFiles(): ProtocolFiles {
  const dir = mkdtempSync(join(tmpdir(), 'actspec-sandbox-'));
  const output = join(dir, 'output');
  const env = join(dir, 'env');
  const state = join(dir, 'state');
  const path = join(dir, 'path');
  const summary = join(dir, 'summary');
  for (const f of [output, env, state, path, summary]) writeFileSync(f, '');
  return { output, env, state, path, summary, dir };
}

// Parses the name=value / name<<DELIM heredoc format used by @actions/core.
export function parseProtocolFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  const content = readFileSync(filePath, 'utf8');
  if (!content.trim()) return result;

  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line) { i++; continue; }

    const heredocMatch = line.match(/^([^<]+)<<(.+)$/);
    if (heredocMatch) {
      const name = heredocMatch[1]!;
      const delim = heredocMatch[2]!;
      const valueLines: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delim) {
        valueLines.push(lines[i]!);
        i++;
      }
      result[name] = valueLines.join('\n');
      i++;
      continue;
    }

    const eqIdx = line.indexOf('=');
    if (eqIdx > 0) {
      result[line.slice(0, eqIdx)] = line.slice(eqIdx + 1);
    }
    i++;
  }
  return result;
}

// Parse ::level [params]::message workflow commands from captured stdout.
export function parseAnnotations(stdout: string): Array<{ level: string; message: string }> {
  const annotations: Array<{ level: string; message: string }> = [];
  const cmdRe = /^::(error|warning|notice|debug)[^:]*::(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(stdout)) !== null) {
    annotations.push({ level: m[1]!, message: m[2]! });
  }
  return annotations;
}
