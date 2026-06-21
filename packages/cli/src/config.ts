// actharness.config.ts / .js / .json loader.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ActharnessConfig {
  coverage?: boolean;
  reporters?: string[];
  coverageDir?: string;
  thresholds?: Record<string, number>;
  patterns?: string[];
  workers?: number;
}

export async function loadConfig(cwd: string): Promise<ActharnessConfig> {
  // JSON — no loader needed
  const jsonPath = join(cwd, 'actharness.config.json');
  if (existsSync(jsonPath)) {
    try {
      return JSON.parse(readFileSync(jsonPath, 'utf8')) as ActharnessConfig;
    } catch {
      return {};
    }
  }

  // TS → tsx/esm/api; JS → native import()
  for (const name of ['actharness.config.ts', 'actharness.config.js']) {
    const configPath = join(cwd, name);
    if (!existsSync(configPath)) continue;
    try {
      let mod: unknown;
      if (name.endsWith('.ts')) {
        const { tsImport } = await import('tsx/esm/api');
        mod = await tsImport(pathToFileURL(configPath).href, import.meta.url);
      } else {
        mod = await import(pathToFileURL(configPath).href);
      }
      const raw = mod as Record<string, unknown>;
      return ((raw['default'] ?? raw) as ActharnessConfig);
    } catch {
      return {};
    }
  }

  return {};
}
