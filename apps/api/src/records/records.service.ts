import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  buildIndex,
  collectFields,
  uuidv7,
  validateAnswers,
  type AnswerIssue,
  type FormDefinition,
  type GeopointValue,
  type RecordData,
  type RecordStatus,
} from '@cvforms/form-core';
import type postgres from 'postgres';

import { DB_CLIENT } from '../db/db.module.js';

/**
 * Registos e revisões, do lado do servidor (F5).
 *
 * As duas decisões que governam este ficheiro, e que se lêem melhor juntas:
 *
 * 1. **Nada é recusado por causa do conteúdo.** Uma revisão que chega com
 *    dados inválidos é gravada na mesma, e o registo fica `needs_review`.
 *    Recusar deixaria o trabalho de campo preso na fila de um telefone que
 *    mais cedo ou mais tarde se parte ou se perde — e perder um registo de
 *    campo é o pior defeito possível deste sistema.
 * 2. **Um conflito nunca escolhe um vencedor.** Duas revisões com a mesma
 *    `base_revision_id` são ambas guardadas e o registo fica `needs_review`,
 *    para um humano decidir (ADR-0007).
 *
 * O que É recusado é o que não faz sentido nenhum: um `form_id` a que o
 * utilizador não tem acesso, um `id` que não é UUID, um registo de outra
 * organização.
 */

export interface GravarRevisaoInput {
  recordId: string;
  formId: string;
  orgId: string;
  projectId: string;
  formVersionId: string;
  data: RecordData;
  autorId: string | null;
  deviceId: string | null;
  clientCreatedAt: string | null;
  /** Revisão sobre a qual o cliente construiu esta. `null` num registo novo. */
  baseRevisionId: string | null;
  status?: RecordStatus;
  accuracyOverrideReason?: string | null;
}

export interface GravarRevisaoResultado {
  recordId: string;
  revisionId: string;
  revisionNo: number;
  status: RecordStatus;
  /** `true` se outra revisão já tinha sido construída sobre a mesma base. */
  conflito: boolean;
  /** Problemas de validação. Não impedem a gravação; explicam o needs_review. */
  problemas: AnswerIssue[];
}

@Injectable()
export class RecordsService {
  private readonly logger = new Logger(RecordsService.name);

