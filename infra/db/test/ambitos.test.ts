/**
 * F6.4 — âmbitos: um técnico do Bengo não vê registos do Uíge.
 *
 * Testado contra o Postgres e com o papel da aplicação, pela mesma razão do
 * `rls.test.ts`: o que interessa não é o que a API filtra, é o que a base
 * deixa ler. Um filtro de âmbito que só existisse na aplicação seria uma
 * promessa por escrito e nada mais.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const projecto = randomUUID();
const formulario = randomUUID();
const versao = randomUUID();

/** O `id` do campo que define o âmbito. É um id de campo, não um nome. */
const CAMPO_AMBITO = 'q_municipio';

/** Um registo por município, mais um com o município por responder. */
const registoBengo = randomUUID();
const registoUige = randomUUID();
const registoSemAmbito = randomUUID();

/** Só vê o Bengo. */
const tecnicoBengo = randomUUID();
/** Sem filtro: vê tudo o que lhe está atribuído. */
const supervisor = randomUUID();
/** Vê o Bengo e o Uíge, por duas atribuições diferentes. */
const tecnicoDeDois = randomUUID();
/** Recolheu o registo do Uíge, e só vê o Bengo. */
const recolheuNoUige = randomUUID();

const equipa = randomUUID();

async function comoAplicacao<T>(
  userId: string | null,
  bloco: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  const { valor } = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE cvforms_app`);
    await tx.unsafe(`SET LOCAL cvf.org_id = '${org}'`);
    if (userId) await tx.unsafe(`SET LOCAL cvf.user_id = '${userId}'`);
    return { valor: await bloco(tx) };
  });
  return valor as T;
}

/** Ids dos registos que aquele utilizador consegue ler. */
async function registosVisiveis(userId: string): Promise<string[]> {
  const linhas = await comoAplicacao(userId, async (tx) => {
    return tx<
      Array<{ id: string }>
    >`SELECT id FROM records WHERE form_id = ${formulario} ORDER BY id`;
  });
  return linhas.map((l) => l.id);
}

async function criarRegisto(id: string, municipio: string | null, autor: string | null) {
  const revisao = randomUUID();
  await sql`INSERT INTO records (id, org_id, project_id, form_id, form_version_id, created_by)
            VALUES (${id}, ${org}, ${projecto}, ${formulario}, ${versao}, ${autor})`;
  const dados = municipio === null ? {} : { [CAMPO_AMBITO]: municipio };
  await sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
            VALUES (${revisao}, ${id}, 1, ${versao}, ${JSON.stringify(dados)}::text::jsonb)`;
  await sql`UPDATE records SET current_revision_id = ${revisao} WHERE id = ${id}`;
  return revisao;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });

  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'a' + org.slice(0, 8)}, 'Org')`;
  await sql`INSERT INTO projects (id, org_id, key, name)
            VALUES (${projecto}, ${org}, ${'p' + projecto.slice(0, 6)}, 'Projecto')`;
  // O campo de âmbito declara-se ANTES de haver registos — ver o trigger
  // `forms_ambito_estavel`, que é testado mais abaixo.
  await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version, scope_field_id)
            VALUES (${formulario}, ${org}, ${projecto}, 'f', ${sql.json({ pt: 'F' })}, 1, ${CAMPO_AMBITO})`;
  await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
            VALUES (${versao}, ${formulario}, 1, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:x', now())`;

  for (const [id, nome] of [
    [tecnicoBengo, 'b'],
    [supervisor, 's'],
    [tecnicoDeDois, 'd'],
    [recolheuNoUige, 'r'],
  ] as const) {
    await sql`INSERT INTO users (id, org_id, subject, username)
              VALUES (${id}, ${org}, ${randomUUID()}, ${nome + id.slice(0, 8)})`;
  }

  await criarRegisto(registoBengo, 'Bengo', null);
  await criarRegisto(registoUige, 'Uíge', recolheuNoUige);
  await criarRegisto(registoSemAmbito, null, null);

  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, scope_filter)
            VALUES (${randomUUID()}, ${formulario}, 'user', ${tecnicoBengo}, true,
                    ${JSON.stringify({ valores: ['Bengo'] })}::text::jsonb)`;
  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read)
            VALUES (${randomUUID()}, ${formulario}, 'user', ${supervisor}, true)`;
  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, scope_filter)
            VALUES (${randomUUID()}, ${formulario}, 'user', ${recolheuNoUige}, true,
                    ${JSON.stringify({ valores: ['Bengo'] })}::text::jsonb)`;

  // O `tecnicoDeDois` recebe um âmbito por atribuição directa e outro por
  // equipa: é o caso que prova que os âmbitos se juntam em vez de o último
  // ganhar.
  await sql`INSERT INTO teams (id, org_id, key, name) VALUES (${equipa}, ${org}, ${'e' + equipa.slice(0, 6)}, 'Equipa')`;
  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, scope_filter)
            VALUES (${randomUUID()}, ${formulario}, 'user', ${tecnicoDeDois}, true,
                    ${JSON.stringify({ valores: ['Bengo'] })}::text::jsonb)`;
  await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, scope_filter)
            VALUES (${randomUUID()}, ${formulario}, 'team', ${equipa}, true,
                    ${JSON.stringify({ valores: ['Uíge'] })}::text::jsonb)`;
  await sql`INSERT INTO team_members (team_id, user_id) VALUES (${equipa}, ${tecnicoDeDois})`;
}, 120_000);

afterAll(async () => {
  if (!url) return;
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM records WHERE form_id = ${formulario}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
  await sql`DELETE FROM form_access_scopes WHERE org_id = ${org}`;
  await sql`DELETE FROM form_access WHERE org_id = ${org}`;
  await sql`DELETE FROM form_assignments WHERE form_id = ${formulario}`;
  await sql`DELETE FROM team_members WHERE team_id = ${equipa}`;
  await sql`DELETE FROM teams WHERE org_id = ${org}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${formulario}`;
  await sql`DELETE FROM forms WHERE org_id = ${org}`;
  await sql`DELETE FROM users WHERE org_id = ${org}`;
  await sql`DELETE FROM projects WHERE org_id = ${org}`;
  await sql`DELETE FROM organizations WHERE id = ${org}`;
  await sql?.end();
}, 120_000);

suite('F6.4 — o âmbito filtra os registos', () => {
  it('um técnico do Bengo não vê registos do Uíge', async () => {
    const visiveis = await registosVisiveis(tecnicoBengo);
    expect(visiveis).toContain(registoBengo);
    expect(visiveis).not.toContain(registoUige);
  });

  it('sem filtro, vê os registos todos do formulário', async () => {
    const visiveis = await registosVisiveis(supervisor);
    expect(visiveis).toContain(registoBengo);
    expect(visiveis).toContain(registoUige);
    expect(visiveis).toContain(registoSemAmbito);
  });

  it('um registo sem âmbito respondido não é visto por quem tem filtro', async () => {
    // Falha fechada, e de propósito: um registo cujo âmbito não se sabe não
    // pode ser atribuído a um âmbito.
    const visiveis = await registosVisiveis(tecnicoBengo);
    expect(visiveis).not.toContain(registoSemAmbito);
  });

  it('quem recolheu continua a ver o que recolheu, fora do seu âmbito', async () => {
    // ADR-0011. Sem isto, mudar o âmbito de alguém escondia-lhe trabalho que
    // ainda podia estar por sincronizar — e perder um registo de campo é o
    // pior defeito possível.
    const visiveis = await registosVisiveis(recolheuNoUige);
    expect(visiveis).toContain(registoUige);
  });

  it('as revisões de um registo fora do âmbito também não se lêem', async () => {
    // A política de `record_revisions` filtra por `record_id IN (SELECT ...
    // FROM records)`, e essa subconsulta corre com o RLS de `records`. Se
    // assim não fosse, o filtro valia para a lista e não para as respostas.
    const linhas = await comoAplicacao(tecnicoBengo, async (tx) => {
      return tx<Array<{ id: string }>>`
        SELECT id FROM record_revisions WHERE record_id = ${registoUige}
      `;
    });
    expect(linhas).toEqual([]);
  });

  it('o âmbito segue a revisão corrente', async () => {
    // Corrigir o município de um registo tem de o mudar de âmbito. Se o
    // `scope_value` ficasse preso à primeira revisão, uma correcção nunca
    // chegava a quem passava a ser responsável por ele.
    const revisao = randomUUID();
    await sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
              VALUES (${revisao}, ${registoBengo}, 2, ${versao},
                      ${JSON.stringify({ [CAMPO_AMBITO]: 'Uíge' })}::text::jsonb)`;
    await sql`UPDATE records SET current_revision_id = ${revisao} WHERE id = ${registoBengo}`;

    try {
      expect(await registosVisiveis(tecnicoBengo)).not.toContain(registoBengo);
      expect(await registosVisiveis(tecnicoDeDois)).toContain(registoBengo);
    } finally {
      const [primeira] = await sql<Array<{ id: string }>>`
        SELECT id FROM record_revisions WHERE record_id = ${registoBengo} AND revision_no = 1
      `;
      await sql`UPDATE records SET current_revision_id = ${primeira!.id} WHERE id = ${registoBengo}`;
      await sql`SET session_replication_role = replica`;
      await sql`DELETE FROM record_revisions WHERE id = ${revisao}`;
      await sql`SET session_replication_role = origin`;
    }
  });
});

suite('F6.4 — como os âmbitos de várias atribuições se juntam', () => {
  it('dois filtros diferentes somam-se', async () => {
    const visiveis = await registosVisiveis(tecnicoDeDois);
    expect(visiveis).toContain(registoBengo);
    expect(visiveis).toContain(registoUige);
  });

  it('uma atribuição sem filtro apaga o filtro das outras', async () => {
    // «A mais permissiva ganha» é a regra que já valia para as permissões, e
    // vale para o âmbito pela mesma razão: entrar numa equipa nunca pode tirar
    // acesso a alguém.
    await sql`UPDATE form_assignments SET scope_filter = NULL
              WHERE form_id = ${formulario} AND principal_type = 'team' AND principal_id = ${equipa}`;
    try {
      const [acesso] = await sql<Array<{ scope_values: string[] | null }>>`
        SELECT scope_values FROM form_access WHERE user_id = ${tecnicoDeDois} AND form_id = ${formulario}
      `;
      expect(acesso!.scope_values).toBeNull();
      expect(await registosVisiveis(tecnicoDeDois)).toContain(registoSemAmbito);
    } finally {
      await sql`UPDATE form_assignments SET scope_filter = ${JSON.stringify({ valores: ['Uíge'] })}::text::jsonb
                WHERE form_id = ${formulario} AND principal_type = 'team' AND principal_id = ${equipa}`;
    }
  });

  it('há uma linha em form_access_scopes por valor permitido', async () => {
    // É desta tabela que o PowerSync tira os buckets: as parameter queries não
    // percorrem arrays. Se ela divergir do `scope_values`, o telefone recebe
    // registos que o RLS lhe nega — ou deixa de receber os que lhe são
    // devidos.
    const linhas = await sql<Array<{ scope_value: string }>>`
      SELECT scope_value FROM form_access_scopes
      WHERE user_id = ${tecnicoDeDois} AND form_id = ${formulario} ORDER BY scope_value
    `;
    expect(linhas.map((l) => l.scope_value)).toEqual(['Bengo', 'Uíge']);

    const [semFiltro] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM form_access_scopes
      WHERE user_id = ${supervisor} AND form_id = ${formulario}
    `;
    expect(semFiltro!.n).toBe('0');
  });

  it('um scope_filter malformado é recusado pela base', async () => {
    // `{"valores": "Bengo"}` — texto em vez de lista. Sem esta restrição, o
    // recálculo dava um array vazio e a pessoa deixava de ver tudo, sem erro.
    await expect(
      sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, scope_filter)
          VALUES (${randomUUID()}, ${formulario}, 'user', ${supervisor}, true,
                  ${JSON.stringify({ valores: 'Bengo' })}::text::jsonb)`,
    ).rejects.toThrow(/scope_filter/);
  });
});

suite('F6.4 — o que sustenta a descida do PowerSync', () => {
  it('a revisão carrega o âmbito dos seus próprios dados', async () => {
    // Não é o do registo: é intrínseco e imutável, e por isso nunca obriga a
    // reescrever uma revisão (restrição inegociável 4).
    const linhas = await sql<Array<{ scope_value: string | null }>>`
      SELECT scope_value FROM record_revisions WHERE record_id = ${registoUige}
    `;
    expect(linhas.map((l) => l.scope_value)).toEqual(['Uíge']);
  });

  it('o registo e a sua revisão corrente estão sempre no mesmo âmbito', async () => {
    // É o único invariante de que a descida depende: se o registo entra no
    // bucket, a revisão que o mostra entra também.
    const divergentes = await sql<Array<{ id: string }>>`
      SELECT r.id FROM records r
      JOIN record_revisions v ON v.id = r.current_revision_id
      WHERE r.form_id = ${formulario} AND r.scope_value IS DISTINCT FROM v.scope_value
    `;
    expect(divergentes).toEqual([]);
  });

  it('mudar o campo de âmbito de um formulário com registos é recusado', async () => {
    await expect(
      sql`UPDATE forms SET scope_field_id = 'outro' WHERE id = ${formulario}`,
    ).rejects.toThrow(/âmbito/);
  });
});
