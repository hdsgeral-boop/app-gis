/**
 * F10.8 — arquivo de revisões antigas (dívida do ADR-0007).
 *
 * Este ficheiro existe para vigiar a coisa mais perigosa que esta base faz:
 * tirar uma linha de `record_revisions`. A restrição inegociável 4 continua de
 * pé — nenhuma revisão se perde — e é aqui que isso se prova, com os casos em
 * que uma implementação distraída perderia dados sem dar erro.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7 } from '@cvforms/form-core';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const projecto = randomUUID();
const formulario = randomUUID();
const versao = randomUUID();

/** Bem antes de qualquer corte que os testes usem. */
const ANTIGA = '2024-01-01T00:00:00Z';
const CORTE = '2025-01-01T00:00:00Z';

/**
 * Cria um registo com N revisões antigas mais uma corrente.
 *
 * O `server_received_at` é escrito à mão: sem isso, todas as revisões nascem
 * com `now()` e nunca há nada elegível para arquivar.
 */
async function criarRegisto(
  opcoes: { revisoes: number; estado?: string; comAnexo?: boolean; comPonto?: boolean } = {
    revisoes: 3,
  },
): Promise<{ recordId: string; ids: string[] }> {
  const recordId = uuidv7();
  await sql`INSERT INTO records (id, org_id, project_id, form_id, form_version_id, status)
            VALUES (${recordId}, ${org}, ${projecto}, ${formulario}, ${versao},
                    ${(opcoes.estado ?? 'submetido') as string}::record_status)`;

  const ids: string[] = [];
  for (let n = 1; n <= opcoes.revisoes; n++) {
    const id = uuidv7();
    ids.push(id);
    await sql`
      INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data,
                                    base_revision_id, server_received_at)
      VALUES (${id}, ${recordId}, ${n}, ${versao},
              ${JSON.stringify({ f_cod: `v${n}`, f_nota: 'x'.repeat(200) })}::text::jsonb,
              ${ids[n - 2] ?? null}, ${ANTIGA}::timestamptz)
    `;
  }
  await sql`UPDATE records SET current_revision_id = ${ids[ids.length - 1]!} WHERE id = ${recordId}`;

  if (opcoes.comAnexo) {
    await sql`INSERT INTO attachments (id, record_id, revision_id, field_id, upload_state)
              VALUES (${uuidv7()}, ${recordId}, ${ids[0]!}, 'f_foto', 'concluido')`;
  }
  if (opcoes.comPonto) {
    await sql`INSERT INTO gps_fixes (id, record_id, revision_id, field_id, lat, lon,
                                     accuracy_m, fix_type, source)
              VALUES (${uuidv7()}, ${recordId}, ${ids[0]!}, 'f_geo', -8.8, 13.2, 0.5, 'fixed', 'external_tcp')`;
  }
  return { recordId, ids };
}

async function arquivar(limite = 1000) {
  const [linha] = await sql<Array<{ arquivadas: string }>>`
    SELECT arquivadas FROM cvf_arquivar_revisoes(${formulario}, ${CORTE}::timestamptz, ${limite})
  `;
  return Number(linha!.arquivadas);
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });
  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'q' + org.slice(0, 8)}, 'Org')`;
  await sql`INSERT INTO projects (id, org_id, key, name)
            VALUES (${projecto}, ${org}, ${'p' + projecto.slice(0, 6)}, 'P')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
            VALUES (${formulario}, ${org}, ${projecto}, 'arq', ${sql.json({ pt: 'A' })}, 1)`;
  await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
            VALUES (${versao}, ${formulario}, 1, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:x', now())`;
}, 120_000);

beforeEach(async () => {
  if (!url) return;
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM gps_fixes WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM attachments WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM record_revisions_frias WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM records WHERE form_id = ${formulario}`;
  await sql`SET session_replication_role = origin`;
});

afterAll(async () => {
  if (!url) return;
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM gps_fixes WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM attachments WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM record_revisions_frias WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formulario})`;
  await sql`DELETE FROM records WHERE form_id = ${formulario}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${formulario}`;
  await sql`DELETE FROM forms WHERE id = ${formulario}`;
  await sql`DELETE FROM projects WHERE id = ${projecto}`;
  await sql`DELETE FROM organizations WHERE id = ${org}`;
  await sql?.end();
}, 120_000);

suite('restrição 4 — uma revisão não sai sem estar segura noutro sítio', () => {
  it('apagar uma revisão sem cópia arquivada continua a ser recusado', async () => {
    const { ids } = await criarRegisto({ revisoes: 2 });
    await expect(sql`DELETE FROM record_revisions WHERE id = ${ids[0]!}`).rejects.toThrow(
      /append-only/,
    );
  });

  it('uma cópia adulterada não deixa apagar o original', async () => {
    // Uma cópia truncada ou alterada é PIOR do que não haver cópia nenhuma: dá
    // a sensação de que os dados estão salvos.
    const { ids } = await criarRegisto({ revisoes: 2 });
    await sql`
      INSERT INTO record_revisions_frias (id, record_id, revision_no, form_version_id, data,
                                          server_received_at, conteudo_sha256)
      SELECT id, record_id, revision_no, form_version_id, data, server_received_at,
             'sha256-que-nao-e-o-verdadeiro'
      FROM record_revisions WHERE id = ${ids[0]!}
    `;
    await expect(sql`DELETE FROM record_revisions WHERE id = ${ids[0]!}`).rejects.toThrow(
      /não confere/,
    );
    const [ainda] = await sql`SELECT id FROM record_revisions WHERE id = ${ids[0]!}`;
    expect(ainda).toBeDefined();
  });

  it('o UPDATE de uma revisão continua a ser recusado, sem excepção nenhuma', async () => {
    const { ids } = await criarRegisto({ revisoes: 1 });
    await expect(
      sql`UPDATE record_revisions SET data = '{}'::jsonb WHERE id = ${ids[0]!}`,
    ).rejects.toThrow(/append-only/);
  });
});

