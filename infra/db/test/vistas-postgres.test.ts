/**
 * Prova, contra um Postgres com PostGIS a sério, que as vistas geradas CORREM:
 * que as colunas têm os tipos declarados, que a geometria responde a consultas
 * espaciais, que a vista-filha se liga à mãe, e que publicar uma versão nova
 * não parte a anterior.
 *
 * Sem DATABASE_URL definida, é saltado em vez de falhar — a mesma regra do
 * `invariantes.test.ts`: quem só mexe no form-core não precisa de docker.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import type { Field, FormDefinition } from '@cvforms/form-core';

import { archiveForm, publishVersion, VIEWS_SCHEMA } from '../src/views/index.js';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const project = randomUUID();
const form = randomUUID();
const projectKey = `p${org.slice(0, 6)}`;
const formKey = `f${form.slice(0, 6)}`;

const PONTO_LUANDA = {
  lat: -8.8383,
  lon: 13.2344,
  accuracy_m: 0.018,
  fix_type: 'fixed',
  source: 'external_tcp',
};

function definicao(
  version: number,
  fields: Field[],
  extra: Partial<FormDefinition> = {},
): FormDefinition {
  return {
    spec_version: 1,
    form_id: form,
    version,
    title: { pt: 'Local de Consumo' },
    fields,
    ...extra,
  } as FormDefinition;
}

const CAMPOS_V1: Field[] = [
  { id: 'f_cod', name: 'codigo', type: 'text', searchable: true } as Field,
  { id: 'f_n', name: 'numero_postes', type: 'integer' } as Field,
  { id: 'f_pot', name: 'potencia', type: 'decimal' } as Field,
  { id: 'f_lig', name: 'ligado', type: 'boolean' } as Field,
  { id: 'f_data', name: 'data_visita', type: 'date' } as Field,
  { id: 'f_geo', name: 'localizacao', type: 'geopoint' } as Field,
  { id: 'f_serv', name: 'servicos', type: 'select_multiple', choices_ref: 'l_serv' } as Field,
  {
    id: 'g_cont',
    name: 'contadores',
    type: 'repeat',
    fields: [
      { id: 'f_ns', name: 'numero_serie', type: 'text' } as Field,
      {
        id: 'g_leit',
        name: 'leituras',
        type: 'repeat',
        fields: [{ id: 'f_valor', name: 'valor', type: 'decimal' } as Field],
      } as Field,
    ],
  } as Field,
  {
    id: 'f_total',
    name: 'total_contadores',
    type: 'calculate',
    calculation: { op: 'count', args: ['$g_cont'] },
  } as Field,
];

const LISTAS = {
  l_serv: [
    { value: 'agua', label: { pt: 'Água' } },
    { value: 'luz', label: { pt: 'Electricidade' } },
  ],
};

let versaoV1 = '';
let registoV1 = '';

async function criarRegisto(formVersionId: string, data: unknown, geom = true): Promise<string> {
  const record = randomUUID();
  const revision = randomUUID();
  await sql`
    INSERT INTO records (id, org_id, project_id, form_id, form_version_id, geom)
    VALUES (${record}, ${org}, ${project}, ${form}, ${formVersionId},
            ${geom ? sql`ST_SetSRID(ST_MakePoint(13.2344, -8.8383), 4326)` : null})
  `;
  await sql`
    INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data)
    VALUES (${revision}, ${record}, 1, ${formVersionId}, ${sql.json(data as never)})
  `;
  await sql`UPDATE records SET current_revision_id = ${revision} WHERE id = ${record}`;
  return record;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 1, onnotice: () => {} });

  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'org_' + org.slice(0, 8)}, 'Org de teste das vistas')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${project}, ${org}, ${projectKey}, 'Piloto')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title)
            VALUES (${form}, ${org}, ${project}, ${formKey}, ${sql.json({ pt: 'Local de Consumo' })})`;

  const publicado = await publishVersion(sql, {
    definition: definicao(1, CAMPOS_V1, { choice_lists: LISTAS }),
    formId: form,
    projectKey,
    formKey,
  });
  if (!publicado.ok) throw new Error(`publicação falhou: ${JSON.stringify(publicado.issues)}`);
  versaoV1 = publicado.formVersionId!;

  registoV1 = await criarRegisto(versaoV1, {
    f_cod: 'LC000123',
    f_n: 12,
    f_pot: 250.75,
    f_lig: true,
    f_data: '2026-09-05',
    f_geo: PONTO_LUANDA,
    f_serv: ['agua', 'luz'],
    f_total: 2,
    g_cont: [
      { f_ns: 'A-1', g_leit: [{ f_valor: 10.5 }, { f_valor: 20.25 }] },
      { f_ns: 'A-2', g_leit: [{ f_valor: 7 }] },
    ],
  });

  // Um registo com lixo no sítio de um número e no sítio de um repetível: a
  // vista tem de continuar a responder para todos os outros.
  await criarRegisto(versaoV1, {
    f_cod: 'LC000999',
    f_n: 'isto não é um número',
    f_geo: { lat: 'nada', lon: null },
    g_cont: 'nem isto é uma lista',
  });
}, 120_000);

afterAll(async () => {
  if (!url) return;
  await sql?.end();
});

const nomeVista = (sufixo: string) => `v_${projectKey}_${formKey}_${sufixo}`.toLowerCase();

suite('F2.3 a F2.5 — a vista raiz devolve colunas tipadas', () => {
  it('os tipos declarados no catálogo são os que o gerador prometeu', async () => {
    const colunas = await sql<Array<{ column_name: string; data_type: string; udt_name: string }>>`
      SELECT column_name, data_type, udt_name
      FROM information_schema.columns
      WHERE table_schema = ${VIEWS_SCHEMA} AND table_name = ${nomeVista('v1')}
    `;
    const tipos = Object.fromEntries(colunas.map((c) => [c.column_name, c.udt_name]));
    expect(tipos['codigo']).toBe('text');
    expect(tipos['numero_postes']).toBe('int4');
    expect(tipos['potencia']).toBe('numeric');
    expect(tipos['ligado']).toBe('bool');
    expect(tipos['data_visita']).toBe('date');
    expect(tipos['localizacao']).toBe('geometry');
    expect(tipos['servicos']).toBe('_text');
    expect(tipos['servicos_txt']).toBe('text');
    expect(tipos['total_contadores']).toBe('int4');
  });

  it('devolve os valores certos', async () => {
    const [linha] = await sql.unsafe(
      `SELECT * FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}" WHERE record_id = '${registoV1}'`,
    );
    expect(linha!['codigo']).toBe('LC000123');
    expect(linha!['numero_postes']).toBe(12);
    expect(Number(linha!['potencia'])).toBe(250.75);
    expect(linha!['ligado']).toBe(true);
    expect(linha!['servicos']).toEqual(['agua', 'luz']);
    expect(linha!['servicos_txt']).toBe('agua luz');
  });

  it('um valor com lixo dá NULL nessa coluna e não parte a vista inteira', async () => {
    const linhas = await sql.unsafe(`SELECT * FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}"`);
    expect(linhas).toHaveLength(2);
    const mau = linhas.find((l) => l['codigo'] === 'LC000999');
    expect(mau!['numero_postes']).toBeNull();
    expect(mau!['localizacao']).toBeNull();
  });

  it('o id do campo ficou no comentário da coluna', async () => {
    const [comentario] = await sql<Array<{ descricao: string | null }>>`
      SELECT col_description(
        (${`${VIEWS_SCHEMA}.${nomeVista('v1')}`})::regclass,
        (SELECT ordinal_position FROM information_schema.columns
         WHERE table_schema = ${VIEWS_SCHEMA} AND table_name = ${nomeVista('v1')}
           AND column_name = 'codigo')::int
      ) AS descricao
    `;
    expect(comentario?.descricao).toContain('f_cod');
  });
});

suite('F2.4 — geometria a sério', () => {
  it('ST_X e ST_Y devolvem a coordenada recolhida', async () => {
    const [linha] = await sql.unsafe(
      `SELECT ST_X(localizacao) AS lon, ST_Y(localizacao) AS lat, ST_SRID(localizacao) AS srid,
              localizacao_accuracy_m, localizacao_fix_type, localizacao_source
       FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}" WHERE record_id = '${registoV1}'`,
    );
    expect(Number(linha!['lon'])).toBeCloseTo(13.2344, 6);
    expect(Number(linha!['lat'])).toBeCloseTo(-8.8383, 6);
    expect(linha!['srid']).toBe(4326);
    expect(Number(linha!['localizacao_accuracy_m'])).toBeCloseTo(0.018, 6);
    expect(linha!['localizacao_fix_type']).toBe('fixed');
    expect(linha!['localizacao_source']).toBe('external_tcp');
  });

  it('responde a uma consulta por bbox, que é o que o QGIS faz ao arrastar o mapa', async () => {
    const dentro = await sql.unsafe(
      `SELECT record_id FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}"
       WHERE localizacao && ST_MakeEnvelope(13.0, -9.0, 13.5, -8.5, 4326)`,
    );
    expect(dentro.map((l) => l['record_id'])).toContain(registoV1);

    const fora = await sql.unsafe(
      `SELECT record_id FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}"
       WHERE localizacao && ST_MakeEnvelope(30.0, 30.0, 31.0, 31.0, 4326)`,
    );
    expect(fora).toHaveLength(0);
  });
});

suite('F2.6 e F2.7 — vistas-filhas', () => {
  it('o JOIN entre mãe e filha devolve as instâncias', async () => {
    const linhas = await sql.unsafe(
      `SELECT m.codigo, f.idx, f.numero_serie
       FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}" m
       JOIN ${VIEWS_SCHEMA}."${nomeVista('contadores_v1')}" f ON f.record_id = m.record_id
       WHERE m.record_id = '${registoV1}'
       ORDER BY f.idx`,
    );
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatchObject({ codigo: 'LC000123', idx: 0, numero_serie: 'A-1' });
    expect(linhas[1]).toMatchObject({ idx: 1, numero_serie: 'A-2' });
  });

  it('o repetível aninhado encadeia duas vistas-filhas', async () => {
    const linhas = await sql.unsafe(
      `SELECT c.numero_serie, l.contadores_idx, l.idx, l.valor
       FROM ${VIEWS_SCHEMA}."${nomeVista('contadores_v1')}" c
       JOIN ${VIEWS_SCHEMA}."${nomeVista('contadores_leituras_v1')}" l
         ON l.record_id = c.record_id AND l.contadores_idx = c.idx
       WHERE c.record_id = '${registoV1}'
       ORDER BY l.contadores_idx, l.idx`,
    );
    expect(linhas).toHaveLength(3);
    expect(linhas.map((l) => Number(l['valor']))).toEqual([10.5, 20.25, 7]);
    expect(linhas[2]).toMatchObject({ numero_serie: 'A-2', contadores_idx: 1, idx: 0 });
  });

  it('um registo com lixo no lugar do repetível não aparece, e não rebenta', async () => {
    const todas = await sql.unsafe(
      `SELECT record_id FROM ${VIEWS_SCHEMA}."${nomeVista('contadores_v1')}"`,
    );
    expect(todas).toHaveLength(2); // só as do registo bom
  });
});

suite('F2.8 e F2.9 — versões', () => {
  it('publicar a v2 muda a _actual e deixa a v1 intacta', async () => {
    const antesNaV1 = await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}"`,
    );

    const camposV2: Field[] = [
      ...CAMPOS_V1,
      { id: 'f_obs', name: 'observacoes', type: 'text' } as Field,
    ];
    const publicado = await publishVersion(sql, {
      definition: definicao(2, camposV2, { choice_lists: LISTAS }),
      formId: form,
      projectKey,
      formKey,
      previous: definicao(1, CAMPOS_V1, { choice_lists: LISTAS }),
    });
    expect(publicado.ok).toBe(true);
    expect(publicado.diff?.compatible).toBe(true);

    // A vista da v1 continua a existir e a devolver o mesmo.
    const depoisNaV1 = await sql.unsafe(
      `SELECT count(*)::int AS n FROM ${VIEWS_SCHEMA}."${nomeVista('v1')}"`,
    );
    expect(depoisNaV1[0]!['n']).toBe(antesNaV1[0]!['n']);

    // A vista da v2 existe e já tem a coluna nova.
    const colunasV2 = await sql<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = ${VIEWS_SCHEMA} AND table_name = ${nomeVista('v2')}
    `;
    expect(colunasV2.map((c) => c.column_name)).toContain('observacoes');

    // A _actual passou a ter a coluna nova, e continua a mostrar os registos
    // recolhidos com a v1 — com observacoes a NULL e form_version = 1.
    const actual = await sql.unsafe(
      `SELECT codigo, observacoes, form_version FROM ${VIEWS_SCHEMA}."${nomeVista('actual')}"
       WHERE record_id = '${registoV1}'`,
    );
    expect(actual[0]).toMatchObject({ codigo: 'LC000123', observacoes: null, form_version: 1 });
  });

  it('uma alteração incompatível sem confirmação recusa a publicação e não deixa rasto', async () => {
    const camposV3 = CAMPOS_V1.filter((f) => f.id !== 'f_pot'); // remover é incompatível
    const resultado = await publishVersion(sql, {
      definition: definicao(3, camposV3, { choice_lists: LISTAS }),
      formId: form,
      projectKey,
      formKey,
      previous: definicao(2, CAMPOS_V1, { choice_lists: LISTAS }),
    });
    expect(resultado.ok).toBe(false);
    expect(resultado.issues.some((i) => i.code === 'campo_removido')).toBe(true);

    const versoes = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM form_versions WHERE form_id = ${form} AND version = 3
    `;
    expect(versoes[0]!.n).toBe(0);
    const vistas = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM generated_views
      WHERE form_id = ${form} AND view_name LIKE ${'%_v3'}
    `;
    expect(vistas[0]!.n).toBe(0);
  });
});

suite('F2.10 — índice dos campos pesquisáveis', () => {
  it('o EXPLAIN mostra o índice a ser usado', async () => {
    // Sem linhas suficientes o planeador prefere sempre a varredura sequencial,
    // e o teste não provaria nada. Forçar é legítimo: o que se quer provar é
    // que o índice EXISTE e SERVE a consulta, não a decisão do planeador.
    await sql.unsafe('ANALYZE record_revisions');
    const plano = await sql.unsafe(
      `SET LOCAL enable_seqscan = off;
       EXPLAIN SELECT 1 FROM record_revisions WHERE data ->> 'f_cod' = 'LC000123'`,
    );
    const texto = JSON.stringify(plano);
    expect(texto).toContain('cvf_busca_f_cod');
  });
});

suite('F2.11 e F2.12 — transacção e arquivo', () => {
  it('arquivar apaga as vistas e não apaga um único registo', async () => {
    const [antes] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions
      WHERE record_id IN (SELECT id FROM records WHERE form_id = ${form})
    `;

    const apagadas = await archiveForm(sql, form);
    expect(apagadas).toBeGreaterThan(0);

    const restantes = await sql<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.views WHERE table_schema = ${VIEWS_SCHEMA}
        AND table_name LIKE ${`v_${projectKey}_%`}
    `;
    expect(restantes).toHaveLength(0);

    const [depois] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions
      WHERE record_id IN (SELECT id FROM records WHERE form_id = ${form})
    `;
    expect(depois!.n).toBe(antes!.n);

    const [registo] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM generated_views WHERE form_id = ${form}
    `;
    expect(registo!.n).toBe(0);
  });
});
