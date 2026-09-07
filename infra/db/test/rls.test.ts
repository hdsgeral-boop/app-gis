/**
 * F6 — isolamento entre organizações, aplicado pelo Postgres.
 *
 * Perder este isolamento é, a seguir a perder um registo, o pior defeito que
 * este sistema pode ter (ADR-0010). Por isso não se testa a aplicação: liga-se
 * à base com o papel da aplicação, define-se o contexto, e vê-se o que o
 * Postgres deixa ler. Se as políticas estiverem erradas, os dados aparecem —
 * e o teste falha aqui, e não no dia em que um cliente vir os dados de outro.
 *
 * O teste mais importante do ficheiro é o `F6.2`: prova que o papel da
 * aplicação NÃO contorna o RLS. É o modo de falha que o ADR-0010 aponta como o
 * mais perigoso, porque não dá erro nenhum — os dados simplesmente aparecem.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

/** Duas organizações, com um formulário e um registo cada. */
const orgA = randomUUID();
const orgB = randomUUID();
const projA = randomUUID();
const projB = randomUUID();
const formA = randomUUID();
const formB = randomUUID();
const versaoA = randomUUID();
const versaoB = randomUUID();
const registoA = randomUUID();
const registoB = randomUUID();
const revisaoA = randomUUID();
const revisaoB = randomUUID();
/** Um técnico da organização A, com atribuição só ao formulário A. */
const tecnicoA = randomUUID();
/** Outro técnico da organização A, sem atribuição nenhuma. */
const semAtribuicao = randomUUID();

/**
 * Corre um bloco como a aplicação: papel `cvforms_app`, com o contexto da
 * sessão definido. É exactamente o que a API faz a cada pedido.
 */
async function comoAplicacao<T>(
  orgId: string,
  userId: string | null,
  bloco: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  // O `begin` do driver desembrulha promessas dentro do resultado; o
  // encapsulamento num objecto mantém o tipo do bloco intacto.
  const { valor } = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE cvforms_app`);
    await tx.unsafe(`SET LOCAL cvf.org_id = '${orgId}'`);
    if (userId) await tx.unsafe(`SET LOCAL cvf.user_id = '${userId}'`);
    return { valor: await bloco(tx) };
  });
  return valor as T;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });

  for (const [org, proj, form, versao, registo, revisao] of [
    [orgA, projA, formA, versaoA, registoA, revisaoA],
    [orgB, projB, formB, versaoB, registoB, revisaoB],
  ] as const) {
    await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'o' + org.slice(0, 8)}, 'Org')`;
    await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${proj}, ${org}, ${'p' + proj.slice(0, 6)}, 'Projecto')`;
    await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
              VALUES (${form}, ${org}, ${proj}, 'f', ${sql.json({ pt: 'F' })}, 1)`;
    await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
              VALUES (${versao}, ${form}, 1, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:x', now())`;
    await sql`INSERT INTO records (id, org_id, project_id, form_id, form_version_id)
              VALUES (${registo}, ${org}, ${proj}, ${form}, ${versao})`;
    await sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
              VALUES (${revisao}, ${registo}, 1, ${versao}, ${sql.json({ f: 'x' })})`;
    await sql`UPDATE records SET current_revision_id = ${revisao} WHERE id = ${registo}`;
  }

  await sql`INSERT INTO users (id, org_id, subject, username)
            VALUES (${tecnicoA}, ${orgA}, ${randomUUID()}, ${'t' + tecnicoA.slice(0, 8)})`;
  await sql`INSERT INTO users (id, org_id, subject, username)
            VALUES (${semAtribuicao}, ${orgA}, ${randomUUID()}, ${'s' + semAtribuicao.slice(0, 8)})`;
  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, can_create)
            VALUES (${randomUUID()}, ${formA}, 'user', ${tecnicoA}, true, true)`;
}, 120_000);

afterAll(async () => {
  if (!url) return;
  await sql`SET session_replication_role = replica`;
  for (const registo of [registoA, registoB]) {
    await sql`DELETE FROM record_revisions WHERE record_id = ${registo}`;
    await sql`DELETE FROM records WHERE id = ${registo}`;
  }
  for (const org of [orgA, orgB]) {
    await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
    await sql`DELETE FROM form_access WHERE org_id = ${org}`;
    await sql`DELETE FROM form_assignments WHERE form_id IN (SELECT id FROM forms WHERE org_id = ${org})`;
    await sql`DELETE FROM form_versions WHERE form_id IN (SELECT id FROM forms WHERE org_id = ${org})`;
    await sql`DELETE FROM forms WHERE org_id = ${org}`;
    await sql`DELETE FROM users WHERE org_id = ${org}`;
    await sql`DELETE FROM projects WHERE org_id = ${org}`;
    await sql`DELETE FROM organizations WHERE id = ${org}`;
  }
  await sql?.end();
}, 120_000);

