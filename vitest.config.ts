import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      react: path.resolve(import.meta.dirname, 'client/node_modules/react'),
      'react-dom': path.resolve(import.meta.dirname, 'client/node_modules/react-dom'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['server/src/**/*.ts', 'shared/**/*.ts'],
    },
  },
});
