import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';

import { AdminFormsController } from './admin/admin-forms.controller.js';
import { ArmazenamentoService } from './attachments/armazenamento.service.js';
import { AttachmentsController } from './attachments/attachments.controller.js';
import { ExportsController } from './admin/exports.controller.js';
import { PessoasController } from './admin/pessoas.controller.js';
import { MapasController } from './mapas/mapas.controller.js';
import { AuthGuard } from './auth/auth.guard.js';
import { ContextoDaBaseInterceptor } from './db/contexto.interceptor.js';
import { DbModule } from './db/db.module.js';
import { ConfigModule } from './config/config.module.js';
import { ENV, loadEnv, type Env } from './config/env.js';
import { FormsAccessService } from './forms/forms-access.service.js';
import { FormsController } from './forms/forms.controller.js';
import { ErrosFilter } from './observabilidade/erros.filter.js';
import { VigiaDeReplicacao } from './health/vigia-replicacao.service.js';
import { HealthController } from './health/health.controller.js';
import { FiltroDeErrosDeValidacao } from './common/zod-exception.filter.js';
import { Idempotencia } from './common/idempotencia.service.js';
import { JwtVerifier } from './auth/jwt.verifier.js';
import { MeController } from './me/me.controller.js';
import { RecordsController } from './records/records.controller.js';
import { RecordsService } from './records/records.service.js';
import { UsersService } from './auth/users.service.js';

// O LoggerModule.forRootAsync arranca antes do ConfigModule global estar
// disponível, por isso é o único sítio que volta a carregar o ambiente.
const envProviderDoLogger = { provide: ENV, useFactory: () => loadEnv() };

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      providers: [envProviderDoLogger],
      inject: [ENV],
      useFactory: (env: Env) => ({
        pinoHttp: {
          level: env.LOG_LEVEL,
          // Restrição inegociável 9: nada de dados pessoais nem credenciais
          // nos logs. Os cabeçalhos de autorização e os cookies nunca saem.
          redact: {
            paths: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-api-key"]',
              'res.headers["set-cookie"]',
            ],
            remove: true,
          },
          // O corpo dos pedidos leva respostas de campo. Nunca é registado.
          serializers: {
            req: (req: { id: unknown; method: string; url: string }) => ({
              id: req.id,
              method: req.method,
              url: req.url,
            }),
          },
          autoLogging: { ignore: (req: { url?: string }) => req.url === '/health/live' },
        },
      }),
    }),
    DbModule,
  ],
  controllers: [
    HealthController,
    MeController,
    FormsController,
    RecordsController,
    AttachmentsController,
    AdminFormsController,
    ExportsController,
    PessoasController,
    MapasController,
  ],
  providers: [
    VigiaDeReplicacao,
    { provide: APP_FILTER, useClass: ErrosFilter },
    JwtVerifier,
    UsersService,
    FormsAccessService,
    RecordsService,
    ArmazenamentoService,
    Idempotencia,
    { provide: APP_GUARD, useClass: AuthGuard },
    // Corre depois do guarda: o contexto da base precisa do que ele resolve.
    { provide: APP_INTERCEPTOR, useClass: ContextoDaBaseInterceptor },
    // Registado a nível do módulo para valer também nos testes, que constroem
    // a app pelo AppModule e não passam pelo main.ts.
    { provide: APP_FILTER, useClass: FiltroDeErrosDeValidacao },
  ],
})
export class AppModule {}
