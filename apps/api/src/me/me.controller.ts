import { Controller, Get, Inject } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { organizations, projects, roles, userRoles } from '@cvforms/db/schema';

import { DB, type Db } from '../db/db.module.js';
import { FormsAccessService } from '../forms/forms-access.service.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import type { Principal } from '../auth/principal.js';

/**
 * Perfil, papel, projectos e permissões efectivas.
 *
 * É a primeira coisa que a app chama depois de entrar, e é o que lhe diz que
 * formulários pode sequer pedir. A regra da §2 da especificação — ninguém vê
 * um formulário que não lhe foi atribuído — começa a ser aplicada aqui, e é
 * repetida pelas sync rules do PowerSync e pelas políticas RLS.
 */
@Controller('me')
export class MeController {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly acesso: FormsAccessService,
  ) {}

  @Get()
  async me(@UtilizadorActual() principal: Principal) {
    if (!principal.userId) {
      // Token válido, mas a organização ainda não existe na base. Dizer o que
      // falta vale mais do que um 500 ou uma lista vazia sem explicação.
      return {
        subject: principal.subject,
        username: principal.username,
        org: { id: principal.orgId, provisionada: false },
        papeis: principal.roles,
        projectos: [],
        formularios: [],
        aviso:
          'a organização deste token ainda não existe na base; um administrador tem de a criar',
      };
    }

    const [org] = await this.db
      .select({ id: organizations.id, key: organizations.key, name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, principal.orgId))
      .limit(1);

    const papeisInternos = await this.db
      .select({ id: roles.id, key: roles.key, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(eq(userRoles.userId, principal.userId));

    // A regra «ninguém vê um formulário que não lhe foi atribuído» vive num
    // serviço só, partilhado com /forms: duas implementações divergiriam, e o
    // ecrã diria uma coisa e o descarregamento faria outra.
    const formularios = await this.acesso.formulariosDe(principal.userId);

    const projectosVisiveis = await this.db
      .select({
        id: projects.id,
        key: projects.key,
        name: projects.name,
      })
      .from(projects)
      .where(and(eq(projects.orgId, principal.orgId), isNull(projects.archivedAt)));

    const idsComFormulario = new Set(formularios.map((f) => f.projecto_id));

    return {
      subject: principal.subject,
      username: principal.username,
      email: principal.email ?? null,
      nome: principal.displayName ?? null,
      user_id: principal.userId,
      org: org ? { ...org, provisionada: true } : { id: principal.orgId, provisionada: false },
      papeis: principal.roles,
      papeis_internos: papeisInternos,
      projectos: projectosVisiveis.filter((p) => idsComFormulario.has(p.id)),
      formularios,
    };
  }
}