suite('F10.8 — o que se arquiva e o que fica', () => {
  it('arquiva as antigas e o conteúdo fica byte a byte igual', async () => {
    const { ids } = await criarRegisto({ revisoes: 3 });
    const [antes] = await sql<Array<{ data: unknown }>>`
      SELECT data FROM record_revisions WHERE id = ${ids[0]!}
    `;

    expect(await arquivar()).toBe(2);

    const [depois] = await sql<Array<{ data: unknown }>>`
      SELECT data FROM record_revisions_frias WHERE id = ${ids[0]!}
    `;
    expect(depois!.data).toEqual(antes!.data);
  });

  it('a revisão corrente nunca é arquivada', async () => {
    // É o que se mostra no ecrã. Arquivá-la deixava o registo sem conteúdo.
    const { recordId, ids } = await criarRegisto({ revisoes: 3 });
    await arquivar();
    const quentes = await sql<Array<{ id: string }>>`
      SELECT id FROM record_revisions WHERE record_id = ${recordId}
    `;
    expect(quentes.map((q) => q.id)).toEqual([ids[2]!]);
  });

  it('um registo em needs_review não é tocado', async () => {
    // Está por decidir; decidir sem ver os dois ramos é decidir às cegas.
    await criarRegisto({ revisoes: 3, estado: 'needs_review' });
    expect(await arquivar()).toBe(0);
  });

  it('uma revisão com anexo não é arquivada', async () => {
    // O ficheiro no armazenamento aponta para ela; quebrar a ligação deixa-o
    // órfão e ninguém volta a saber de que registo era.
    const { ids } = await criarRegisto({ revisoes: 3, comAnexo: true });
    await arquivar();
    const [ainda] = await sql`SELECT id FROM record_revisions WHERE id = ${ids[0]!}`;
    expect(ainda).toBeDefined();
  });

  it('uma revisão com pontos GNSS não é arquivada', async () => {
    const { ids } = await criarRegisto({ revisoes: 3, comPonto: true });
    await arquivar();
    const [ainda] = await sql`SELECT id FROM record_revisions WHERE id = ${ids[0]!}`;
    expect(ainda).toBeDefined();
  });

  it('uma revisão recente não é arquivada, mesmo que já não seja a corrente', async () => {
    const { recordId, ids } = await criarRegisto({ revisoes: 2 });
    const recente = uuidv7();
    await sql`
      INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data,
                                    base_revision_id, server_received_at)
      VALUES (${recente}, ${recordId}, 3, ${versao}, ${sql.json({ f_cod: 'v3' })},
              ${ids[1]!}, now())
    `;
    await sql`UPDATE records SET current_revision_id = ${recente} WHERE id = ${recordId}`;

    await arquivar();
    const [ainda] = await sql`SELECT id FROM record_revisions WHERE id = ${ids[1]!}`;
    // A 2 é base de uma revisão que ainda não é arquivável: sem ela, a cadeia
    // de `base_revision_id` deixa de se poder seguir na tabela quente.
    expect(ainda).toBeDefined();
  });

  it('recusa uma data de corte recente em vez de arquivar trabalho de ontem', async () => {
    await expect(
      sql`SELECT * FROM cvf_arquivar_revisoes(${formulario}, now(), 100)`,
    ).rejects.toThrow(/demasiado recente/);
  });

  it('o limite é respeitado, para não segurar a base numa transacção enorme', async () => {
    await criarRegisto({ revisoes: 6 });
    expect(await arquivar(2)).toBe(2);
    expect(await arquivar(2)).toBe(2);
  });
});

suite('F10.8 — o histórico continua inteiro depois de arquivar', () => {
  it('a vista mostra as revisões todas, quentes e frias', async () => {
    const { recordId } = await criarRegisto({ revisoes: 4 });
    await arquivar();

    const todas = await sql<Array<{ revision_no: number; arquivada: boolean }>>`
      SELECT revision_no, arquivada FROM record_revisions_todas
      WHERE record_id = ${recordId} ORDER BY revision_no
    `;
    expect(todas.map((t) => t.revision_no)).toEqual([1, 2, 3, 4]);
    expect(todas.map((t) => t.arquivada)).toEqual([true, true, true, false]);
  });

  it('conta o que daria para arquivar sem arquivar nada', async () => {
    // Para se decidir com um número em vez de com uma intuição.
    const { recordId } = await criarRegisto({ revisoes: 3 });
    const [possivel] = await sql<Array<{ revisoes: string; bytes: string }>>`
      SELECT * FROM cvf_arquivo_possivel(${CORTE}::timestamptz)
    `;
    expect(Number(possivel!.revisoes)).toBeGreaterThanOrEqual(2);
    expect(Number(possivel!.bytes)).toBeGreaterThan(0);

    const quentes = await sql`SELECT id FROM record_revisions WHERE record_id = ${recordId}`;
    expect(quentes).toHaveLength(3);
  });
});
