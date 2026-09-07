import {
  BadRequestException,
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
} from '@nestjs/common';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { formVersions, forms, projects } from '@cvforms/db/schema';
import {
  guiaoDeDescarga,
  lerAnexosParaExportacao,
  lerParaExportacao,
  manifestoCsv,
  paraCsv,
  paraGeoJson,
  relatorioDeQualidade,
} from '@cvforms/db';
import type { FormDefinition } from '@cvforms/form-core';
import type { FastifyReply } from 'fastify';
import type postgres from 'postgres';

import { ArmazenamentoService } from '../attachments/armazenamento.service.js';
import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { FormsAccessService } from '../forms/forms-access.service.js';
import { Papeis } from '../auth/roles.decorator.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import { uuidv7 } from '../lib/uuidv7.js';
import type { Principal } from '../auth/principal.js';

/**
 * Exportações (F10.1 a F10.3 e F10.5).
 *
 * Saem sempre das vistas geradas: é lá que uma data é uma data e um ponto é
 * geometria. E saem com os rótulos que o técnico lê, não com os `id` internos
 * — um ficheiro cheio de `f_cod` é ilegível para quem o abre no Excel.
 *
 * Cada exportação fica no registo de auditoria. Saber quem levou os dados para
 * fora é metade do que torna um cadastro auditável.
 */
