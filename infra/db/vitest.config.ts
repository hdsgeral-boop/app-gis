import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // As migrações e os triggers correm contra uma base real. Não há mocks:
    // um trigger simulado não prova nada sobre o Postgres que vai a produção.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
