import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    dts: false,
    clean: true,
    sourcemap: true,
    target: 'node22',
    banner: { js: '#!/usr/bin/env node' },
  },
  {
    entry: { register: 'src/register.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node22',
  },
  {
    entry: { lifecycle: 'src/lifecycle.ts' },
    format: ['esm'],
    dts: true,
    clean: false,
    sourcemap: true,
    target: 'node22',
  },
  {
    entry: { 'runner-bridge': 'src/runner-bridge.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: true,
    target: 'node22',
  },
]);
