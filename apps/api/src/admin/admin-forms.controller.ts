import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { archiveForm, publishVersion } from '@cvforms/db';
import { formAssignments, formVersions, forms, projects } from '@cvforms/db/schema';
import {
  checkFormDefinitionSchema,
  diffDefinitions,
  exportXlsForm,
  importXlsForm,
  validateDefinition,
  type FormDefinition,
} from '@cvforms/form-core';
import type postgres from 'postgres';

import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { FormsAccessService } from '../forms/forms-access.service.js';
import { Papeis } from '../auth/roles.decorator.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import { uuidv7 } from '../lib/uuidv7.js';
import type { Principal } from '../auth/principal.js';

/**
 * O lado do administrador: desenhar, versionar e publicar.
 *
 * O `POST /publish` é o coração da F2: corre o pipeline completo da §5 da
 * especificação — validar, calcular o diff, gravar a versão imutável, gerar as
 * vistas PostGIS, registar os índices — tudo dentro de uma transacção.
 */
const chaveSql = z
  .string()
  .min(1)
  .max(48)
  .regex(/^[a-z][a-z0-9_]*$/, 'a chave só aceita minúsculas, dígitos e sublinhado');

const rotulo = z.object({ pt: z.string().min(1) }).catchall(z.string());

const criarFormulario = z.object({
  projecto_id: z.string().uuid(),
  key: chaveSql,
  titulo: rotulo,
});

const guardarRascunho = z.object({
  definicao: z.unknown(),
});

const publicar = z.object({
  definicao: z.unknown().optional(),
  confirmar_incompativel: z.boolean().optional(),
});

const atribuir = z.object({
  principal_type: z.enum(['user', 'role', 'team']),
  principal_id: z.string().uuid(),
  pode_ler: z.boolean().default(true),
  pode_criar: z.boolean().default(false),
  pode_editar_proprios: z.boolean().default(false),
  pode_editar_todos: z.boolean().default(false),
  pode_apagar: z.boolean().default(false),
  scope_filter: z.unknown().optional(),
});

const linhaXls = z.record(z.string(), z.string());
const importarXlsForm = z.object({
  projecto_id: z.string().uuid(),
  key: chaveSql.optional(),
  survey: z.array(linhaXls),
  choices: z.array(linhaXls).default([]),
  settings: z.array(linhaXls).optional(),
  /** Só valida e devolve o resultado, sem criar nada. */
  simular: z.boolean().default(false),
});

