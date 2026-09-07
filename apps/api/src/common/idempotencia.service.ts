import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { DB_CLIENT } from '../db/db.module.js';
import type { Principal } from '../auth/principal.js';

/**
 * `Idempotency-Key` (ESPECIFICACAO §6).
 *
 * Não é um extra de conforto. Numa rede de campo, um `POST` que chega ao
 * servidor e cujo 201 se perde no caminho de volta é normal — o telefone volta
 * a tentar, e sem isto ficavam dois registos onde havia um. Duplicar não perde
 * dados, mas cria trabalho humano de limpeza que ninguém tem.
 *
 * A chave sozinha não chega: guarda-se também o hash do pedido. Reutilizar a
 * mesma chave com um corpo diferente é um erro do cliente, e devolver-lhe a
 * resposta antiga em silêncio seria pior do que recusar.
 */
@Injectable()
export class Idempotencia {
  constructor(@Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql }) {}

  private get sql(): postgres.Sql {
    return this.holder.client;
  }

  /**
   * Corre a operação uma vez por chave. Sem chave, corre sempre — a
   * idempotência é opcional para quem não precisa dela.
   */
  async executar<T>(
    chave: string | undefined,
    principal: Principal,
    pedido: unknown,
    operacao: () => Promise<T>,
  ): Promise<T> {
    const limpa = chave?.trim();
    if (!limpa) return operacao();

    const hash = createHash('sha256').update(JSON.stringify(pedido)).digest('hex');
    const utilizador = principal.userId ?? principal.subject;

    const [existente] = await this.sql<
      Array<{ request_hash: string; response_body: T | null; response_status: number | null }>
    >`
      SELECT request_hash, response_body, response_status
      FROM idempotency_keys
      WHERE key = ${limpa} AND user_id = ${utilizador} AND expires_at > now()
    `;

    if (existente) {
      if (existente.request_hash !== hash) {
        throw new ConflictException(
          'a mesma Idempotency-Key foi usada com um corpo diferente; usa uma chave nova',
        );
      }
      if (existente.response_body !== null) return existente.response_body;
      // Registada mas sem resposta: o pedido anterior morreu a meio. Corre-se
      // outra vez — a operação em si é transaccional, por isso ou ficou tudo
      // ou não ficou nada.
    }

    if (!existente) {
      await this.sql`
        INSERT INTO idempotency_keys (key, user_id, request_hash)
        VALUES (${limpa}, ${utilizador}, ${hash})
        ON CONFLICT (key) DO NOTHING
      `;
    }

    const resultado = await operacao();

    await this.sql`
      UPDATE idempotency_keys
      SET response_status = 200, response_body = ${JSON.stringify(resultado)}::text::jsonb
      WHERE key = ${limpa} AND user_id = ${utilizador}
    `;
    return resultado;
  }
}
