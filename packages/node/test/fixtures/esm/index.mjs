import { readFileSync, writeFileSync } from 'node:fs';

// Minimal ESM action using only Node.js builtins — no @actions/core dependency.
// Uses GITHUB_OUTPUT file directly to emit outputs.

const name = process.env['INPUT_NAME'] ?? 'World';
const greeting = `Hello, ${name}!`;

const outputFile = process.env['GITHUB_OUTPUT'];
if (outputFile) {
  writeFileSync(outputFile, `greeting=${greeting}\n`, { flag: 'a' });
}

process.stdout.write(`${greeting}\n`);
