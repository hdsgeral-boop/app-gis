import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { organizations, users } from '@cvforms/db/schema';

import { DB, type Db } from '../db/db.module.js';
import type { Principal } from './principal.js';

/**
 * Espelho local do Keycloak.
 *
 * A verdade da identidade está no Keycloak. Esta tabela existe para que as
 * chaves estrangeiras (`records.created_by`, `audit_log.actor_id`) tenham a
 * quem apontar, e para que uma listagem não tenha de chamar o Keycloak por
 * cada linha.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  /** Evita ir à base a cada pedido do mesmo utilizador. */
  private readonly cache = new Map<string, string>();

  constructor(@Inject(DB) private readonly db: Db) {}

  async resolverIdInterno(principal: Principal): Promise<string | undefined> {
    const cached = this.cache.get(principal.subject);
    if (cached) return cached;

    const [existente] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.subject, principal.subject))
      .limit(1);

    if (existente) {
      this.cache.set(principal.subject, existente.id);
      void this.marcarVisto(existente.id);
      return existente.id;
    }

    // Provisionamento na primeira entrada. Se a organização do token ainda não
    // existir na base, não inventamos uma: o administrador tem de a criar
    // primeiro. Devolver `undefined` deixa o pedido seguir e o /me explicar o
    // que falta, em vez de rebentar com um 500 opaco.
    const [org] = await this.db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, principal.orgId))
      .limit(1);

    if (!org) {
      this.logger.warn(
        `token com org_id ${principal.orgId} que não existe na base; utilizador não provisionado`,
      );
      return undefined;
    }

    const [criado] = await this.db
      .insert(users)
      .values({
        id: sql`gen_random_uuid()`,
        orgId: principal.orgId,
        subject: principal.subject,
        username: principal.username,
        email: principal.email ?? null,
        displayName: principal.displayName ?? null,
      })
      .onConflictDoNothing({ target: users.subject })
      .returning({ id: users.id });

    if (criado) {
      this.cache.set(principal.subject, criado.id);
      return criado.id;
    }

    // Corrida com outro pedido do mesmo utilizador: alguém inseriu entretanto.
    const [agora] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.subject, principal.subject), eq(users.orgId, principal.orgId)))
      .limit(1);
    if (agora) this.cache.set(principal.subject, agora.id);
    return agora?.id;
  }

  private async marcarVisto(userId: string): Promise<void> {
    try {
      await this.db.update(users).set({ lastSeenAt: new Date() }).where(eq(users.id, userId));
    } catch (error) {
      // Não vale a pena falhar um pedido por causa de um carimbo de presença.
      this.logger.debug(`falhou marcar last_seen_at: ${(error as Error).message}`);
    }
  }
}
