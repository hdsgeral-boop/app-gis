/**
 * F10.1, F10.2 e F10.5 — exportações e relatório de qualidade.
 *
 * Contra PostGIS a sério, porque é aí que se vê o que interessa: que a
 * geometria sai como geometria, que as datas saem como datas, e que os
 * cabeçalhos são os rótulos que o técnico lê e não os `id` internos.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7, type Field, type FormDefinition } from '@cvforms/form-core';

import {
  lerParaExportacao,
  paraCsv,
  paraGeoJson,
  relatorioDeQualidade,
} from '../src/exports/index.js';
import { publishVersion } from '../src/views/index.js';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const org = randomUUID();
const projeto = randomUUID();
const form = randomUUID();
const projectKey = `p${projeto.slice(0, 6)}`;
const formKey = `f${form.slice(0, 6)}`;
let versaoId = '';

const CAMPOS: Field[] = [
  {
    id: 'f_cod',
    name: 'codigo',
    type: 'text',
    label: { pt: 'Código do local' },
    searchable: true,
  } as Field,
  { id: 'f_pot', name: 'potencia', type: 'decimal', label: { pt: 'Potência (kVA)' } } as Field,
  { id: 'f_data', name: 'data_visita', type: 'date', label: { pt: 'Data da visita' } } as Field,
  {
    id: 'f_serv',
    name: 'servicos',
    type: 'select_multiple',
    choices_ref: 'l_serv',
    label: { pt: 'Serviços' },
  } as Field,
  { id: 'f_geo', name: 'localizacao', type: 'geopoint', label: { pt: 'Localização' } } as Field,
];

const DEFINICAO: FormDefinition = {
  spec_version: 1,
  form_id: form,
  version: 1,
  title: { pt: 'Local de Consumo' },
  settings: { geometry_field: 'f_geo', max_accuracy_m: 2 },
  fields: CAMPOS,
  choice_lists: {
    l_serv: [
      { value: 'agua', label: { pt: 'Água' } },
      { value: 'luz', label: { pt: 'Electricidade' } },
    ],
  },
} as FormDefinition;

async function criarRegisto(
  dados: Record<string, unknown>,
  ponto: { lat: number; lon: number; accuracy_m: number } | null,
  justificacao: string | null = null,
): Promise<string> {
  const record = uuidv7();
  const revision = uuidv7();
  await sql`
    INSERT INTO records (id, org_id, project_id, form_id, form_version_id, geom)
    VALUES (${record}, ${org}, ${projeto}, ${form}, ${versaoId},
            ${ponto ? sql`ST_SetSRID(ST_MakePoint(${ponto.lon}, ${ponto.lat}), 4326)` : null})
  `;
  await sql`
    INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data, accuracy_override_reason)
    VALUES (${revision}, ${record}, 1, ${versaoId}, ${JSON.stringify(dados)}::text::jsonb, ${justificacao})
  `;
  await sql`UPDATE records SET current_revision_id = ${revision} WHERE id = ${record}`;
  if (ponto) {
    await sql`
      INSERT INTO gps_fixes (id, record_id, revision_id, field_id, lat, lon, accuracy_m, fix_type, source)
      VALUES (${uuidv7()}, ${record}, ${revision}, 'f_geo', ${ponto.lat}, ${ponto.lon},
              ${ponto.accuracy_m}, 'fixed', 'external_tcp')
    `;
  }
  return record;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });

  await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'o' + org.slice(0, 8)}, 'Org das exportações')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projeto}, ${org}, ${projectKey}, 'Piloto')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title)
            VALUES (${form}, ${org}, ${projeto}, ${formKey}, ${sql.json({ pt: 'Local de Consumo' })})`;

  const publicado = await publishVersion(sql, {
    definition: DEFINICAO,
    formId: form,
    projectKey,
    formKey,
  });
  if (!publicado.ok) throw new Error(JSON.stringify(publicado.issues));
  versaoId = publicado.formVersionId!;

  await criarRegisto(
    {
      f_cod: 'LC000123',
      f_pot: 250.5,
      f_data: '2026-09-05',
      f_serv: ['agua', 'luz'],
      f_geo: {
        lat: -8.8383,
        lon: 13.2344,
        accuracy_m: 0.02,
        fix_type: 'fixed',
        source: 'external_tcp',
      },
    },
    { lat: -8.8383, lon: 13.2344, accuracy_m: 0.02 },
  );

  // Um ponto recolhido acima do limiar, com justificação escrita.
  await criarRegisto(
    {
      f_cod: 'LC000200',
      f_pot: 10,
      f_data: '2026-09-06',
      f_serv: ['agua'],
      f_geo: { lat: -8.9, lon: 13.3, accuracy_m: 12.5, fix_type: 'single', source: 'internal' },
    },
    { lat: -8.9, lon: 13.3, accuracy_m: 12.5 },
    'Sem céu aberto: recolhido junto ao muro do PT.',
  );

  // E outro acima do limiar sem justificação nenhuma.
  await criarRegisto(
    {
      f_cod: 'LC000300',
      f_geo: { lat: -8.95, lon: 13.35, accuracy_m: 30, fix_type: 'single', source: 'internal' },
    },
    { lat: -8.95, lon: 13.35, accuracy_m: 30 },
  );
}, 180_000);

afterAll(async () => {
  if (!url) return;
  const vistas = await sql<Array<{ schema_name: string; view_name: string }>>`
    SELECT schema_name, view_name FROM generated_views WHERE form_id = ${form}
  `;
  for (const v of vistas) {
    await sql.unsafe(`DROP VIEW IF EXISTS "${v.schema_name}"."${v.view_name}"`);
  }
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM gps_fixes WHERE record_id IN (SELECT id FROM records WHERE form_id = ${form})`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${form})`;
  await sql`DELETE FROM records WHERE form_id = ${form}`;
  await sql`DELETE FROM generated_views WHERE form_id = ${form}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
  await sql`DELETE FROM form_access WHERE org_id = ${org}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${form}`;
  await sql`DELETE FROM forms WHERE id = ${form}`;
  await sql`DELETE FROM projects WHERE org_id = ${org}`;
  await sql`DELETE FROM organizations WHERE id = ${org}`;
  await sql?.end();
}, 180_000);

suite('F10.1 — exportação tabular', () => {
  it('os cabeçalhos são os rótulos, não os identificadores', async () => {
    const tabela = await lerParaExportacao({
      sql,
      definition: DEFINICAO,
      projectKey,
      formKey,
    });

    // O critério da F10.1: quem abre isto no Excel tem de perceber as colunas.
    expect(tabela.cabecalhos).toContain('Código do local');
    expect(tabela.cabecalhos).toContain('Potência (kVA)');
    expect(tabela.cabecalhos).toContain('Localização — precisão (m)');
    expect(tabela.cabecalhos).not.toContain('f_cod');

    // Os nomes técnicos ficam disponíveis para quem os quiser cruzar.
    expect(tabela.colunas).toContain('codigo');
  });

  it('devolve os valores já tipados pela vista', async () => {
    const tabela = await lerParaExportacao({ sql, definition: DEFINICAO, projectKey, formKey });
    const codigo = tabela.colunas.indexOf('codigo');
    const potencia = tabela.colunas.indexOf('potencia');
    const data = tabela.colunas.indexOf('data_visita');
    const servicos = tabela.colunas.indexOf('servicos');

    const linha = tabela.linhas.find((l) => l[codigo] === 'LC000123')!;
    expect(Number(linha[potencia])).toBe(250.5);
    expect(linha[data]).toBeInstanceOf(Date);
    expect(linha[servicos]).toEqual(['agua', 'luz']);
  });

  it('o CSV é legível pelo Excel português: BOM, ponto e vírgula, CRLF', async () => {
    const tabela = await lerParaExportacao({ sql, definition: DEFINICAO, projectKey, formKey });
    const csv = paraCsv(tabela);

    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('\r\n');
    expect(csv.split('\r\n')[0]).toContain('Código do local;');
  });

  it('um valor com o separador dentro vai entre aspas', () => {
    const csv = paraCsv({
      cabecalhos: ['Observações'],
      colunas: ['obs'],
      linhas: [['avaria; sem tensão'], ['disse "está mau"']],
    });
    expect(csv).toContain('"avaria; sem tensão"');
    expect(csv).toContain('"disse ""está mau"""');
  });

  it('filtra por bbox', async () => {
    const dentro = await lerParaExportacao({
      sql,
      definition: DEFINICAO,
      projectKey,
      formKey,
      bbox: [13.2, -8.9, 13.3, -8.8],
    });
    const codigo = dentro.colunas.indexOf('codigo');
    const codigos = dentro.linhas.map((l) => l[codigo]);
    expect(codigos).toContain('LC000123');
    expect(codigos).not.toContain('LC000300');
  });
});

suite('F10.2 — GeoJSON pronto para o QGIS', () => {
  it('é uma FeatureCollection com geometria a sério', async () => {
    const geojson = await paraGeoJson({ sql, definition: DEFINICAO, projectKey, formKey });

    expect(geojson.type).toBe('FeatureCollection');
    expect(geojson.features.length).toBeGreaterThanOrEqual(3);

    const feature = geojson.features.find((f) => f.properties['Código do local'] === 'LC000123')!;
    expect(feature.geometry).toMatchObject({ type: 'Point' });
    const coordenadas = (feature.geometry as { coordinates: [number, number] }).coordinates;
    // GeoJSON é sempre [longitude, latitude], nesta ordem. Trocá-las põe
    // Angola no meio do oceano Índico, e é o erro mais comum do formato.
    expect(coordenadas[0]).toBeCloseTo(13.2344, 4);
    expect(coordenadas[1]).toBeCloseTo(-8.8383, 4);
  });

  it('as propriedades usam os rótulos e não repetem a geometria', async () => {
    const geojson = await paraGeoJson({ sql, definition: DEFINICAO, projectKey, formKey });
    const feature = geojson.features[0]!;
    expect(Object.keys(feature.properties)).not.toContain('geom');
    expect(Object.keys(feature.properties)).toContain('Estado');
    expect(feature.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('um registo sem geometria sai com geometry a null, e não desaparece', async () => {
    // Um registo sem ponto continua a ser um registo. Omiti-lo faria o
    // ficheiro exportado ter menos linhas do que a base, sem explicação.
    const semPonto = await criarRegisto({ f_cod: 'LC000400' }, null);
    const geojson = await paraGeoJson({ sql, definition: DEFINICAO, projectKey, formKey });
    const feature = geojson.features.find((f) => f.id === semPonto);
    expect(feature).toBeDefined();
    expect(feature!.geometry).toBeNull();
  });
});

suite('F10.5 — relatório de qualidade', () => {
  it('lista os pontos acima do limiar, com a justificação escrita', async () => {
    const linhas = await relatorioDeQualidade(sql, form, DEFINICAO);

    // O limiar do formulário são 2 m: o ponto de 0,02 m não entra.
    expect(linhas.map((l) => l.accuracy_m).sort((a, b) => a - b)).toEqual([12.5, 30]);

    const justificado = linhas.find((l) => l.accuracy_m === 12.5)!;
    expect(justificado.justificacao).toContain('muro do PT');
    expect(justificado.limiar_m).toBe(2);

    const semJustificacao = linhas.find((l) => l.accuracy_m === 30)!;
    expect(semJustificacao.justificacao).toBeNull();
  });

  it('sem limiar definido, não há nada a reportar', async () => {
    const semLimiar = { ...DEFINICAO, settings: { geometry_field: 'f_geo' } } as FormDefinition;
    expect(await relatorioDeQualidade(sql, form, semLimiar)).toEqual([]);
  });

  it('um limiar próprio do campo sobrepõe-se ao do formulário', async () => {
    const comLimiarProprio = {
      ...DEFINICAO,
      fields: DEFINICAO.fields.map((f) =>
        f.id === 'f_geo' ? ({ ...f, max_accuracy_m: 20 } as Field) : f,
      ),
    } as FormDefinition;
    const linhas = await relatorioDeQualidade(sql, form, comLimiarProprio);
    expect(linhas.map((l) => l.accuracy_m)).toEqual([30]);
  });
});
