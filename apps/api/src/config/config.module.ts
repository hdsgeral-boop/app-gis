import { Global, Module } from '@nestjs/common';

import { ENV, loadEnv } from './env.js';

/**
 * Carrega e valida o ambiente uma só vez, e torna-o visível a toda a aplicação.
 *
 * Global de propósito: praticamente todos os módulos precisam de configuração,
 * e obrigar cada um a importar este módulo só produziria ruído.
 */
@Global()
@Module({
  providers: [{ provide: ENV, useFactory: () => loadEnv() }],
  exports: [ENV],
})
export class ConfigModule {}
