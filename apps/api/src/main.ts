import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from '@fastify/helmet';

import { AppModule } from './app.module.js';
import { ENV, type Env } from './config/env.js';
import { iniciarSentry } from './observabilidade/sentry.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      // Um registo de campo com muitas fotos por referência pode ser grande;
      // o limite protege a API sem estorvar o uso normal.
      bodyLimit: 8 * 1024 * 1024,
      trustProxy: true,
      genReqId: () => crypto.randomUUID(),
    }),
    { bufferLogs: true },
  );

  app.useLogger(app.get(PinoLogger));
  const env = app.get<Env>(ENV);

  // Antes de abrir a porta: um erro que aconteça no arranque é dos que mais
  // interessa relatar, e é o que se perde se isto vier depois do `listen`.
  const relato = await iniciarSentry(
    env.SENTRY_DSN
      ? {
          dsn: env.SENTRY_DSN,
          ambiente: env.NODE_ENV,
          amostragem: env.SENTRY_TRACES_SAMPLE_RATE,
        }
      : undefined,
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  app.enableCors({
    origin: env.corsOrigins,
    credentials: true,
    // ETag e If-Match são o mecanismo de concorrência do PATCH /records/{id}.
    exposedHeaders: ['ETag', 'Location'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'If-Match',
      'If-None-Match',
      'Idempotency-Key',
    ],
  });
  app.enableShutdownHooks();

  await app.listen(env.PORT, env.HOST);
  const log = app.get(PinoLogger);
  log.log(`API do Consul Colect à escuta em http://${env.HOST}:${env.PORT}`);
  log.log(
    relato
      ? 'relato de erros ligado'
      : 'relato de erros desligado (sem SENTRY_DSN) — é o normal fora de produção',
  );
}

void bootstrap();
