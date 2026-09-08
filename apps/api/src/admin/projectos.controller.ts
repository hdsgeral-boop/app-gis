import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { forms, projects } from '@cvforms/db/schema';
import { z } from 'zod';
import type postgres from 'postgres';

import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { Papeis } from '../auth/roles.decorator.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import { uuidv7 } from '../lib/uuidv7.js';
import type { Principal } from '../auth/principal.js';

/**
 * Projectos da organização.
 *
 * PORQUE É QUE ISTO PRECISOU DE EXISTIR. Um formulário pertence sempre a um
 * projecto (`forms.project_id` é `NOT NULL`), e até aqui a única maneira de
 * criar o primeiro projecto era um `INSERT` à mão na base ou correr a semente.
 * Numa organização nova isso era um beco fechado: o painel mostrava «não há
 * nenhum projecto» e não dava nada para carregar.
 *
 * O projecto é a fronteira que separa trabalhos diferentes dentro da mesma
 * organização — «Piloto do Bengo» e «Cadastro do Uíge» — e é por ele que os
 * mapas e as exportações se agrupam. Não é uma fronteira de segurança: essa
 * é a organização (RLS) e a atribuição do formulário.
 */
const criarProjecto = z.object({
  key: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9_]+$/, 'a chave é minúsculas, dígitos e underscore'),
  nome: z.string().min(1).max(200),
  descricao: z.string().max(2000).optional(),
});

@Controller('admin/projects')
@Papeis('admin', 'gestor')
export class ProjectosController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql },
  ) {}

  /**
   * Todos os projectos da organização, com a contagem de formulários.
   *
   * Inclui os arquivados: quem administra tem de conseguir ver que um projecto
   * antigo ainda existe, senão tenta criar outro com a mesma chave e leva com
   * um erro que parece um defeito.
   */
  @Get()
  async listar(@UtilizadorActual() principal: Principal) {
    const linhas = await this.holder.client<
      Array<{
        id: string;
        key: string;
        name: string;
        description: string | null;
        created_at: string;
        archived_at: string | null;
        formularios: number;
      }>
    >`
      SELECT p.id, p.key, p.name, p.description, p.created_at, p.archived_at,
             (SELECT count(*)::int FROM forms f WHERE f.project_id = p.id) AS formularios
      FROM projects p
      WHERE p.org_id = ${principal.orgId}
      ORDER BY p.archived_at NULLS FIRST, p.name
    `;
    return { projectos: linhas };
  }

  @Post()
  async criar(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = criarProjecto.parse(body);

    const [jaExiste] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.orgId, principal.orgId), eq(projects.key, dados.key)))
      .limit(1);
    if (jaExiste) {
      throw new BadRequestException('já existe um projecto com essa chave nesta organização');
    }

    const id = uuidv7();
    await this.db.insert(projects).values({
      id,
      orgId: principal.orgId,
      key: dados.key,
      name: dados.nome,
      description: dados.descricao ?? null,
    });
    return { id, key: dados.key, name: dados.nome };
  }

  /**
   * Arquiva um projecto. Nunca o apaga.
   *
   * Apagar levaria os formulários e, por eles, os registos de campo — que é o
   * pior defeito que este sistema pode ter. Um projecto com formulários
   * recusa-se a ser arquivado enquanto os tiver: arquivar em cascata é o
   * género de operação que se faz uma vez sem perceber e não se desfaz.
   */
  @Delete(':id')
  @Papeis('admin')
  async arquivar(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    const [projecto] = await this.db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.id, id), eq(projects.orgId, principal.orgId)))
      .limit(1);
    if (!projecto) throw new NotFoundException('projecto não encontrado');

    const [comFormulario] = await this.db
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.projectId, id), isNull(forms.archivedAt)))
      .orderBy(asc(forms.id))
      .limit(1);
    if (comFormulario) {
      throw new BadRequestException(
        'este projecto ainda tem formulários activos; arquiva-os primeiro',
      );
    }

    await this.db.update(projects).set({ archivedAt: new Date() }).where(eq(projects.id, id));
    return { arquivado: true };
  }
}