@Controller('admin/forms')
@Papeis('admin', 'gestor')
export class AdminFormsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    // O `pool` e não o `client`: publicar cria e apaga VISTAS, que é DDL, e o
    // papel restrito da aplicação não tem — nem deve ter — esses direitos.
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql; pool: postgres.Sql },
    private readonly acesso: FormsAccessService,
  ) {}

  @Get()
  async listar(@UtilizadorActual() principal: Principal) {
    const linhas = await this.db
      .select({
        id: forms.id,
        key: forms.key,
        titulo: forms.title,
        projecto_id: forms.projectId,
        versao_corrente: forms.currentVersion,
        arquivado_em: forms.archivedAt,
      })
      .from(forms)
      .where(eq(forms.orgId, principal.orgId))
      .orderBy(forms.key);
    return { formularios: linhas };
  }

  @Post()
  async criar(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = criarFormulario.parse(body);
    const [projecto] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, dados.projecto_id), eq(projects.orgId, principal.orgId)))
      .limit(1);
    if (!projecto) throw new NotFoundException('projecto inexistente nesta organização');

    const id = uuidv7();
    await this.db.insert(forms).values({
      id,
      orgId: principal.orgId,
      projectId: dados.projecto_id,
      key: dados.key,
      title: dados.titulo,
      createdBy: principal.userId ?? null,
    });
    return { form_id: id, key: dados.key };
  }

  /**
   * Guarda um rascunho. Valida sempre — e devolve os problemas em vez de os
   * recusar, porque um rascunho a meio de ser desenhado está quase sempre
   * inválido e isso não é motivo para perder o trabalho.
   */
  @Post(':id/versions')
  async rascunho(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const { definicao } = guardarRascunho.parse(body);
    const formulario = await this.exigirFormulario(principal, id);
    const proxima = (formulario.versao_corrente ?? 0) + 1;

    const preparada = this.prepararDefinicao(definicao, id, proxima);
    const problemas = await this.validar(preparada, principal);

    await this.db
      .delete(formVersions)
      .where(and(eq(formVersions.formId, id), isNull(formVersions.publishedAt)));
    const versaoId = uuidv7();
    await this.db.insert(formVersions).values({
      id: versaoId,
      formId: id,
      version: proxima,
      definition: preparada,
      hash: 'rascunho',
    });

    return { versao: proxima, version_id: versaoId, problemas, valido: problemas.length === 0 };
  }

  /** Diff entre uma versão e a anterior, para o painel mostrar antes de publicar. */
  @Post(':id/versions/:version/diff')
  async diff(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    await this.exigirFormulario(principal, id);
    const numero = Number(version);
    const corpo = publicar.parse(body ?? {});

    const nova = corpo.definicao
      ? this.prepararDefinicao(corpo.definicao, id, numero)
      : ((await this.versao(id, numero))?.definition as FormDefinition | undefined);
    if (!nova) throw new NotFoundException('versão inexistente');

    const anterior = (await this.versaoPublicadaAnterior(id, numero))?.definition as
      FormDefinition | undefined;
    if (!anterior) {
      return { primeira_versao: true, compativel: true, alteracoes: [] };
    }

    const resultado = diffDefinitions(anterior, nova);
    return {
      primeira_versao: false,
      compativel: resultado.compatible,
      alteracoes: resultado.entries,
    };
  }

  /**
   * Publica. Corre o pipeline completo da §5 da especificação, numa só
   * transacção: ou fica tudo, ou não fica nada.
   */
  @Post(':id/publish')
  async publicar(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const corpo = publicar.parse(body ?? {});
    const formulario = await this.exigirFormulario(principal, id);
    const proxima = (formulario.versao_corrente ?? 0) + 1;

    const origem = corpo.definicao ?? (await this.rascunhoDe(id))?.definition;
    if (!origem) {
      throw new BadRequestException('não há rascunho para publicar nem definição no pedido');
    }
    const definicao = this.prepararDefinicao(origem, id, proxima);

    const [projecto] = await this.db
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, formulario.projecto_id))
      .limit(1);

    const anterior = (await this.versaoPublicadaAnterior(id, proxima))?.definition as
      FormDefinition | undefined;

    const resultado = await publishVersion(this.holder.pool, {
      definition: definicao,
      formId: id,
      projectKey: projecto?.key ?? 'projecto',
      formKey: formulario.key,
      publishedBy: principal.userId ?? null,
      knownFormIds: await this.acesso.formIdsDaOrganizacao(principal.orgId),
      ...(anterior ? { previous: anterior } : {}),
      ...(corpo.confirmar_incompativel ? { confirmIncompatible: true } : {}),
    });

    if (!resultado.ok) {
      // 409 e não 400: o pedido está bem formado; o que está em causa é o
      // estado — alterações incompatíveis por confirmar, ou uma definição que
      // não passa o validador.
      throw new ConflictException({
        message: 'a publicação não foi feita',
        problemas: resultado.issues,
        diff: resultado.diff ?? null,
      });
    }

    return {
      versao: definicao.version,
      version_id: resultado.formVersionId,
      hash: resultado.hash,
      diff: resultado.diff ?? null,
      vistas: resultado.views?.views.map((v) => ({
        nome: v.name,
        esquema: resultado.views!.schema,
        repetivel: v.repeatFieldId,
        colunas: v.columns.length,
      })),
      indices: resultado.views?.indexes.map((i) => i.name) ?? [],
    };
  }

  /** Arquivar apaga as vistas geradas. Nunca apaga um registo. */
  @Delete(':id')
  @Papeis('admin')
  async arquivar(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirFormulario(principal, id);
    const vistas = await archiveForm(this.holder.pool, id);
    return { arquivado: true, vistas_apagadas: vistas };
  }

  @Get(':id/assignments')
  async verAtribuicoes(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirFormulario(principal, id);
    const linhas = await this.db
      .select()
      .from(formAssignments)
      .where(eq(formAssignments.formId, id));
    return { atribuicoes: linhas };
  }

  @Post(':id/assignments')
  async atribuir(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = atribuir.parse(body);
    await this.exigirFormulario(principal, id);

    await this.db
      .insert(formAssignments)
      .values({
        id: uuidv7(),
        formId: id,
        principalType: dados.principal_type,
        principalId: dados.principal_id,
        canRead: dados.pode_ler,
        canCreate: dados.pode_criar,
        canEditOwn: dados.pode_editar_proprios,
        canEditAll: dados.pode_editar_todos,
        canDelete: dados.pode_apagar,
        scopeFilter: dados.scope_filter ?? null,
      })
      .onConflictDoUpdate({
        target: [
          formAssignments.formId,
          formAssignments.principalType,
          formAssignments.principalId,
        ],
        set: {
          canRead: dados.pode_ler,
          canCreate: dados.pode_criar,
          canEditOwn: dados.pode_editar_proprios,
          canEditAll: dados.pode_editar_todos,
          canDelete: dados.pode_apagar,
          scopeFilter: dados.scope_filter ?? null,
        },
      });
    return { atribuido: true };
  }

  /**
   * Importa um XLSForm já lido em linhas.
   *
   * O `form-core` não lê `.xlsx` de propósito — corre no telefone, onde um
   * leitor de folhas de cálculo não tem nada que fazer. Quem tem o ficheiro
   * converte-o em linhas e manda-as para aqui.
   */
  @Post('import/xlsform')
  async importar(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = importarXlsForm.parse(body);
    const formId = uuidv7();

    const importado = importXlsForm(
      {
        survey: dados.survey,
        choices: dados.choices,
        ...(dados.settings ? { settings: dados.settings } : {}),
      },
      { formId },
    );

    const resposta = {
      ok: importado.ok,
      erros: importado.errors,
      perdas: importado.losses,
      definicao: importado.definition,
      key_do_xlsform: importado.formKey ?? null,
    };

    if (dados.simular || !importado.ok) return resposta;

    const key = dados.key ?? sanearChave(importado.formKey ?? 'importado');
    const [projecto] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, dados.projecto_id), eq(projects.orgId, principal.orgId)))
      .limit(1);
    if (!projecto) throw new NotFoundException('projecto inexistente nesta organização');

    await this.db.insert(forms).values({
      id: formId,
      orgId: principal.orgId,
      projectId: dados.projecto_id,
      key,
      title: importado.definition.title,
      createdBy: principal.userId ?? null,
    });
    await this.db.insert(formVersions).values({
      id: uuidv7(),
      formId,
      version: 1,
      definition: importado.definition,
      hash: 'rascunho',
    });

    return { ...resposta, form_id: formId, key };
  }

  @Get(':id/export')
  async exportar(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Query('format') format = 'json',
  ) {
    await this.exigirFormulario(principal, id);
    const versao = (await this.ultimaVersao(id))?.definition as FormDefinition | undefined;
    if (!versao) throw new NotFoundException('o formulário ainda não tem nenhuma versão');

    if (format === 'json') return versao;
    if (format === 'xlsform') {
      const { workbook, losses } = exportXlsForm(versao);
      return { workbook, perdas: losses };
    }
    throw new BadRequestException('formato desconhecido; usa json ou xlsform');
  }

  // ── Auxiliares ─────────────────────────────────────────────────────────────

  /**
   * Impõe no servidor o que não pode vir do cliente: o `form_id` e o número da
   * versão. Um cliente que mandasse outro `form_id` estaria a escrever numa
   * definição que não é a dele.
   */
  private prepararDefinicao(entrada: unknown, formId: string, versao: number): FormDefinition {
    const candidata = {
      ...(entrada as Record<string, unknown>),
      spec_version: 1,
      form_id: formId,
      version: versao,
    };
    const resultado = checkFormDefinitionSchema(candidata);
    if (!resultado.ok) {
      throw new BadRequestException({
        message: 'a definição não respeita o formato',
        problemas: resultado.issues,
      });
    }
    return resultado.definition;
  }

  private async validar(definicao: FormDefinition, principal: Principal) {
    const conhecidos = await this.acesso.formIdsDaOrganizacao(principal.orgId);
    return validateDefinition(definicao, { knownFormIds: conhecidos }).issues;
  }

  private async exigirFormulario(principal: Principal, id: string) {
    const [formulario] = await this.db
      .select({
        id: forms.id,
        key: forms.key,
        projecto_id: forms.projectId,
        versao_corrente: forms.currentVersion,
      })
      .from(forms)
      .where(and(eq(forms.id, id), eq(forms.orgId, principal.orgId)))
      .limit(1);
    if (!formulario) throw new NotFoundException('formulário inexistente nesta organização');
    return formulario;
  }

  private async versao(formId: string, version: number) {
    const [linha] = await this.db
      .select({ definition: formVersions.definition, publishedAt: formVersions.publishedAt })
      .from(formVersions)
      .where(and(eq(formVersions.formId, formId), eq(formVersions.version, version)))
      .limit(1);
    return linha;
  }

  private async rascunhoDe(formId: string) {
    const [linha] = await this.db
      .select({ definition: formVersions.definition })
      .from(formVersions)
      .where(and(eq(formVersions.formId, formId), isNull(formVersions.publishedAt)))
      .orderBy(desc(formVersions.version))
      .limit(1);
    return linha;
  }

  private async ultimaVersao(formId: string) {
    const [linha] = await this.db
      .select({ definition: formVersions.definition })
      .from(formVersions)
      .where(eq(formVersions.formId, formId))
      .orderBy(desc(formVersions.version))
      .limit(1);
    return linha;
  }

  private async versaoPublicadaAnterior(formId: string, antesDe: number) {
    const linhas = await this.db
      .select({ definition: formVersions.definition, version: formVersions.version })
      .from(formVersions)
      .where(and(eq(formVersions.formId, formId), isNotNull(formVersions.publishedAt)))
      .orderBy(desc(formVersions.version))
      .limit(5);
    return linhas.find((l) => l.version < antesDe);
  }
}

function sanearChave(raw: string): string {
  const limpo = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return /^[a-z]/.test(limpo) ? limpo : `f_${limpo || 'importado'}`;
}
