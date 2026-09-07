import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'], include: ['src/**'] },
  },
});
