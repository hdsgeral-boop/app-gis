import { Injectable, Inject, Logger, UnauthorizedException } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

import { ENV, type Env } from '../config/env.js';
import type { Principal } from './principal.js';

/**
 * Verifica os JWT do Keycloak contra o JWKS do realm.
 *
 * A chave é ida buscar ao Keycloak e mantida em cache pelo `jose`, com
 * renovação automática quando aparece um `kid` desconhecido. Não há segredo
 * partilhado nem chave no repositório.
 */
@Injectable()
export class JwtVerifier {
  private readonly logger = new Logger(JwtVerifier.name);
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(@Inject(ENV) private readonly env: Env) {
    const url = new URL(`${env.KEYCLOAK_ISSUER.replace(/\/$/, '')}/protocol/openid-connect/certs`);
    this.jwks = createRemoteJWKSet(url, { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  }

  async verify(token: string): Promise<Principal> {
    let payload: JWTPayload;
    try {
      const result = await jwtVerify(token, this.jwks, {
        issuer: this.env.KEYCLOAK_ISSUER.replace(/\/$/, ''),
        clockTolerance: this.env.JWT_CLOCK_TOLERANCE_S,
      });
      payload = result.payload;
    } catch (error) {
      // Nunca registar o token: é uma credencial (restrição inegociável 9).
      this.logger.debug(`token recusado: ${(error as Error).message}`);
      throw new UnauthorizedException('token inválido ou expirado');
    }

    if (!this.audienceAceite(payload)) {
      throw new UnauthorizedException('token emitido para outra audiência');
    }

    const subject = payload.sub;
    const orgId = typeof payload.org_id === 'string' ? payload.org_id : undefined;
    if (!subject) throw new UnauthorizedException('token sem `sub`');
    if (!orgId) {
      // Sem organização não há isolamento possível. Recusar é a única resposta
      // segura: deixar passar significaria um utilizador sem fronteira.
      throw new UnauthorizedException('token sem `org_id`; o utilizador não tem organização');
    }

    return {
      subject,
      orgId,
      username:
        typeof payload.preferred_username === 'string' ? payload.preferred_username : subject,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      displayName: typeof payload.name === 'string' ? payload.name : undefined,
      roles: extrairPapeis(payload),
      userId: undefined,
    };
  }

  private audienceAceite(payload: JWTPayload): boolean {
    const aud = payload.aud;
    const declaradas = Array.isArray(aud) ? aud : aud ? [aud] : [];
    // O Keycloak nem sempre põe `aud` quando não há audience mapper; nesse caso
    // cai-se para `azp`, que identifica o cliente que pediu o token.
    const azp = typeof payload.azp === 'string' ? [payload.azp] : [];
    const candidatas = [...declaradas, ...azp];
    return candidatas.some((a) => this.env.audiences.includes(a));
  }
}

function extrairPapeis(payload: JWTPayload): string[] {
  const realmAccess = payload.realm_access;
  if (
    realmAccess &&
    typeof realmAccess === 'object' &&
    'roles' in realmAccess &&
    Array.isArray((realmAccess as { roles: unknown }).roles)
  ) {
    return ((realmAccess as { roles: unknown[] }).roles as unknown[]).filter(
      (r): r is string => typeof r === 'string',
    );
  }
  return [];
}
