export interface RunnerBridgeArgs {
  files: string[];
  pattern?: string;
  registerUrl: string;
  tsxEsmUrl: string;
}

export function parseRunnerBridgeArgs(argv: string[]): RunnerBridgeArgs {
  const files: string[] = [];
  let pattern: string | undefined;
  let registerUrl = '';
  let tsxEsmUrl = '';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--files' && i + 1 < argv.length) {
      files.push(...argv[++i]!.split(',').filter(Boolean));
    } else if (arg === '--pattern' && i + 1 < argv.length) {
      pattern = argv[++i]!;
    } else if (arg === '--register-url' && i + 1 < argv.length) {
      registerUrl = argv[++i]!;
    } else if (arg === '--tsx-esm-url' && i + 1 < argv.length) {
      tsxEsmUrl = argv[++i]!;
    }
  }

  return { files, ...(pattern !== undefined && { pattern }), registerUrl, tsxEsmUrl };
}
