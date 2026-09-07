import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { isUuidV7, type FormDefinition } from '@cvforms/form-core';
import type postgres from 'postgres';

import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { FormsAccessService } from '../forms/forms-access.service.js';
import { Idempotencia } from '../common/idempotencia.service.js';
import { RecordsService } from './records.service.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import type { Principal } from '../auth/principal.js';

/**
 * Registos (ESPECIFICACAO §6).
 *
 * Esta API serve o painel, integrações e clientes terceiros. A sincronização
 * em massa da app móvel passa pelo PowerSync — mas os mesmos invariantes têm
 * de valer nos dois caminhos, e por isso a lógica está toda no
 * `RecordsService`, e não aqui.
 *
 * Todas as escritas aceitam `Idempotency-Key`. Não é um extra: numa rede de
 * campo, um `POST` que expira depois de o servidor o ter processado é normal,
 * e sem idempotência o retry duplicaria o registo.
 */
const criar = z.object({
  /** UUIDv7 gerado no cliente (restrição inegociável 3). */
  id: z.string().uuid(),
  form_id: z.string().uuid(),
  form_version: z.number().int().positive().optional(),
  data: z.record(z.string(), z.unknown()),
  status: z.enum(['rascunho', 'submetido']).optional(),
  device_id: z.string().max(120).optional(),
  client_created_at: z.string().optional(),
  justificacao_de_precisao: z.string().max(2000).optional(),
});

const actualizar = z.object({
  data: z.record(z.string(), z.unknown()),
  status: z.enum(['rascunho', 'submetido', 'validado', 'rejeitado', 'needs_review']).optional(),
  device_id: z.string().max(120).optional(),
  client_created_at: z.string().optional(),
  justificacao_de_precisao: z.string().max(2000).optional(),
});

const resolverConflito = z.object({
  /** Revisão que fica a valer. Tem de ser uma revisão DESTE registo. */
  revisao_escolhida: z.string().uuid(),
  /** Porque é que se escolheu esta. Fica na auditoria. */
  nota: z.string().max(2000).optional(),
});

const bbox = z
  .string()
  .regex(/^-?\d+(\.\d+)?(,-?\d+(\.\d+)?){3}$/, 'bbox é oeste,sul,este,norte')
  .optional();