@Controller('admin/exports')
@Papeis('admin', 'gestor')
export class ExportsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql; pool: postgres.Sql },
    private readonly acesso: FormsAccessService,
    private readonly armazenamento: ArmazenamentoService,
  ) {}

  @Get(':formId')
  @Header('Cache-Control', 'no-store')
  async exportar(
    @UtilizadorActual() principal: Principal,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Query('format') formato = 'csv',
    @Query('bbox') caixa?: string,
    @Query('status') estado?: string,
    @Query('limite') limite?: string,
  ) {
    const contexto = await this.contexto(principal, formId);
    const bbox = lerBbox(caixa);

    const comum = {
      // As vistas vivem fora do alcance do papel restrito; a exportação é uma
      // operação administrativa e corre com a ligação do dono.
      sql: this.holder.pool,
      definition: contexto.definicao,
      projectKey: contexto.projectKey,
      formKey: contexto.formKey,
      ...(bbox ? { bbox } : {}),
      ...(estado ? { estado } : {}),
      ...(limite ? { limite: Number(limite) } : {}),
    };

    await this.auditar(principal, formId, formato);

    if (formato === 'geojson') {
      resposta.header('content-type', 'application/geo+json; charset=utf-8');
      resposta.header('content-disposition', `attachment; filename="${contexto.formKey}.geojson"`);
      return paraGeoJson(comum);
    }

    if (formato === 'csv') {
      const tabela = await lerParaExportacao(comum);
      resposta.header('content-type', 'text/csv; charset=utf-8');
      resposta.header('content-disposition', `attachment; filename="${contexto.formKey}.csv"`);
      return paraCsv(tabela);
    }

    if (formato === 'json') {
      const tabela = await lerParaExportacao(comum);
      return {
        cabecalhos: tabela.cabecalhos,
        colunas: tabela.colunas,
        linhas: tabela.linhas,
      };
    }

    throw new BadRequestException(
      'formato desconhecido; usa csv, geojson ou json. O GPKG sai do GeoJSON com ogr2ogr — ver docs/QGIS.md',
    );
  }

  /**
   * Anexos (F10.3): manifesto com o caminho relativo de cada ficheiro.
   *
   * Não devolve os ficheiros. Devolve onde cada um deve ficar e um URL
   * assinado de onde o buscar — a mesma decisão da F9.3, e pela mesma razão:
   * gigabytes de fotografias não passam pela API. O `format=sh` dá um guião
   * de `curl` que constrói a árvore de pastas sozinho.
   *
   * Os URLs expiram. É de propósito: um manifesto que ficasse a valer para
   * sempre seria uma chave permanente para todas as fotografias de um
   * formulário, guardada num ficheiro de texto na pasta de transferências de
   * alguém.
   */
  @Get(':formId/anexos')
  @Header('Cache-Control', 'no-store')
  async anexos(
    @UtilizadorActual() principal: Principal,
    @Param('formId') formId: string,
    @Res({ passthrough: true }) resposta: FastifyReply,
    @Query('format') formato = 'json',
    @Query('expira_s') expiraS?: string,
  ) {
    const contexto = await this.contexto(principal, formId);
    const validade = Math.min(Math.max(Number(expiraS) || VALIDADE_PADRAO_S, 300), VALIDADE_MAX_S);

    const anexos = (
      await lerAnexosParaExportacao(this.holder.pool, formId, contexto.definicao)
    ).map((anexo) => ({
      ...anexo,
      url: this.armazenamento.paraDescarregar(anexo.storage_key, validade).url,
    }));

    await this.auditar(principal, formId, `anexos:${formato}`);

    if (formato === 'sh') {
      resposta.header('content-type', 'text/x-shellscript; charset=utf-8');
      resposta.header(
        'content-disposition',
        `attachment; filename="descarregar-${contexto.formKey}.sh"`,
      );
      return guiaoDeDescarga(anexos);
    }

    if (formato === 'csv') {
      resposta.header('content-type', 'text/csv; charset=utf-8');
      resposta.header(
        'content-disposition',
        `attachment; filename="${contexto.formKey}-anexos.csv"`,
      );
      // Sem os URLs: um CSV é para ler e arquivar, e um URL assinado dentro de
      // um ficheiro arquivado é um segredo que ninguém sabe que tem.
      return manifestoCsv(anexos);
    }

    if (formato === 'json') {
      return {
        total: anexos.length,
        bytes: anexos.reduce((soma, a) => soma + (a.bytes ?? 0), 0),
        expira_em: new Date(Date.now() + validade * 1000).toISOString(),
        anexos,
      };
    }

    throw new BadRequestException('formato desconhecido; usa json, csv ou sh');
  }

  /**
   * Relatório de qualidade (F10.5): pontos acima do limiar de precisão, com a
   * justificação que o técnico escreveu.
   */
  @Get(':formId/qualidade')
  async qualidade(@UtilizadorActual() principal: Principal, @Param('formId') formId: string) {
    const contexto = await this.contexto(principal, formId);
    const linhas = await relatorioDeQualidade(this.holder.pool, formId, contexto.definicao);
    return {
      total: linhas.length,
      sem_justificacao: linhas.filter((l) => !l.justificacao?.trim()).length,
      linhas,
    };
  }

  private async contexto(principal: Principal, formId: string) {
    const [formulario] = await this.db
      .select({ key: forms.key, projectId: forms.projectId })
      .from(forms)
      .where(and(eq(forms.id, formId), eq(forms.orgId, principal.orgId)))
      .limit(1);
    if (!formulario) throw new NotFoundException('formulário inexistente nesta organização');

    const permissoes = await this.acesso.permissoes(principal, formId);
    // Um gestor sem atribuição a este formulário não exporta os seus dados. A
    // exportação é a forma mais fácil de tirar dados de campo do sistema.
    if (!permissoes && !principal.roles.includes('admin')) {
      throw new NotFoundException('formulário inexistente nesta organização');
    }

    const [projecto] = await this.db
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, formulario.projectId))
      .limit(1);

    const [versao] = await this.db
      .select({ definition: formVersions.definition })
      .from(formVersions)
      .where(and(eq(formVersions.formId, formId), isNotNull(formVersions.publishedAt)))
      .orderBy(desc(formVersions.version))
      .limit(1);
    if (!versao) throw new NotFoundException('o formulário ainda não tem versão publicada');

    return {
      formKey: formulario.key,
      projectKey: projecto?.key ?? 'projecto',
      definicao: versao.definition as FormDefinition,
    };
  }

  private async auditar(principal: Principal, formId: string, formato: string): Promise<void> {
    await this.holder.pool`
      INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, metadata)
      VALUES (${uuidv7()}, ${principal.orgId}, ${principal.userId ?? null}, 'exportar',
              'form', ${formId}, ${JSON.stringify({ formato })}::text::jsonb)
    `;
  }
}

/** 15 minutos chegam para arrancar um download; o guião retoma o que faltar. */
const VALIDADE_PADRAO_S = 900;
/**
 * Tecto de 12 horas: descarregar 40 GB por uma ligação de Luanda leva uma
 * noite, e obrigar a repetir a exportação a meio seria pior do que o risco de
 * um URL de leitura durar até de manhã.
 */
const VALIDADE_MAX_S = 12 * 60 * 60;

function lerBbox(valor: string | undefined): [number, number, number, number] | undefined {
  if (!valor) return undefined;
  const partes = valor.split(',').map(Number);
  if (partes.length !== 4 || partes.some((n) => !Number.isFinite(n))) {
    throw new BadRequestException('bbox é oeste,sul,este,norte em graus decimais');
  }
  return partes as [number, number, number, number];
}