  constructor(@Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql }) {}

  private get sql(): postgres.Sql {
    return this.holder.client;
  }

  /**
   * Grava uma revisão, criando o registo se ainda não existir.
   *
   * Tudo numa transacção: a revisão, o ponteiro do registo, os pontos GNSS e
   * a auditoria. Uma revisão gravada sem o registo apontar para ela seria
   * trabalho invisível.
   */
  async gravarRevisao(
    input: GravarRevisaoInput,
    definicao: FormDefinition,
  ): Promise<GravarRevisaoResultado> {
    // A validação corre fora da transacção: é pura, e o resultado não muda
    // nada do que se grava — só o estado com que o registo fica.
    const validacao = validateAnswers(definicao, structuredClone(input.data), {
      ...(input.accuracyOverrideReason
        ? { accuracyOverrideReason: input.accuracyOverrideReason }
        : {}),
    });
    const problemas = validacao.issues.filter((i) => i.severity === 'erro');

    return this.sql.begin(async (tx) => {
      const [existente] = await tx<
        Array<{ current_revision_id: string | null; status: RecordStatus; deleted_at: Date | null }>
      >`
        SELECT current_revision_id, status, deleted_at FROM records WHERE id = ${input.recordId}
      `;

      const ponto = geometriaDe(definicao, input.data);

      if (!existente) {
        await tx`
          INSERT INTO records (id, org_id, project_id, form_id, form_version_id, status,
                               created_by, client_created_at, geom)
          VALUES (${input.recordId}, ${input.orgId}, ${input.projectId}, ${input.formId},
                  ${input.formVersionId}, ${input.status ?? 'rascunho'}, ${input.autorId},
                  ${input.clientCreatedAt},
                  CASE WHEN ${ponto?.lon ?? null}::double precision IS NULL THEN NULL
                       ELSE ST_SetSRID(ST_MakePoint(${ponto?.lon ?? null}, ${ponto?.lat ?? null}), 4326)
                  END)
        `;
      }

      // Conflito: alguém já construiu uma revisão sobre a mesma base. Ambas
      // ficam; o registo passa a needs_review e um humano decide (ADR-0007).
      const conflito =
        existente !== undefined &&
        input.baseRevisionId !== null &&
        existente.current_revision_id !== input.baseRevisionId;

      const [ultima] = await tx<Array<{ n: number }>>`
        SELECT COALESCE(max(revision_no), 0) AS n FROM record_revisions
        WHERE record_id = ${input.recordId}
      `;
      const revisionNo = (ultima?.n ?? 0) + 1;
      const revisionId = uuidv7();

      await tx`
        INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data,
                                      author_id, device_id, base_revision_id,
                                      client_created_at, accuracy_override_reason)
        VALUES (${revisionId}, ${input.recordId}, ${revisionNo}, ${input.formVersionId},
                ${JSON.stringify(validacao.data)}::text::jsonb, ${input.autorId}, ${input.deviceId},
                ${input.baseRevisionId}, ${input.clientCreatedAt},
                ${input.accuracyOverrideReason ?? null})
      `;

      const estado: RecordStatus =
        conflito || problemas.length > 0
          ? 'needs_review'
          : (input.status ?? existente?.status ?? 'rascunho');

      // `current_revision_id` aponta sempre para a mais recente, mesmo em
      // conflito: a alternativa seria deixar o registo a apontar para uma
      // revisão antiga e ninguém veria a nova na app.
      const pontoFinal = geometriaDe(definicao, validacao.data);
      await tx`
        UPDATE records
        SET current_revision_id = ${revisionId},
            status = ${estado},
            updated_at = now(),
            -- Uma revisão sem ponto não apaga o que já lá estava: um campo de
            -- geometria escondido por relevância não pode fazer o registo
            -- desaparecer do mapa.
            geom = COALESCE(
              CASE WHEN ${pontoFinal?.lon ?? null}::double precision IS NULL THEN NULL
                   ELSE ST_SetSRID(ST_MakePoint(${pontoFinal?.lon ?? null}, ${pontoFinal?.lat ?? null}), 4326)
              END, geom)
        WHERE id = ${input.recordId}
      `;

      await this.gravarPontos(tx, input.recordId, revisionId, definicao, validacao.data);

      await tx`
        INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, metadata)
        VALUES (${uuidv7()}, ${input.orgId}, ${input.autorId},
                ${existente ? 'actualizar' : 'criar'}, 'record', ${input.recordId},
                ${JSON.stringify({
                  revision_no: revisionNo,
                  conflito,
                  problemas: problemas.length,
                  device_id: input.deviceId,
                })}::text::jsonb)
      `;

      if (conflito) {
        this.logger.warn(
          `conflito no registo ${input.recordId}: revisão ${revisionNo} construída sobre ${input.baseRevisionId}`,
        );
      }

      return {
        recordId: input.recordId,
        revisionId,
        revisionNo,
        status: estado,
        conflito,
        problemas,
      };
    });
  }

  /**
   * Escreve um ponto GNSS por cada geometria da revisão.
   *
   * Restrição inegociável 8: todo o ponto guardado leva `accuracy_m`,
   * `fix_type` e `source`. A tabela obriga-o com NOT NULL e CHECK; aqui
   * saltam-se os pontos que não os tenham, em vez de rebentar a gravação
   * inteira — o valor continua no JSONB e o relatório de qualidade da F10.5
   * dá por ele.
   */
  private async gravarPontos(
    tx: postgres.TransactionSql,
    recordId: string,
    revisionId: string,
    definicao: FormDefinition,
    data: RecordData,
  ): Promise<void> {
    for (const { fieldId, ponto } of pontosDe(definicao, data)) {
      if (
        typeof ponto.accuracy_m !== 'number' ||
        ponto.accuracy_m < 0 ||
        ponto.accuracy_m >= 100_000 ||
        typeof ponto.lat !== 'number' ||
        typeof ponto.lon !== 'number' ||
        ponto.lat < -90 ||
        ponto.lat > 90 ||
        ponto.lon < -180 ||
        ponto.lon > 180
      ) {
        continue;
      }
      await tx`
        INSERT INTO gps_fixes (id, record_id, revision_id, field_id, lat, lon, alt,
                               accuracy_m, fix_type, source, collected_at)
        VALUES (${uuidv7()}, ${recordId}, ${revisionId}, ${fieldId}, ${ponto.lat}, ${ponto.lon},
                ${ponto.alt ?? null}, ${ponto.accuracy_m}, ${ponto.fix_type}, ${ponto.source},
                ${ponto.collected_at ?? null})
      `;
    }
  }

  /** Soft delete com tombstone. Nunca há DELETE (restrição inegociável 4). */
  async apagar(recordId: string, orgId: string, actorId: string | null): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const linhas = await tx`
        UPDATE records SET deleted_at = now(), updated_at = now(), deleted_by = ${actorId}
        WHERE id = ${recordId} AND org_id = ${orgId} AND deleted_at IS NULL
        RETURNING id
      `;
      if (linhas.length === 0) return false;
      await tx`
        INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id)
        VALUES (${uuidv7()}, ${orgId}, ${actorId}, 'apagar', 'record', ${recordId})
      `;
      return true;
    });
  }

  async restaurar(recordId: string, orgId: string, actorId: string | null): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const linhas = await tx`
        UPDATE records SET deleted_at = NULL, deleted_by = NULL, updated_at = now()
        WHERE id = ${recordId} AND org_id = ${orgId} AND deleted_at IS NOT NULL
        RETURNING id
      `;
      if (linhas.length === 0) return false;
      await tx`
        INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id)
        VALUES (${uuidv7()}, ${orgId}, ${actorId}, 'restaurar', 'record', ${recordId})
      `;
      return true;
    });
  }

  /** Muda o estado de um registo. Usado pela resolução de conflitos no painel. */
  async definirEstado(
    recordId: string,
    orgId: string,
    estado: RecordStatus,
    actorId: string | null,
  ): Promise<boolean> {
    const linhas = await this.sql`
      UPDATE records SET status = ${estado}, updated_at = now()
      WHERE id = ${recordId} AND org_id = ${orgId}
      RETURNING id
    `;
    if (linhas.length === 0) return false;
    await this.sql`
      INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, metadata)
      VALUES (${uuidv7()}, ${orgId}, ${actorId}, 'actualizar', 'record', ${recordId},
              ${JSON.stringify({ estado })}::text::jsonb)
    `;
    return true;
  }
}

