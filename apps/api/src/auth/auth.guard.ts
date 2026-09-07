import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import { PAPEIS } from './roles.decorator.js';
import { PUBLICO } from './public.decorator.js';
import { JwtVerifier } from './jwt.verifier.js';
import { UsersService } from './users.service.js';

/**
 * Guarda global. Tudo é fechado por omissão; abre-se com `@Publico()`.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtVerifier,
    private readonly users: UsersService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const publico = this.reflector.getAllAndOverride<boolean>(PUBLICO, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (publico) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const token = extrairToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('falta o cabeçalho Authorization: Bearer');

    const principal = await this.verifier.verify(token);
    // Espelha o utilizador do Keycloak na base ao primeiro pedido. Sem isto,
    // `records.created_by` não teria a quem apontar.
    principal.userId = await this.users.resolverIdInterno(principal);
    request.principal = principal;

    const exigidos = this.reflector.getAllAndOverride<string[]>(PAPEIS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (exigidos?.length && !exigidos.some((papel) => principal.roles.includes(papel))) {
      throw new ForbiddenException(`esta operação exige um dos papéis: ${exigidos.join(', ')}`);
    }
    return true;
  }
}

function extrairToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [esquema, valor] = header.split(' ');
  if (!valor || esquema?.toLowerCase() !== 'bearer') return undefined;
  return valor.trim() || undefined;
}
