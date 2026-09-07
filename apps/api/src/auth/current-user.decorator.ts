import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { Principal } from './principal.js';

export const UtilizadorActual = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): Principal => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    if (!request.principal) {
      // Só acontece se alguém puser este decorador numa rota @Publico().
      throw new Error('UtilizadorActual usado numa rota sem autenticação');
    }
    return request.principal;
  },
);