/** Todos os `geopoint` de uma resposta, incluindo os de dentro de repetíveis. */
export function pontosDe(
  definicao: FormDefinition,
  data: RecordData,
): Array<{ fieldId: string; ponto: GeopointValue }> {
  const geopoints = new Set(
    collectFields(definicao)
      .filter((v) => v.field.type === 'geopoint')
      .map((v) => v.field.id),
  );
  const encontrados: Array<{ fieldId: string; ponto: GeopointValue }> = [];

  const visitar = (valores: RecordData): void => {
    for (const [chave, valor] of Object.entries(valores)) {
      if (Array.isArray(valor)) {
        for (const item of valor) {
          if (item && typeof item === 'object' && !Array.isArray(item)) visitar(item as RecordData);
        }
        continue;
      }
      if (geopoints.has(chave) && valor && typeof valor === 'object') {
        encontrados.push({ fieldId: chave, ponto: valor as GeopointValue });
      }
    }
  };
  visitar(data);
  return encontrados;
}

/**
 * Coordenada do registo, a partir do campo indicado em `settings.geometry_field`.
 * `undefined` quando não há campo definido ou quando ainda não há ponto.
 */
export function geometriaDe(
  definicao: FormDefinition,
  data: RecordData,
): { lat: number; lon: number } | undefined {
  const campo = definicao.settings?.geometry_field;
  if (!campo) return undefined;
  const index = buildIndex(definicao);
  if (index.byId.get(campo)?.field.type !== 'geopoint') return undefined;
  const ponto = data[campo] as GeopointValue | undefined;
  if (!ponto || typeof ponto.lat !== 'number' || typeof ponto.lon !== 'number') return undefined;
  return { lat: ponto.lat, lon: ponto.lon };
}
