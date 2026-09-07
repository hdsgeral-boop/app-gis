/**
 * Prova, contra um Postgres real, que as restrições inegociáveis do
 * ESPECIFICACAO.md §8 estão à prova de aplicação — que aguentam mesmo quando
 * alguém escreve SQL directamente, sem passar pela API.
 *
 * Sem DATABASE_URL definida, os testes são saltados em vez de falharem: o
 * `pnpm test` de quem só mexe no form-core não pode exigir docker a correr.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const project = randomUUID();
const form = randomUUID();
const version = randomUUID();
const record = randomUUID();
const revision = randomUUID();

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 1, onnotice: () => {} });

  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'org_' + org.slice(0, 8)}, 'Organização de teste')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${project}, ${org}, 'piloto', 'Piloto')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
            VALUES (${form}, ${org}, ${project}, 'local_consumo', ${sql.json({ pt: 'Local de Consumo' })}, 1)`;
  await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
            VALUES (${version}, ${form}, 1, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:inicial', now())`;
  await sql`INSERT INTO records (id, org_id, project_id, form_id, form_version_id, geom)
            VALUES (${record}, ${org}, ${project}, ${form}, ${version},
                    ST_SetSRID(ST_MakePoint(13.2344, -8.8383), 4326))`;
  await sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
            VALUES (${revision}, ${record}, 1, ${version}, ${sql.json({ f_cod: 'LC000001' })})`;
  await sql`UPDATE records SET current_revision_id = ${revision} WHERE id = ${record}`;
});

afterAll(async () => {
  if (!url) return;
  // A limpeza tem de contornar os próprios triggers que estamos a testar.
  // `session_replication_role` só afecta esta sessão: ao contrário de
  // ALTER TABLE ... DISABLE TRIGGER, não desliga os triggers para o resto do
  // mundo nem pega num lock exclusivo na tabela.
  await sql`SET session_replication_role = replica`;
  await sql`UPDATE records SET current_revision_id = NULL WHERE org_id = ${org}`;
  await sql`DELETE FROM record_revisions WHERE record_id = ${record}`;
  await sql`DELETE FROM records WHERE org_id = ${org}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${form}`;
  await sql`DELETE FROM forms WHERE id = ${form}`;
  await sql`DELETE FROM projects WHERE id = ${project}`;
  await sql`DELETE FROM organizations WHERE id = ${org}`;
  await sql`SET session_replication_role = origin`;
  await sql.end();
});

suite('restrição 4 — nunca apagar nem sobrescrever uma revisão', () => {
  it('recusa UPDATE numa revisão', async () => {
    await expect(
      sql`UPDATE record_revisions SET data = ${sql.json({ f_cod: 'ADULTERADO' })} WHERE id = ${revision}`,
    ).rejects.toThrow(/append-only/i);
  });

  it('recusa DELETE numa revisão', async () => {
    await expect(sql`DELETE FROM record_revisions WHERE id = ${revision}`).rejects.toThrow(
      /append-only/i,
    );
  });

  it('deixa acrescentar uma revisão nova sobre a anterior', async () => {
    const nova = randomUUID();
    await sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data, base_revision_id)
              VALUES (${nova}, ${record}, 2, ${version}, ${sql.json({ f_cod: 'LC000002' })}, ${revision})`;
    const [row] = await sql`SELECT revision_no FROM record_revisions WHERE id = ${nova}`;
    expect(row?.revision_no).toBe(2);
  });

  it('recusa duas revisões com o mesmo número no mesmo registo', async () => {
    await expect(
      sql`INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
          VALUES (${randomUUID()}, ${record}, 2, ${version}, ${sql.json({})})`,
    ).rejects.toThrow();
  });
});

suite('restrição 4 — o registo só sai por soft delete', () => {
  it('recusa DELETE num registo', async () => {
    await expect(sql`DELETE FROM records WHERE id = ${record}`).rejects.toThrow(/não se apaga/i);
  });

  it('aceita o tombstone e mantém as revisões', async () => {
    await sql`UPDATE records SET deleted_at = now() WHERE id = ${record}`;
    const [r] = await sql`SELECT deleted_at FROM records WHERE id = ${record}`;
    expect(r?.deleted_at).not.toBeNull();
    const [contagem] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM record_revisions WHERE record_id = ${record}`;
    expect(contagem?.n).toBeGreaterThanOrEqual(2);
    await sql`UPDATE records SET deleted_at = NULL WHERE id = ${record}`;
  });
});

suite('uma versão publicada é imutável', () => {
  it('recusa alterar a definição de uma versão publicada', async () => {
    await expect(
      sql`UPDATE form_versions SET definition = ${sql.json({ spec_version: 1, fields: [{ id: 'x' }] })} WHERE id = ${version}`,
    ).rejects.toThrow(/imutável/i);
  });

  it('recusa apagar uma versão publicada', async () => {
    await expect(sql`DELETE FROM form_versions WHERE id = ${version}`).rejects.toThrow(
      /append-only/i,
    );
  });

  it('deixa alterar um rascunho por publicar', async () => {
    const rascunho = randomUUID();
    await sql`INSERT INTO form_versions (id, form_id, version, definition, hash)
              VALUES (${rascunho}, ${form}, 2, ${sql.json({ spec_version: 1, fields: [] })}, 'sha256:rascunho')`;
    await sql`UPDATE form_versions SET definition = ${sql.json({ spec_version: 1, fields: [], nota: 'editado' })} WHERE id = ${rascunho}`;
    const [row] = await sql`SELECT definition FROM form_versions WHERE id = ${rascunho}`;
    expect((row?.definition as Record<string, unknown>).nota).toBe('editado');
    await sql`DELETE FROM form_versions WHERE id = ${rascunho}`;
  });
});

suite('restrição 8 — todo o ponto leva precisão, tipo e origem', () => {
  it('recusa um fixo sem precisão', async () => {
    await expect(
      sql`INSERT INTO gps_fixes (id, record_id, field_id, lat, lon, fix_type, source)
          VALUES (${randomUUID()}, ${record}, 'f_geo', -8.8, 13.2, 'single', 'internal')`,
    ).rejects.toThrow();
  });

  it('recusa um fixo sem tipo nem origem', async () => {
    await expect(
      sql`INSERT INTO gps_fixes (id, record_id, field_id, lat, lon, accuracy_m)
          VALUES (${randomUUID()}, ${record}, 'f_geo', -8.8, 13.2, 1.5)`,
    ).rejects.toThrow();
  });

  it('recusa coordenadas impossíveis', async () => {
    await expect(
      sql`INSERT INTO gps_fixes (id, record_id, field_id, lat, lon, accuracy_m, fix_type, source)
          VALUES (${randomUUID()}, ${record}, 'f_geo', 999, 13.2, 1.5, 'single', 'internal')`,
    ).rejects.toThrow();
  });

  it('aceita um fixo completo, incluindo os metadados do receptor externo', async () => {
    const id = randomUUID();
    await sql`INSERT INTO gps_fixes (id, record_id, field_id, lat, lon, alt, accuracy_m, fix_type,
                                     source, satellites, pdop, hdop, receiver_model, corrections_age_s)
              VALUES (${id}, ${record}, 'f_geo', -8.8383, 13.2344, 68.4, 0.018, 'fixed',
                      'external_tcp', 24, 1.1, 0.7, 'Emlid Reach RS2', 1.2)`;
    const [row] = await sql`SELECT fix_type, source, accuracy_m FROM gps_fixes WHERE id = ${id}`;
    expect(row?.fix_type).toBe('fixed');
    expect(row?.source).toBe('external_tcp');
    await sql`DELETE FROM gps_fixes WHERE id = ${id}`;
  });
});

suite('a geometria é PostGIS a sério, não texto', () => {
  it('grava geometry(Point,4326) consultável por ST_', async () => {
    const [row] = await sql`
      SELECT ST_SRID(geom) AS srid,
             GeometryType(geom) AS tipo,
             round(ST_X(geom)::numeric, 4) AS lon,
             round(ST_Y(geom)::numeric, 4) AS lat
      FROM records WHERE id = ${record}`;
    expect(row?.srid).toBe(4326);
    expect(row?.tipo).toBe('POINT');
    expect(Number(row?.lon)).toBeCloseTo(13.2344, 4);
    expect(Number(row?.lat)).toBeCloseTo(-8.8383, 4);
  });

  it('responde a uma consulta por bbox, como o QGIS faz', async () => {
    const [row] = await sql`
      SELECT count(*)::int AS n FROM records
      WHERE geom && ST_MakeEnvelope(13.0, -9.0, 13.5, -8.5, 4326) AND id = ${record}`;
    expect(row?.n).toBe(1);
  });
});

suite('o esquema não muda por formulário publicado', () => {
  it('não existe nenhuma tabela cujo nome derive de um formulário', async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    const suspeitas = rows
      .map((r) => r.table_name)
      .filter((n) => /^(form_|record_)?(v\d+_|.*_v\d+$)/.test(n));
    expect(suspeitas).toEqual([]);
  });

  it('as vistas geradas vivem no seu próprio esquema, fora do public', async () => {
    const [row] =
      await sql`SELECT count(*)::int AS n FROM pg_namespace WHERE nspname = 'cvf_views'`;
    expect(row?.n).toBe(1);
  });
});
