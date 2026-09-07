import { CallHandler, ExecutionContext, Inject, Injectable, NestInterceptor } from '@nestjs/common';
import { from, Observable } from 'rxjs';
import type { FastifyRequest } from 'fastify';

import { DB_CLIENT, type ClienteDaBase } from './db.module.js';
import { ENV, type Env } from '../config/env.js';
import { comContexto } from './contexto.js';

/**
 * Abre o contexto da base a cada pedido autenticado (F6.2).
 *
 * Corre DEPOIS do guarda de autenticação — a ordem importa, porque o contexto
 * precisa do `org_id` e do `user_id` que o guarda resolve. Pedidos públicos
 * (`/health`) passam ao lado e usam o pool, que é o que se quer: uma
 * verificação de saúde não pertence a organização nenhuma.
 *
 * Se o RLS estiver desligado por configuração, isto não faz nada. É uma saída
 * de emergência para diagnóstico, e está `true` por omissão de propósito:
 * ninguém liga o isolamento por engano, mas alguém pode desligá-lo por engano.
 */
@Injectable()
export class ContextoDaBaseInterceptor implements NestInterceptor {
  constructor(
    @Inject(DB_CLIENT) private readonly holder: ClienteDaBase,
    @Inject(ENV) private readonly env: Env,
  ) {}

  intercept(contexto: ExecutionContext, seguinte: CallHandler): Observable<unknown> {
    const pedido = contexto.switchToHttp().getRequest<FastifyRequest>();
    const principal = pedido.principal;

    if (!this.env.DATABASE_RLS || !principal?.orgId) {
      return seguinte.handle();
    }

    return from(
      comContexto(
        {
          pool: this.holder.pool,
          papel: this.env.DATABASE_APP_ROLE,
          orgId: principal.orgId,
          userId: principal.userId,
          // Os papéis vêm do realm do Keycloak, verificados pelo guarda.
          administracao: principal.roles.some((p) => p === 'admin' || p === 'gestor'),
        },
        // `firstValueFrom` do observable dentro do contexto: é o que garante
        // que todo o trabalho do handler corre com a ligação reservada.
        async () => {
          const { firstValueFrom } = await import('rxjs');
          return firstValueFrom(seguinte.handle());
        },
      ),
    );
  }
}
