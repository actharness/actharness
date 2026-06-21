import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  format: ['cjs'],
  dts: false,
  clean: true,
  sourcemap: true,
  target: 'node22',
  external: ['vscode'],
  noExternal: ['typescript'],
});