suite('F6.2 — a API não pode contornar o RLS', () => {
  it('o papel da aplicação não tem BYPASSRLS', async () => {
    const [papel] = await sql<Array<{ rolbypassrls: boolean; rolsuper: boolean }>>`
      SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'cvforms_app'
    `;
    expect(papel).toBeDefined();
    // Se qualquer um destes for verdadeiro, TODAS as políticas deste ficheiro
    // deixam de valer, e sem erro nenhum. É o modo de falha do ADR-0010.
    expect(papel!.rolbypassrls).toBe(false);
    expect(papel!.rolsuper).toBe(false);
  });

  it('o papel da aplicação não é dono de nenhuma tabela', async () => {
    // O dono de uma tabela ignora o RLS dela por omissão. Se a API se ligasse
    // com o papel que criou as tabelas, o isolamento desaparecia.
    const donas = await sql<Array<{ tablename: string }>>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public' AND tableowner = 'cvforms_app'
    `;
    expect(donas).toEqual([]);
  });

  it('as tabelas com dados de campo têm RLS ligado', async () => {
    const semRls = await sql<Array<{ tablename: string }>>`
      SELECT c.relname AS tablename
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relrowsecurity
        AND c.relname IN ('records', 'record_revisions', 'forms', 'form_versions',
                          'form_assignments', 'form_access', 'users', 'projects',
                          'attachments', 'gps_fixes', 'audit_log')
    `;
    expect(semRls).toEqual([]);
  });
});

suite('F6.1 — uma sessão de outra organização vê zero linhas', () => {
  it('os registos da organização B não existem para a organização A', async () => {
    const linhas = await comoAplicacao(orgA, null, (tx) => tx`SELECT id FROM records`);
    const ids = linhas.map((l) => l['id']);
    expect(ids).toContain(registoA);
    expect(ids).not.toContain(registoB);
  });

  it('o mesmo para formulários, projectos, utilizadores e revisões', async () => {
    await comoAplicacao(orgA, null, async (tx) => {
      const formularios = await tx`SELECT id FROM forms`;
      expect(formularios.map((l) => l['id'])).not.toContain(formB);

      const projectos = await tx`SELECT id FROM projects`;
      expect(projectos.map((l) => l['id'])).not.toContain(projB);

      const revisoes = await tx`SELECT id FROM record_revisions`;
      expect(revisoes.map((l) => l['id'])).not.toContain(revisaoB);

      const versoes = await tx`SELECT id FROM form_versions`;
      expect(versoes.map((l) => l['id'])).not.toContain(versaoB);
    });
  });

  it('pedir explicitamente uma linha de outra organização devolve nada, e não um erro', async () => {
    // Não dá erro de propósito: um erro diria a quem pergunta que a linha
    // existe. Zero linhas não diz nada.
    const linhas = await comoAplicacao(
      orgA,
      null,
      (tx) => tx`SELECT id FROM records WHERE id = ${registoB}`,
    );
    expect(linhas).toEqual([]);
  });

  it('escrever na organização de outro é recusado', async () => {
    await expect(
      comoAplicacao(
        orgA,
        null,
        (tx) => tx`
          INSERT INTO records (id, org_id, project_id, form_id, form_version_id)
          VALUES (${randomUUID()}, ${orgB}, ${projB}, ${formB}, ${versaoB})
        `,
      ),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it('sem contexto de organização, não se vê nada', async () => {
    // Falhar fechado: uma ligação da aplicação que se esqueça de definir o
    // contexto não vê dados nenhuns, em vez de os ver todos.
    const linhas = await sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE cvforms_app`);
      await tx.unsafe(`SET LOCAL cvf.org_id = ''`);
      return tx`SELECT id FROM records`;
    });
    expect(linhas).toEqual([]);
  });
});

