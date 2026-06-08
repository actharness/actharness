import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@actspec/expressions': path.resolve(__dirname, '../expressions/src/index.ts'),
    },
  },
  test: {
    globals: true,
    setupFiles: ['./src/matchers.ts'],
    testTimeout: 30000,
  },
});
