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
import { and, eq, inArray } from 'drizzle-orm';
import { roles, teamMembers, teams, userRoles, users } from '@cvforms/db/schema';
import { z } from 'zod';
import type postgres from 'postgres';

import { DB, DB_CLIENT, type Db } from '../db/db.module.js';
import { Papeis } from '../auth/roles.decorator.js';
import { UtilizadorActual } from '../auth/current-user.decorator.js';
import { uuidv7 } from '../lib/uuidv7.js';
import type { Principal } from '../auth/principal.js';

/**
 * Utilizadores, papéis e equipas (F6.5).
 *
 * Antes disto, pôr um técnico a trabalhar obrigava a escrever SQL à mão numa
 * consola de produção — que é a operação mais perigosa que este sistema tem,
 * porque corre como dono das tabelas e o dono ignora o RLS.
 *
 * DUAS COISAS QUE ESTE CONTROLADOR NÃO FAZ, de propósito:
 *
 * 1. **Não cria utilizadores.** A verdade da identidade está no Keycloak
 *    (ADR-0006); a tabela `users` é um espelho, preenchido no primeiro login.
 *    Criar aqui uma linha sem `subject` daria um utilizador que nunca
 *    consegue entrar, e alguém ia passar uma tarde a perceber porquê.
 * 2. **Não mexe nos papéis do realm.** Os papéis de aqui (`roles`) são os da
 *    organização, e servem para atribuir formulários a um grupo de pessoas.
 *    Quem é `admin` decide-se no Keycloak, e não numa tabela que o próprio
 *    administrador pode editar.
 *
 * Tudo o que muda aqui dispara o recálculo de `form_access` por trigger
 * (migração 0003). Nenhuma destas rotas escreve nessa tabela.
 */
const papeisDoUtilizador = z.object({
  /** Substitui os papéis todos. Uma lista vazia tira-lhe todos. */
  papeis: z.array(z.string().uuid()).max(50),
});

const criarEquipa = z.object({
  key: z
    .string()
    .min(1)
    .max(63)
    .regex(/^[a-z0-9_]+$/, 'a chave é minúsculas, dígitos e underscore'),
  nome: z.string().min(1).max(200),
});

const membrosDaEquipa = z.object({
  /** Substitui a lista de membros. */
  utilizadores: z.array(z.string().uuid()).max(500),
});

