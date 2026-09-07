import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    // Os testes tocam a mesma base; correr ficheiros em paralelo faria-os
    // pisar os dados uns dos outros.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
  plugins: [
    // O esbuild do Vite não emite `emitDecoratorMetadata`, e sem isso a
    // injecção de dependências do Nest chega aos construtores vazia. O SWC
    // emite-a. Sem este plugin, os testes falham de formas que não têm nada
    // que ver com o código que estamos a testar.
    swc.vite({ module: { type: 'es6' } }),
  ],
});