@Controller('records')
export class RecordsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql },
    private readonly registos: RecordsService,
    private readonly acesso: FormsAccessService,
    private readonly idempotencia: Idempotencia,
  ) {}

  private get sql(): postgres.Sql {
    return this.holder.client;
  }

  @Post()
  async criar(
    @UtilizadorActual() principal: Principal,
    @Body() body: unknown,
    @Headers('idempotency-key') chave?: string,
  ) {
    const dados = criar.parse(body);
    if (!isUuidV7(dados.id)) {
      throw new BadRequestException(
        'o id tem de ser um UUIDv7 gerado no cliente (restrição inegociável 3)',
      );
    }

    return this.idempotencia.executar(chave, principal, dados, async () => {
      const permissoes = await this.acesso.permissoes(principal, dados.form_id);
      if (!permissoes?.pode_criar) {
        throw new ForbiddenException('sem permissão para criar registos neste formulário');
      }

      const versao = await this.versao(dados.form_id, dados.form_version);
      const resultado = await this.registos.gravarRevisao(
        {
          recordId: dados.id,
          formId: dados.form_id,
          orgId: principal.orgId,
          projectId: permissoes.projecto_id,
          formVersionId: versao.id,
          data: dados.data,
          autorId: principal.userId ?? null,
          deviceId: dados.device_id ?? null,
          clientCreatedAt: dados.client_created_at ?? null,
          baseRevisionId: null,
          ...(dados.status ? { status: dados.status } : {}),
          ...(dados.justificacao_de_precisao
            ? { accuracyOverrideReason: dados.justificacao_de_precisao }
            : {}),
        },
        versao.definicao,
      );
      return this.resposta(resultado);
    });
  }

  /**
   * Nova revisão.
   *
   * `If-Match` traz a revisão sobre a qual o cliente construiu esta. Sem ela,
   * assume-se a corrente — o que é o comportamento certo para o painel, onde
   * quem edita acabou de ler o registo, e o errado para um telefone offline,
   * que tem de a mandar sempre.
   */
  @Patch(':id')
  async actualizar(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers('if-match') ifMatch?: string,
    @Headers('idempotency-key') chave?: string,
  ) {
    const dados = actualizar.parse(body);

    return this.idempotencia.executar(chave, principal, { id, ...dados }, async () => {
      const registo = await this.registo(id, principal.orgId);
      const permissoes = await this.acesso.permissoes(principal, registo.form_id);
      const proprio = registo.created_by === principal.userId;

      // ADR-0011: quem perdeu a atribuição continua a poder SUBIR o que já
      // tinha recolhido. Um técnico que passou uma semana no mato não pode
      // perder esse trabalho porque alguém em Luanda mexeu numa atribuição
      // entretanto. Criar registos novos, esse sim, exige a atribuição actual.
      const podeSubirOQueJaRecolheu = !permissoes && proprio;

      const autorizado =
        podeSubirOQueJaRecolheu ||
        (permissoes &&
          (permissoes.pode_editar_todos || (permissoes.pode_editar_proprios && proprio)));

      if (!autorizado) {
        throw new ForbiddenException('sem permissão para editar este registo');
      }

      const versao = await this.versaoPorId(registo.form_version_id);
      const resultado = await this.registos.gravarRevisao(
        {
          recordId: id,
          formId: registo.form_id,
          orgId: principal.orgId,
          projectId: registo.project_id,
          formVersionId: registo.form_version_id,
          data: dados.data,
          autorId: principal.userId ?? null,
          deviceId: dados.device_id ?? null,
          clientCreatedAt: dados.client_created_at ?? null,
          baseRevisionId: limparEtag(ifMatch) ?? registo.current_revision_id,
          ...(dados.status ? { status: dados.status } : {}),
          ...(dados.justificacao_de_precisao
            ? { accuracyOverrideReason: dados.justificacao_de_precisao }
            : {}),
        },
        versao.definicao,
      );
      return this.resposta(resultado);
    });
  }

  @Get()
  async listar(
    @UtilizadorActual() principal: Principal,
    @Query('form_id') formId?: string,
    @Query('updated_since') updatedSince?: string,
    @Query('status') status?: string,
    @Query('bbox') caixa?: string,
    @Query('limite') limite?: string,
    @Query('deslocamento') deslocamento?: string,
    @Query('incluir_apagados') incluirApagados?: string,
  ) {
    if (!principal.userId) return { registos: [], total: 0 };
    const atribuidos = await this.acesso.formulariosDe(principal.userId);
    const permitidos = atribuidos.map((f) => f.form_id);
    if (permitidos.length === 0) return { registos: [], total: 0 };
    if (formId && !permitidos.includes(formId)) {
      throw new ForbiddenException('este formulário não lhe está atribuído');
    }

    const alcance = formId ? [formId] : permitidos;
    const caixaValida = bbox.parse(caixa);
    const envelope = caixaValida?.split(',').map(Number);
    const desde = updatedSince ? new Date(updatedSince) : undefined;
    const max = Math.min(Number(limite) || 100, 500);
    const salto = Math.max(Number(deslocamento) || 0, 0);

    const linhas = await this.sql`
      SELECT r.id, r.form_id, r.project_id, r.status, r.created_by, r.created_at, r.updated_at,
             r.client_created_at, r.deleted_at, r.current_revision_id,
             ST_Y(r.geom) AS lat, ST_X(r.geom) AS lon,
             v.revision_no, v.data, v.server_received_at
      FROM records r
      LEFT JOIN record_revisions v ON v.id = r.current_revision_id
      WHERE r.org_id = ${principal.orgId}
        AND r.form_id = ANY(${alcance})
        -- Os tombstones não aparecem por omissão. Mas quem sincroniza PRECISA
        -- deles: sem saber que um registo foi apagado, o cliente fica com ele
        -- para sempre. Daí o parâmetro incluir_apagados.
        ${incluirApagados === 'true' ? this.sql`` : this.sql`AND r.deleted_at IS NULL`}
        ${
          desde && !Number.isNaN(desde.getTime())
            ? // Texto com cast explícito, e não um Date: dentro de um fragmento
              // o driver perde o tipo do parâmetro e rebenta com um
              // ERR_INVALID_ARG_TYPE que não aponta para nada.
              this.sql`AND r.updated_at > ${desde.toISOString()}::timestamptz`
            : this.sql``
        }
        ${status ? this.sql`AND r.status = ${status}` : this.sql``}
        ${
          envelope
            ? this
                .sql`AND r.geom && ST_MakeEnvelope(${envelope[0]!}, ${envelope[1]!}, ${envelope[2]!}, ${envelope[3]!}, 4326)`
            : this.sql``
        }
      ORDER BY r.updated_at DESC, r.id DESC
      LIMIT ${max} OFFSET ${salto}
    `;

    return { registos: linhas, total: linhas.length };
  }

  @Get(':id')
  async ver(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const registo = await this.registo(id, principal.orgId);
    await this.exigirLeitura(principal, registo.form_id);
    const [revisao] = await this.sql`
      SELECT id, revision_no, data, author_id, device_id, base_revision_id,
             client_created_at, server_received_at, accuracy_override_reason
      FROM record_revisions WHERE id = ${registo.current_revision_id}
    `;
    return { registo, revisao: revisao ?? null };
  }

  /** Histórico completo. É o que torna um cadastro auditável (ADR-0007). */
  @Get(':id/revisions')
  async revisoes(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const registo = await this.registo(id, principal.orgId);
    await this.exigirLeitura(principal, registo.form_id);
    const revisoes = await this.sql`
      SELECT id, revision_no, data, author_id, device_id, base_revision_id,
             client_created_at, server_received_at, accuracy_override_reason
      FROM record_revisions WHERE record_id = ${id}
      ORDER BY revision_no
    `;
    return { revisoes };
  }

  /**
   * Ramos em conflito: revisões que partiram da mesma base.
   *
   * É o que o painel mostra lado a lado para alguém escolher (F5.7).
   */
  @Get(':id/conflitos')
  async conflitos(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const registo = await this.registo(id, principal.orgId);
    await this.exigirLeitura(principal, registo.form_id);
    const ramos = await this.sql<
      Array<{ base_revision_id: string; ramos: number; revisoes: string[] }>
    >`
      SELECT base_revision_id, count(*)::int AS ramos,
             array_agg(id ORDER BY revision_no) AS revisoes
      FROM record_revisions
      WHERE record_id = ${id} AND base_revision_id IS NOT NULL
      GROUP BY base_revision_id
      HAVING count(*) > 1
    `;

    // Os dados de cada ramo vêm com eles. Sem isto, o painel tinha de fazer
    // uma chamada por revisão para mostrar duas colunas lado a lado — e são
    // exactamente as duas colunas que a F5.7 pede.
    const emConflito = new Set(ramos.flatMap((r) => r.revisoes));
    const revisoes = emConflito.size
      ? await this.sql<
          Array<{
            id: string;
            revision_no: number;
            data: Record<string, unknown>;
            author_id: string | null;
            device_id: string | null;
            server_received_at: Date;
          }>
        >`
          SELECT id, revision_no, data, author_id, device_id, server_received_at
          FROM record_revisions
          WHERE record_id = ${id} AND id = ANY(${[...emConflito]}::uuid[])
          ORDER BY revision_no
        `
      : [];

    return {
      estado: registo.status,
      revisao_corrente: registo.current_revision_id,
      conflitos: ramos,
      revisoes,
    };
  }

  /**
   * Resolve um conflito escolhendo um dos ramos (F5.7).
   *
   * NÃO apaga o ramo perdedor, e não podia: uma revisão nunca se apaga nem se
   * sobrescreve (restrição inegociável 4). O que faz é gravar uma revisão
   * NOVA com os dados do ramo escolhido, construída sobre a revisão corrente.
   * O histórico fica inteiro, e quem o ler daqui a um ano vê que houve um
   * conflito, o que cada técnico tinha escrito, e o que alguém decidiu.
   *
   * Se os dados escolhidos ainda tiverem erros de validação, o registo
   * continua em `needs_review` — resolver o conflito não é o mesmo que dizer
   * que o registo está bom.
   */
  @Post(':id/resolver')
  async resolver(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = resolverConflito.parse(body);
    const registo = await this.registo(id, principal.orgId);

    const permissoes = await this.acesso.permissoes(principal, registo.form_id);
    // Resolver é decidir pelo trabalho de outra pessoa. Quem só pode editar os
    // próprios registos não decide o de ninguém.
    if (!permissoes?.pode_editar_todos && !principal.roles.includes('admin')) {
      throw new ForbiddenException('sem permissão para resolver conflitos deste formulário');
    }

    const [escolhida] = await this.sql<
      Array<{ id: string; data: Record<string, unknown>; form_version_id: string }>
    >`
      SELECT id, data, form_version_id FROM record_revisions
      WHERE id = ${dados.revisao_escolhida} AND record_id = ${id}
    `;
    if (!escolhida) {
      throw new BadRequestException('essa revisão não é deste registo');
    }

    // A revisão vencedora é reescrita com a versão de formulário com que foi
    // recolhida, e não com a corrente: reinterpretá-la com um esquema mais
    // novo mudaria o significado de respostas que ninguém voltou a dar.
    const versao = await this.versaoPorId(escolhida.form_version_id);

    const resultado = await this.registos.gravarRevisao(
      {
        recordId: id,
        formId: registo.form_id,
        orgId: principal.orgId,
        projectId: registo.project_id,
        formVersionId: versao.id,
        data: escolhida.data,
        autorId: principal.userId ?? null,
        deviceId: null,
        clientCreatedAt: null,
        baseRevisionId: registo.current_revision_id,
        status: 'submetido',
      },
      versao.definicao,
    );

    await this.sql`
      INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, metadata)
      VALUES (gen_random_uuid(), ${principal.orgId}, ${principal.userId ?? null},
              'actualizar', 'record', ${id},
              ${JSON.stringify({
                resolucao_de_conflito: true,
                escolhida: dados.revisao_escolhida,
                nova_revisao: resultado.revisionId,
                // A nota é do revisor, não do técnico: é uma decisão de
                // gestão, não um dado pessoal (restrição 9).
                nota: dados.nota ?? null,
              })}::text::jsonb)
    `;

    return {
      resolvido: true,
      revisao: resultado.revisionId,
      revision_no: resultado.revisionNo,
      status: resultado.status,
      problemas: resultado.problemas,
    };
  }

  @Delete(':id')
  async apagar(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const registo = await this.registo(id, principal.orgId);
    const permissoes = await this.acesso.permissoes(principal, registo.form_id);
    if (!permissoes?.pode_apagar) throw new ForbiddenException('sem permissão para apagar');
    const feito = await this.registos.apagar(id, principal.orgId, principal.userId ?? null);
    return { apagado: feito, tombstone: true };
  }

  @Post(':id/restore')
  async restaurar(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const registo = await this.registo(id, principal.orgId, { incluirApagados: true });
    const permissoes = await this.acesso.permissoes(principal, registo.form_id);
    if (!permissoes?.pode_apagar) throw new ForbiddenException('sem permissão para restaurar');
    const feito = await this.registos.restaurar(id, principal.orgId, principal.userId ?? null);
    return { restaurado: feito };
  }

  // ── Auxiliares ─────────────────────────────────────────────────────────────

  private resposta(resultado: Awaited<ReturnType<RecordsService['gravarRevisao']>>) {
    return {
      record_id: resultado.recordId,
      revision_id: resultado.revisionId,
      revision_no: resultado.revisionNo,
      status: resultado.status,
      conflito: resultado.conflito,
      // Os problemas são devolvidos, mas a revisão FOI gravada. Recusar
      // deixaria o trabalho de campo preso no telefone.
      problemas: resultado.problemas,
    };
  }

  private async registo(
    id: string,
    orgId: string,
    opcoes: { incluirApagados?: boolean } = {},
  ): Promise<{
    id: string;
    form_id: string;
    project_id: string;
    form_version_id: string;
    current_revision_id: string | null;
    created_by: string | null;
    status: string;
  }> {
    const [linha] = await this.sql<
      Array<{
        id: string;
        form_id: string;
        project_id: string;
        form_version_id: string;
        current_revision_id: string | null;
        created_by: string | null;
        status: string;
      }>
    >`
      SELECT id, form_id, project_id, form_version_id, current_revision_id, created_by, status
      FROM records
      WHERE id = ${id} AND org_id = ${orgId}
        ${opcoes.incluirApagados ? this.sql`` : this.sql`AND deleted_at IS NULL`}
    `;
    if (!linha) throw new NotFoundException('registo inexistente');
    return linha;
  }

  private async exigirLeitura(principal: Principal, formId: string): Promise<void> {
    const permissoes = await this.acesso.permissoes(principal, formId);
    if (!permissoes) throw new ForbiddenException('este formulário não lhe está atribuído');
  }

  private async versao(
    formId: string,
    numero?: number,
  ): Promise<{ id: string; definicao: FormDefinition }> {
    const [linha] = await this.sql<Array<{ id: string; definition: FormDefinition }>>`
      SELECT id, definition FROM form_versions
      WHERE form_id = ${formId} AND published_at IS NOT NULL
        ${numero ? this.sql`AND version = ${numero}` : this.sql``}
      ORDER BY version DESC LIMIT 1
    `;
    if (!linha) throw new NotFoundException('o formulário não tem versão publicada');
    return { id: linha.id, definicao: linha.definition };
  }

  private async versaoPorId(id: string): Promise<{ id: string; definicao: FormDefinition }> {
    const [linha] = await this.sql<Array<{ id: string; definition: FormDefinition }>>`
      SELECT id, definition FROM form_versions WHERE id = ${id}
    `;
    if (!linha) throw new NotFoundException('versão de formulário inexistente');
    return { id: linha.id, definicao: linha.definition };
  }
}

/** `If-Match` pode vir com aspas, como manda o HTTP. */
function limparEtag(valor: string | undefined): string | null {
  if (!valor) return null;
  const limpo = valor.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
  return limpo === '' || limpo === '*' ? null : limpo;
}