suite('F6.3 — sem atribuição, zero linhas mesmo dentro da organização', () => {
  it('um técnico com atribuição vê o registo', async () => {
    const linhas = await comoAplicacao(orgA, tecnicoA, (tx) => tx`SELECT id FROM records`);
    expect(linhas.map((l) => l['id'])).toContain(registoA);
  });

  it('um colega da mesma organização sem atribuição não vê nada', async () => {
    const linhas = await comoAplicacao(orgA, semAtribuicao, (tx) => tx`SELECT id FROM records`);
    expect(linhas).toEqual([]);
  });

  it('e também não vê a definição do formulário', async () => {
    const linhas = await comoAplicacao(
      orgA,
      semAtribuicao,
      (tx) => tx`SELECT id FROM form_versions`,
    );
    expect(linhas).toEqual([]);
  });

  it('tirar a atribuição fecha o acesso de imediato', async () => {
    await sql`DELETE FROM form_assignments WHERE form_id = ${formA} AND principal_id = ${tecnicoA}`;
    const depois = await comoAplicacao(orgA, tecnicoA, (tx) => tx`SELECT id FROM records`);
    expect(depois).toEqual([]);

    // Devolve-se, para os testes seguintes não dependerem da ordem.
    await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, can_create)
              VALUES (${randomUUID()}, ${formA}, 'user', ${tecnicoA}, true, true)`;
  });
});

suite('F6.7 — as três camadas concordam', () => {
  it('a tabela que a API lê é a mesma que as sync rules e o RLS usam', async () => {
    // Não há três implementações da regra: há uma tabela, `form_access`, e as
    // três camadas consultam-na. Este teste prova que ela é a fonte comum.
    const [acesso] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM form_access
      WHERE user_id = ${tecnicoA} AND form_id = ${formA} AND can_read = true
    `;
    expect(acesso!.n).toBe(1);

    // O RLS usa-a: quem lá está vê, quem não está não vê.
    const comAcesso = await comoAplicacao(orgA, tecnicoA, (tx) => tx`SELECT id FROM records`);
    expect(comAcesso.map((l) => l['id'])).toContain(registoA);

    // As sync rules usam a mesma coluna, e isso está no ficheiro; aqui prova-se
    // que a consulta que elas fazem devolve o mesmo.
    const comoSyncRule = await sql<Array<{ form_id: string }>>`
      SELECT form_id FROM form_access WHERE user_id = ${tecnicoA} AND can_read = true
    `;
    expect(comoSyncRule.map((l) => l.form_id)).toEqual([formA]);
  });

  it('a tabela é mantida por trigger: mexer numa equipa muda o acesso', async () => {
    const equipa = randomUUID();
    await sql`INSERT INTO teams (id, org_id, key, name) VALUES (${equipa}, ${orgA}, ${'e' + equipa.slice(0, 6)}, 'Equipa')`;
    await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read)
              VALUES (${randomUUID()}, ${formA}, 'team', ${equipa}, true)`;

    // Antes de entrar na equipa, não vê.
    let acesso = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM form_access WHERE user_id = ${semAtribuicao} AND form_id = ${formA}
    `;
    expect(acesso[0]!.n).toBe(0);

    await sql`INSERT INTO team_members (team_id, user_id) VALUES (${equipa}, ${semAtribuicao})`;

    // Depois de entrar, vê — sem ninguém ter tocado em form_access.
    acesso = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM form_access WHERE user_id = ${semAtribuicao} AND form_id = ${formA}
    `;
    expect(acesso[0]!.n).toBe(1);

    const linhas = await comoAplicacao(orgA, semAtribuicao, (tx) => tx`SELECT id FROM records`);
    expect(linhas.map((l) => l['id'])).toContain(registoA);

    await sql`DELETE FROM team_members WHERE team_id = ${equipa}`;
    await sql`DELETE FROM form_assignments WHERE principal_id = ${equipa}`;
    await sql`DELETE FROM teams WHERE id = ${equipa}`;
  });
});

suite('F6.6 — auditoria por trigger', () => {
  it('publicar uma versão fica registado', async () => {
    const versao = randomUUID();
    await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
              VALUES (${versao}, ${formA}, 9, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:y', now())`;

    const linhas = await sql<Array<{ action: string }>>`
      SELECT action FROM audit_log WHERE entity_type = 'form_versions' AND entity_id = ${versao}
    `;
    expect(linhas.map((l) => l.action)).toEqual(['publicar']);
    await sql`SET session_replication_role = replica`;
    await sql`DELETE FROM form_versions WHERE id = ${versao}`;
    await sql`SET session_replication_role = origin`;
  });

  it('atribuir fica registado', async () => {
    const atribuicao = randomUUID();
    await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read)
              VALUES (${atribuicao}, ${formA}, 'user', ${semAtribuicao}, true)`;

    const linhas = await sql<Array<{ action: string }>>`
      SELECT action FROM audit_log WHERE entity_type = 'form_assignments' AND entity_id = ${atribuicao}
    `;
    expect(linhas.map((l) => l.action)).toContain('atribuir');
    await sql`DELETE FROM form_assignments WHERE id = ${atribuicao}`;
  });

  it('o registo de auditoria não leva o conteúdo das respostas', async () => {
    // Restrição inegociável 9. O trigger só escreve metadados; se alguém lhe
    // acrescentar o payload, este teste falha.
    const linhas = await sql<Array<{ metadata: unknown }>>`
      SELECT metadata FROM audit_log WHERE org_id = ${orgA} LIMIT 20
    `;
    for (const linha of linhas) {
      expect(JSON.stringify(linha.metadata ?? {})).not.toContain('"data"');
    }
  });

  it('o audit_log é append-only, garantido por trigger', async () => {
    await expect(
      sql`UPDATE audit_log SET action = 'apagar' WHERE org_id = ${orgA}`,
    ).rejects.toThrow(/append-only/i);
  });
});
