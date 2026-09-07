/**
 * F8 — camadas de mapa.
 *
 * O que se prova aqui é o que a base garante sozinha: que uma camada sem
 * conteúdo não entra, que só há uma por omissão, e que uma organização não vê
 * as camadas da outra. São as três coisas que, se falharem, falham em silêncio
 * — um mapa que nunca carrega, dois mapas de fundo a competir, ou o mapa de um
 * cliente no telefone de outro.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { uuidv7 } from '@cvforms/form-core';

const url = process.env.DATABASE_URL;
const suite = url ? describe : describe.skip;

let sql: postgres.Sql;

const orgA = randomUUID();
const orgB = randomUUID();
const projectoA = randomUUID();

async function criarCamada(
  org: string,
  opcoes: {
    nome?: string;
    tipo?: string;
    chave?: string | null;
    estilo?: string | null;
    omissao?: boolean;
    projecto?: string | null;
    bbox?: [number, number, number, number];
  } = {},
) {
  const id = uuidv7();
  const bbox = opcoes.bbox;
  await sql`
    INSERT INTO map_layers (id, org_id, project_id, kind, name, storage_key, style_url,
                            is_default, bounds)
    VALUES (${id}, ${org}, ${opcoes.projecto ?? null},
            ${opcoes.tipo ?? 'pmtiles'}::map_layer_kind,
            ${opcoes.nome ?? 'Luanda'},
            ${opcoes.chave === undefined ? `${org}/abc.pmtiles` : opcoes.chave},
            ${opcoes.estilo ?? null},
            ${opcoes.omissao ?? false},
            ${
              bbox
                ? `SRID=4326;POLYGON((${bbox[0]} ${bbox[1]},${bbox[2]} ${bbox[1]},${bbox[2]} ${bbox[3]},${bbox[0]} ${bbox[3]},${bbox[0]} ${bbox[1]}))`
                : null
            })
  `;
  return id;
}

async function comoAplicacao<T>(org: string, bloco: (tx: postgres.TransactionSql) => Promise<T>) {
  const { valor } = await sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE cvforms_app`);
    await tx.unsafe(`SET LOCAL cvf.org_id = '${org}'`);
    return { valor: await bloco(tx) };
  });
  return valor as T;
}

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 2, onnotice: () => {} });
  for (const org of [orgA, orgB]) {
    await sql`INSERT INTO organizations (id, key, name) VALUES (${org}, ${'m' + org.slice(0, 8)}, 'Org')`;
  }
  await sql`INSERT INTO projects (id, org_id, key, name)
            VALUES (${projectoA}, ${orgA}, ${'p' + projectoA.slice(0, 6)}, 'Bengo')`;
}, 120_000);

afterAll(async () => {
  if (!url) return;
  for (const org of [orgA, orgB]) {
    await sql`DELETE FROM map_layers WHERE org_id = ${org}`;
    await sql`DELETE FROM projects WHERE org_id = ${org}`;
    await sql`DELETE FROM organizations WHERE id = ${org}`;
  }
  await sql?.end();
}, 120_000);

suite('F8 — uma camada tem de ter mapa', () => {
  it('um pmtiles sem ficheiro é recusado', async () => {
    // Uma linha destas prometeria um mapa e não o teria: a app mostrava a
    // camada na lista e ela nunca carregava.
    await expect(criarCamada(orgA, { chave: null })).rejects.toThrow(/map_layers_conteudo_ck/);
  });

  it('um estilo online sem URL é recusado', async () => {
    await expect(
      criarCamada(orgA, { tipo: 'estilo_online', chave: null, estilo: null }),
    ).rejects.toThrow(/map_layers_conteudo_ck/);
  });

  it('um estilo online com URL entra', async () => {
    const id = await criarCamada(orgA, {
      tipo: 'estilo_online',
      chave: null,
      estilo: 'https://exemplo/estilo.json',
      nome: 'Ruas (online)',
    });
    const [linha] = await sql`SELECT kind FROM map_layers WHERE id = ${id}`;
    expect(linha!.kind).toBe('estilo_online');
  });

  it('um zoom mínimo maior do que o máximo é recusado', async () => {
    const id = uuidv7();
    await expect(
      sql`INSERT INTO map_layers (id, org_id, kind, name, storage_key, min_zoom, max_zoom)
          VALUES (${id}, ${orgA}, 'pmtiles', 'x', 'k', 14, 8)`,
    ).rejects.toThrow(/map_layers_zoom_ck/);
  });
});

suite('F8 — só uma camada por omissão', () => {
  it('duas por omissão na mesma organização é recusado', async () => {
    // Dois mapas de fundo a competir dá um ecrã que muda conforme a ordem em
    // que as linhas voltarem da base — um defeito que só aparece às vezes.
    await criarCamada(orgA, { nome: 'Base 1', omissao: true });
    await expect(criarCamada(orgA, { nome: 'Base 2', omissao: true })).rejects.toThrow(
      /map_layers_uma_por_omissao/,
    );
  });

  it('cada organização tem a sua', async () => {
    const id = await criarCamada(orgB, { nome: 'Base do B', omissao: true });
    expect(id).toBeTruthy();
  });

  it('arquivar liberta o lugar da que está por omissão', async () => {
    await sql`UPDATE map_layers SET archived_at = now(), is_default = false
              WHERE org_id = ${orgA} AND name = 'Base 1'`;
    const nova = await criarCamada(orgA, { nome: 'Base 3', omissao: true });
    expect(nova).toBeTruthy();
  });
});

suite('F8 — isolamento entre organizações', () => {
  it('uma organização não vê as camadas da outra', async () => {
    // Um mapa é um ficheiro de centenas de MB que às vezes tem informação
    // sensível — uma ortofoto de uma instalação, por exemplo.
    const visiveis = await comoAplicacao(
      orgB,
      (tx) => tx<Array<{ name: string }>>`SELECT name FROM map_layers`,
    );
    expect(visiveis.every((v) => v.name === 'Base do B')).toBe(true);
  });

  it('a camada de um projecto guarda os limites como geometria', async () => {
    // Os limites servem para a app dizer «este mapa não cobre onde estás» em
    // vez de mostrar um quadrado cinzento.
    const id = await criarCamada(orgA, {
      nome: 'Bengo',
      projecto: projectoA,
      bbox: [13.0, -9.2, 13.6, -8.6],
    });
    const [linha] = await sql<Array<{ dentro: boolean }>>`
      SELECT ST_Contains(bounds, ST_SetSRID(ST_MakePoint(13.2, -8.8), 4326)) AS dentro
      FROM map_layers WHERE id = ${id}
    `;
    expect(linha!.dentro).toBe(true);
  });

  it('apagar o projecto leva a camada com ele', async () => {
    // Uma camada de um projecto que já não existe é um ficheiro grande que
    // ninguém volta a pedir e ninguém se lembra de apagar.
    const projecto = randomUUID();
    await sql`INSERT INTO projects (id, org_id, key, name)
              VALUES (${projecto}, ${orgA}, ${'z' + projecto.slice(0, 6)}, 'Temporário')`;
    const id = await criarCamada(orgA, { nome: 'Temporária', projecto });
    await sql`DELETE FROM projects WHERE id = ${projecto}`;
    const restantes = await sql`SELECT id FROM map_layers WHERE id = ${id}`;
    expect(restantes).toHaveLength(0);
  });
});