@Controller('admin')
@Papeis('admin', 'gestor')
export class PessoasController {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(DB_CLIENT) private readonly holder: { client: postgres.Sql },
  ) {}

  /**
   * Utilizadores da organização, com papéis e equipas.
   *
   * Numa consulta e não em N+1: uma organização com 300 técnicos daria 601
   * viagens à base para desenhar uma tabela.
   */
  @Get('users')
  async utilizadores(@UtilizadorActual() principal: Principal) {
    const linhas = await this.holder.client<
      Array<{
        id: string;
        username: string;
        display_name: string | null;
        email: string | null;
        active: boolean;
        last_seen_at: Date | null;
        papeis: Array<{ id: string; key: string; name: string }> | null;
        equipas: Array<{ id: string; key: string; name: string }> | null;
        formularios: number;
      }>
    >`
      SELECT u.id, u.username, u.display_name, u.email, u.active, u.last_seen_at,
             (SELECT json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name))
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id
              WHERE ur.user_id = u.id) AS papeis,
             (SELECT json_agg(json_build_object('id', t.id, 'key', t.key, 'name', t.name))
              FROM team_members tm JOIN teams t ON t.id = tm.team_id
              WHERE tm.user_id = u.id) AS equipas,
             (SELECT count(*)::int FROM form_access fa
              WHERE fa.user_id = u.id AND fa.can_read) AS formularios
      FROM users u
      WHERE u.org_id = ${principal.orgId}
      ORDER BY u.username
    `;

    return {
      utilizadores: linhas.map((l) => ({
        ...l,
        papeis: l.papeis ?? [],
        equipas: l.equipas ?? [],
      })),
    };
  }

  @Get('roles')
  async papeis(@UtilizadorActual() principal: Principal) {
    const linhas = await this.db
      .select({ id: roles.id, key: roles.key, name: roles.name, sistema: roles.system })
      .from(roles)
      .where(eq(roles.orgId, principal.orgId));
    return { papeis: linhas };
  }

  @Post('users/:id/roles')
  async definirPapeis(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = papeisDoUtilizador.parse(body);
    await this.exigirUtilizador(principal, id);

    // Os papéis têm de ser todos desta organização. Sem esta verificação, um
    // gestor podia atribuir o papel de outra organização e, com ele, as
    // atribuições de formulário que lhe estivessem penduradas.
    if (dados.papeis.length) {
      const validos = await this.db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.orgId, principal.orgId), inArray(roles.id, dados.papeis)));
      if (validos.length !== new Set(dados.papeis).size) {
        throw new BadRequestException('há papéis que não existem nesta organização');
      }
    }

    await this.holder.client.begin(async (tx) => {
      await tx`DELETE FROM user_roles WHERE user_id = ${id}`;
      for (const papel of new Set(dados.papeis)) {
        await tx`INSERT INTO user_roles (user_id, role_id) VALUES (${id}, ${papel})`;
      }
    });

    return { papeis: dados.papeis.length };
  }

  @Get('teams')
  async equipas(@UtilizadorActual() principal: Principal) {
    const linhas = await this.holder.client<
      Array<{ id: string; key: string; name: string; membros: number }>
    >`
      SELECT t.id, t.key, t.name,
             (SELECT count(*)::int FROM team_members tm WHERE tm.team_id = t.id) AS membros
      FROM teams t WHERE t.org_id = ${principal.orgId} ORDER BY t.name
    `;
    return { equipas: linhas };
  }

  @Post('teams')
  async criarEquipa(@UtilizadorActual() principal: Principal, @Body() body: unknown) {
    const dados = criarEquipa.parse(body);
    const id = uuidv7();
    try {
      await this.db
        .insert(teams)
        .values({ id, orgId: principal.orgId, key: dados.key, name: dados.nome });
    } catch {
      throw new BadRequestException('já existe uma equipa com essa chave nesta organização');
    }
    return { id, key: dados.key, name: dados.nome };
  }

  @Get('teams/:id/members')
  async verMembros(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirEquipa(principal, id);
    const linhas = await this.db
      .select({ id: users.id, username: users.username, nome: users.displayName })
      .from(teamMembers)
      .innerJoin(users, eq(users.id, teamMembers.userId))
      .where(eq(teamMembers.teamId, id));
    return { membros: linhas };
  }

  /**
   * Substitui a lista de membros de uma equipa.
   *
   * Substituir e não somar: o ecrã mostra uma lista de caixas, e o que o
   * utilizador vê ao carregar em «guardar» é o estado final. Um endpoint que
   * somasse obrigaria o ecrã a calcular as diferenças, e as diferenças
   * calculadas no cliente perdem-se quando duas pessoas editam ao mesmo tempo.
   */
  @Post('teams/:id/members')
  async definirMembros(
    @UtilizadorActual() principal: Principal,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const dados = membrosDaEquipa.parse(body);
    await this.exigirEquipa(principal, id);

    if (dados.utilizadores.length) {
      const validos = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, principal.orgId), inArray(users.id, dados.utilizadores)));
      if (validos.length !== new Set(dados.utilizadores).size) {
        throw new BadRequestException('há utilizadores que não existem nesta organização');
      }
    }

    await this.holder.client.begin(async (tx) => {
      await tx`DELETE FROM team_members WHERE team_id = ${id}`;
      for (const utilizador of new Set(dados.utilizadores)) {
        await tx`INSERT INTO team_members (team_id, user_id) VALUES (${id}, ${utilizador})`;
      }
    });

    return { membros: new Set(dados.utilizadores).size };
  }

  @Delete('teams/:id')
  async apagarEquipa(@UtilizadorActual() principal: Principal, @Param('id') id: string) {
    await this.exigirEquipa(principal, id);
    // As atribuições de formulário à equipa vão com ela, por cascata, e o
    // recálculo do acesso é disparado por trigger. Nenhum registo é tocado:
    // apagar uma equipa é uma operação administrativa, não de dados.
    await this.db.delete(teams).where(eq(teams.id, id));
    return { apagada: true };
  }

  private async exigirUtilizador(principal: Principal, id: string): Promise<void> {
    const [linha] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, id), eq(users.orgId, principal.orgId)))
      .limit(1);
    if (!linha) throw new NotFoundException('utilizador inexistente nesta organização');
  }

  private async exigirEquipa(principal: Principal, id: string): Promise<void> {
    const [linha] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.id, id), eq(teams.orgId, principal.orgId)))
      .limit(1);
    if (!linha) throw new NotFoundException('equipa inexistente nesta organização');
  }
}
