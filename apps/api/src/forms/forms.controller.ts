import {
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
} from '@nestjs/common';
import { and, desc, eq, gt, isNotNull } from 'drizzle-orm';
import { buildManifest, generateViews } from '@cvforms/db';
import { formVersions, forms, projects } from '@cvforms/db/schema';
import type { FormDefinition } from '@cvforms/form-core';

import { DB, type Db } from '../db/db.module.js';
import { FormsAccessService } from './forms-access.service.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import type { Principal } from '../auth/principal.js';

/**
 * O lado do cliente: o que a app móvel descarrega antes de ir para o mato.
 *
 * Tudo aqui é filtrado pelas atribuições. Um técnico sem atribuição não recebe
 * a definição — nem sequer sabe que o formulário existe (ESPECIFICACAO §2).
 */
@Controller('forms')
export class FormsController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly acesso: FormsAccessService,
  ) {}

  /**
   * Formulários atribuídos. Com `updated_since`, só os que mudaram — é o que
   * evita descarregar tudo outra vez numa rede que se paga ao megabyte.
   */
  @Get()
  async listar(
    @UtilizadorActual() principal: Principal,
    @Query('updated_since') updatedSince?: string,
  ) {
    if (!principal.userId) return { formularios: [] };
    const atribuidos = await this.acesso.formulariosDe(principal.userId);
    if (atribuidos.length === 0) return { formularios: [] };

    const desde = updatedSince ? new Date(updatedSince) : undefined;
    const formularios = [];

    for (const atribuido of atribuidos) {
      const [versao] = await this.db
        .select({
          id: formVersions.id,
          version: formVersions.version,
          hash: formVersions.hash,
          publishedAt: formVersions.publishedAt,
        })
        .from(formVersions)
        .where(
          and(
            eq(formVersions.formId, atribuido.form_id),
            isNotNull(formVersions.publishedAt),
            desde && !Number.isNaN(desde.getTime())
              ? gt(formVersions.publishedAt, desde)
              : undefined,
          ),
        )
        .orderBy(desc(formVersions.version))
        .limit(1);

      if (!versao) continue; // ou não tem versão publicada, ou não mudou

      formularios.push({
        form_id: atribuido.form_id,
        key: atribuido.key,
        titulo: atribuido.titulo,
        projecto_id: atribuido.projecto_id,
        versao: versao.version,
        hash: versao.hash,
        publicado_em: versao.publishedAt,
        permissoes: {
          criar: atribuido.pode_criar,
          editar_proprios: atribuido.pode_editar_proprios,
          editar_todos: atribuido.pode_editar_todos,
          apagar: atribuido.pode_apagar,
        },
      });
    }

    return { formularios };
  }

  @Get(':id')
  async detalhe(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const permissoes = await this.exigirAcesso(principal, id);
    const [versao] = await this.versaoPublicada(id);
    if (!versao) throw new NotFoundException('o formulário ainda não tem versão publicada');
    return {
      form_id: id,
      key: permissoes.key,
      titulo: permissoes.titulo,
      versao_corrente: versao.version,
      hash: versao.hash,
      publicado_em: versao.publishedAt,
    };
  }

  /**
   * A definição completa de uma versão. É isto que a app guarda no SQLite e a
   * partir do qual constrói os ecrãs, sem nunca ter sido recompilada.
   *
   * Continua a servir versões antigas de propósito: um registo criado com a v3
   * abre com a v3 mesmo depois de sair a v4 (ESPECIFICACAO §10).
   */
  @Get(':id/versions/:version')
  @Header('Cache-Control', 'private, max-age=31536000, immutable')
  async definicao(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    await this.exigirAcesso(principal, id);
    const numero = Number(version);
    if (!Number.isInteger(numero) || numero < 1) {
      throw new NotFoundException('versão inválida');
    }

    const [versao] = await this.db
      .select({
        definition: formVersions.definition,
        hash: formVersions.hash,
        publishedAt: formVersions.publishedAt,
      })
      .from(formVersions)
      .where(and(eq(formVersions.formId, id), eq(formVersions.version, numero)))
      .limit(1);

    if (!versao?.publishedAt) throw new NotFoundException('versão não publicada');
    return { hash: versao.hash, publicado_em: versao.publishedAt, definicao: versao.definition };
  }

  /**
   * Manifesto: hashes das listas de escolha, media a descarregar, e as vistas
   * geradas. A app compara os hashes e só descarrega o que mudou.
   */
  @Get(':id/manifest')
  async manifesto(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirAcesso(principal, id);
    const [versao] = await this.versaoPublicada(id);
    if (!versao) throw new NotFoundException('o formulário ainda não tem versão publicada');

    const [formulario] = await this.db
      .select({ key: forms.key, projectId: forms.projectId })
      .from(forms)
      .where(eq(forms.id, id))
      .limit(1);
    const [projecto] = await this.db
      .select({ key: projects.key })
      .from(projects)
      .where(eq(projects.id, formulario!.projectId))
      .limit(1);

    const definicao = versao.definition as FormDefinition;
    const vistas = generateViews({
      definition: definicao,
      projectKey: projecto?.key ?? 'projecto',
      formKey: formulario?.key ?? 'formulario',
      formId: id,
      formVersionId: versao.id,
    });

    return buildManifest(definicao, vistas, versao.publishedAt?.toISOString() ?? null);
  }

  private versaoPublicada(formId: string) {
    return this.db
      .select({
        id: formVersions.id,
        version: formVersions.version,
        hash: formVersions.hash,
        publishedAt: formVersions.publishedAt,
        definition: formVersions.definition,
      })
      .from(formVersions)
      .where(and(eq(formVersions.formId, formId), isNotNull(formVersions.publishedAt)))
      .orderBy(desc(formVersions.version))
      .limit(1);
  }

  private async exigirAcesso(principal: Principal, formId: string) {
    const permissoes = await this.acesso.permissoes(principal, formId);
    // 403 e não 404: mentir sobre a existência esconderia um erro de
    // atribuição atrás de um erro que parece do cliente, e alguém ia perder
    // uma tarde a procurar um formulário que existe e não lhe foi dado.
    if (!permissoes) throw new ForbiddenException('este formulário não lhe está atribuído');
    return permissoes;
  }
}
