/**
 * F2.14 — os endpoints de formulários, ponta a ponta.
 *
 * O que se prova aqui é o circuito completo que a F3 precisa: um administrador
 * desenha, publica, atribui; um técnico vê a definição e mais nada. E a
 * publicação corre o pipeline inteiro da §5 da especificação, contra um
 * Postgres com PostGIS a sério — as vistas que aparecem no fim são as que o
 * QGIS vai consumir.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from 'jose';
import postgres from 'postgres';

import { AppModule } from '../src/app.module.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

let app: NestFastifyApplication;
let jwks: Server;
let issuer: string;
let chave: CryptoKey;
let sql: postgres.Sql;

const orgId = randomUUID();
const projectId = randomUUID();
const projectKey = `p${projectId.slice(0, 6)}`;
const subjectAdmin = randomUUID();
const subjectTecnico = randomUUID();
const KID = 'chave-de-teste';

/** `id` do formulário criado pelo teste, preenchido no primeiro caso. */
let formId = '';

const DEFINICAO_V1 = {
  title: { pt: 'Local de Consumo' },
  settings: { geometry_field: 'f_geo', max_accuracy_m: 2 },
  fields: [
    {
      id: 'f_cod',
      name: 'codigo',
      type: 'text',
      label: { pt: 'Código do local' },
      required: true,
      searchable: true,
      constraint: { op: 'matches', args: ['$self', '^LC[0-9]{6}$'] },
      constraint_message: { pt: 'Formato esperado: LC000000' },
    },
    {
      id: 'f_tipo',
      name: 'tipo',
      type: 'select_one',
      label: { pt: 'Tipo' },
      choices_ref: 'lista_tipos',
    },
    { id: 'f_geo', name: 'localizacao', type: 'geopoint', label: { pt: 'Localização' } },
    {
      id: 'g_cont',
      name: 'contadores',
      type: 'repeat',
      label: { pt: 'Contadores' },
      fields: [{ id: 'f_ns', name: 'numero_serie', type: 'text', label: { pt: 'Nº de série' } }],
    },
  ],
  choice_lists: {
    lista_tipos: [
      { value: 'domestico', label: { pt: 'Doméstico' } },
      { value: 'industrial', label: { pt: 'Industrial' } },
    ],
  },
};

async function token(papeis: string[], subject: string): Promise<string> {
  return new SignJWT({
    preferred_username: papeis.includes('admin') ? 'admin.demo' : 'tecnico.demo',
    org_id: orgId,
    realm_access: { roles: papeis },
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience('cvforms-admin')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(chave);
}

async function pedir(
  metodo: 'GET' | 'POST' | 'DELETE',
  url: string,
  papeis: string[],
  corpo?: unknown,
  subject = papeis.includes('admin') ? subjectAdmin : subjectTecnico,
) {
  return app.inject({
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(papeis, subject)}` },
    ...(corpo === undefined ? {} : { payload: corpo as object }),
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const par = await generateKeyPair('RS256', { extractable: true });
  chave = par.privateKey;
  const jwk: JWK = { ...(await exportJWK(par.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };

  jwks = createServer((req, res) => {
    if (req.url?.endsWith('/protocol/openid-connect/certs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ keys: [jwk] }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => jwks.listen(0, '127.0.0.1', resolve));
  issuer = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/realms/cvforms`;

  process.env.KEYCLOAK_ISSUER = issuer;
  process.env.KEYCLOAK_AUDIENCE = 'cvforms-admin';
  // Silencioso por omissão, para a saída dos testes ser legível — mas
  // sobreponível: um 500 inesperado sem stack custa meia hora a diagnosticar.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';

  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await sql`INSERT INTO organizations (id, key, name) VALUES (${orgId}, ${'org' + orgId.slice(0, 8)}, 'Org do teste de formulários')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projectId}, ${orgId}, ${projectKey}, 'Piloto')`;

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  if (formId) {
    // Apagar as vistas primeiro: são o único artefacto fora das tabelas.
    const vistas = await sql<Array<{ schema_name: string; view_name: string }>>`
      SELECT schema_name, view_name FROM generated_views WHERE form_id = ${formId}
    `;
    for (const v of vistas) {
      await sql.unsafe(`DROP VIEW IF EXISTS "${v.schema_name}"."${v.view_name}"`);
    }
  }
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM team_members WHERE team_id IN (SELECT id FROM teams WHERE org_id = ${orgId})`;
  await sql`DELETE FROM user_roles WHERE role_id IN (SELECT id FROM roles WHERE org_id = ${orgId})`;
  await sql`DELETE FROM teams WHERE org_id = ${orgId}`;
  await sql`DELETE FROM roles WHERE org_id = ${orgId}`;
  await sql`DELETE FROM form_access_scopes WHERE org_id = ${orgId}`;
  await sql`DELETE FROM form_access WHERE org_id = ${orgId}`;
  await sql`DELETE FROM generated_views WHERE form_id IN (SELECT id FROM forms WHERE org_id = ${orgId})`;
  await sql`DELETE FROM form_assignments WHERE form_id IN (SELECT id FROM forms WHERE org_id = ${orgId})`;
  await sql`DELETE FROM form_versions WHERE form_id IN (SELECT id FROM forms WHERE org_id = ${orgId})`;
  await sql`DELETE FROM forms WHERE org_id = ${orgId}`;
  await sql`DELETE FROM users WHERE org_id = ${orgId}`;
  await sql`DELETE FROM projects WHERE org_id = ${orgId}`;
  await sql`DELETE FROM organizations WHERE id = ${orgId}`;
  await sql?.end();
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
}, 120_000);

suite('F2.14 — criar, guardar e publicar', () => {
  it('um técnico não pode criar formulários', async () => {
    const resposta = await pedir('POST', '/admin/forms', ['tecnico'], {
      projecto_id: projectId,
      key: 'local_consumo',
      titulo: { pt: 'Local de Consumo' },
    });
    expect(resposta.statusCode).toBe(403);
  });

  it('um administrador cria o formulário', async () => {
    const resposta = await pedir('POST', '/admin/forms', ['admin'], {
      projecto_id: projectId,
      key: 'local_consumo',
      titulo: { pt: 'Local de Consumo' },
    });
    expect(resposta.statusCode).toBe(201);
    formId = resposta.json().form_id;
    expect(formId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('guardar um rascunho inválido não o perde, mas diz o que está mal', async () => {
    const invalida = {
      ...DEFINICAO_V1,
      fields: [
        {
          id: 'f_a',
          name: 'a',
          type: 'text',
          relevant: { op: '==', args: ['$f_nao_existe', 1] },
        },
      ],
    };
    const resposta = await pedir('POST', `/admin/forms/${formId}/versions`, ['admin'], {
      definicao: invalida,
    });
    expect(resposta.statusCode).toBe(201);
    const corpo = resposta.json();
    expect(corpo.valido).toBe(false);
    expect(corpo.problemas.map((p: { code: string }) => p.code)).toContain(
      'referencia_desconhecida',
    );
  });

  it('recusa publicar uma definição inválida', async () => {
    const resposta = await pedir('POST', `/admin/forms/${formId}/publish`, ['admin']);
    expect(resposta.statusCode).toBe(409);
    expect(resposta.json().message).toContain('publicação não foi feita');
  });

  it('publica e gera as vistas do QGIS', async () => {
    const rascunho = await pedir('POST', `/admin/forms/${formId}/versions`, ['admin'], {
      definicao: DEFINICAO_V1,
    });
    expect(rascunho.json().valido).toBe(true);

    const resposta = await pedir('POST', `/admin/forms/${formId}/publish`, ['admin']);
    expect(resposta.statusCode, resposta.body).toBe(201);
    const corpo = resposta.json();
    expect(corpo.versao).toBe(1);
    expect(corpo.hash).toMatch(/^sha256:/);

    // Vista raiz, vista do repetível, e as duas `_actual`.
    const nomes = corpo.vistas.map((v: { nome: string }) => v.nome);
    expect(nomes).toContain(`v_${projectKey}_local_consumo_v1`);
    expect(nomes).toContain(`v_${projectKey}_local_consumo_contadores_v1`);
    expect(nomes).toContain(`v_${projectKey}_local_consumo_actual`);
    expect(corpo.indices).toContain('cvf_busca_f_cod');

    // E existem mesmo na base, prontas a ser consultadas.
    const existe = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.views
      WHERE table_schema = 'cvf_views' AND table_name = ${`v_${projectKey}_local_consumo_v1`}
    `;
    expect(existe[0]!.n).toBe(1);
  });

  it('a segunda publicação calcula o diff e recusa o incompatível sem confirmação', async () => {
    const semCampo = {
      ...DEFINICAO_V1,
      fields: DEFINICAO_V1.fields.filter((f) => f.id !== 'f_tipo'),
    };
    const resposta = await pedir('POST', `/admin/forms/${formId}/publish`, ['admin'], {
      definicao: semCampo,
    });
    expect(resposta.statusCode).toBe(409);
    const corpo = resposta.json();
    expect(corpo.diff.compatible).toBe(false);
    expect(corpo.problemas.map((p: { code: string }) => p.code)).toContain('campo_removido');
  });

  it('com confirmação explícita, publica na mesma', async () => {
    const semCampo = {
      ...DEFINICAO_V1,
      fields: DEFINICAO_V1.fields.filter((f) => f.id !== 'f_tipo'),
    };
    const resposta = await pedir('POST', `/admin/forms/${formId}/publish`, ['admin'], {
      definicao: semCampo,
      confirmar_incompativel: true,
    });
    expect(resposta.statusCode).toBe(201);
    expect(resposta.json().versao).toBe(2);

    // A vista da v1 continua de pé: um registo recolhido com ela ainda se lê.
    const existe = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.views
      WHERE table_schema = 'cvf_views' AND table_name = ${`v_${projectKey}_local_consumo_v1`}
    `;
    expect(existe[0]!.n).toBe(1);
  });

  it('o diff está disponível antes de publicar', async () => {
    const resposta = await pedir('POST', `/admin/forms/${formId}/versions/3/diff`, ['admin'], {
      definicao: {
        ...DEFINICAO_V1,
        fields: [
          ...DEFINICAO_V1.fields,
          { id: 'f_obs', name: 'observacoes', type: 'text', label: { pt: 'Observações' } },
        ],
      },
    });
    expect(resposta.statusCode).toBe(201);
    const corpo = resposta.json();
    expect(corpo.compativel).toBe(true);
    expect(corpo.alteracoes.map((a: { code: string }) => a.code)).toContain('campo_acrescentado');
  });
});

suite('ninguém vê um formulário que não lhe foi atribuído', () => {
  it('o técnico não vê nada antes da atribuição', async () => {
    const resposta = await pedir('GET', '/forms', ['tecnico']);
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().formularios).toEqual([]);
  });

  it('pedir a definição sem atribuição dá 403', async () => {
    const resposta = await pedir('GET', `/forms/${formId}/versions/1`, ['tecnico']);
    expect(resposta.statusCode).toBe(403);
  });

  it('depois de atribuído, vê o formulário e a definição', async () => {
    // O utilizador interno só existe depois do primeiro pedido autenticado.
    const [utilizador] = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE subject = ${subjectTecnico}
    `;
    expect(utilizador).toBeDefined();

    const atribuicao = await pedir('POST', `/admin/forms/${formId}/assignments`, ['admin'], {
      principal_type: 'user',
      principal_id: utilizador!.id,
      pode_ler: true,
      pode_criar: true,
    });
    expect(atribuicao.statusCode).toBe(201);

    const lista = await pedir('GET', '/forms', ['tecnico']);
    const formularios = lista.json().formularios;
    expect(formularios).toHaveLength(1);
    expect(formularios[0]).toMatchObject({
      form_id: formId,
      key: 'local_consumo',
      versao: 2,
      permissoes: { criar: true },
    });
    expect(formularios[0].hash).toMatch(/^sha256:/);
  });

  it('a definição de uma versão antiga continua a ser servida', async () => {
    // Um registo criado com a v1 tem de continuar a abrir com a v1.
    const resposta = await pedir('GET', `/forms/${formId}/versions/1`, ['tecnico']);
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json();
    expect(corpo.definicao.version).toBe(1);
    expect(corpo.definicao.fields.some((f: { id: string }) => f.id === 'f_tipo')).toBe(true);
  });

  it('o manifesto traz os hashes das listas, a media e as vistas', async () => {
    const resposta = await pedir('GET', `/forms/${formId}/manifest`, ['tecnico']);
    expect(resposta.statusCode).toBe(200);
    const manifesto = resposta.json();
    expect(manifesto.version).toBe(2);
    expect(manifesto.choice_lists.map((l: { key: string }) => l.key)).toContain('lista_tipos');
    expect(manifesto.views.map((v: { name: string }) => v.name)).toContain(
      `v_${projectKey}_local_consumo_v2`,
    );
  });

  it('updated_since não devolve nada quando nada mudou', async () => {
    const futuro = new Date(Date.now() + 60_000).toISOString();
    const resposta = await pedir('GET', `/forms?updated_since=${futuro}`, ['tecnico']);
    expect(resposta.json().formularios).toEqual([]);
  });
});

suite('importar e exportar', () => {
  it('importa um XLSForm em linhas e diz o que se perdeu', async () => {
    const resposta = await pedir('POST', '/admin/forms/import/xlsform', ['admin'], {
      projecto_id: projectId,
      simular: true,
      survey: [
        { type: 'start', name: 'start' },
        { type: 'text', name: 'codigo', label: 'Código', required: 'yes' },
        { type: 'select_one lista', name: 'tipo', label: 'Tipo' },
        { type: 'begin repeat', name: 'medicoes', label: 'Medições' },
        { type: 'decimal', name: 'valor', label: 'Valor' },
        { type: 'end repeat', name: 'medicoes' },
        { type: 'calculate', name: 'total', calculation: 'sum(${valor})' },
      ],
      choices: [
        { list_name: 'lista', name: 'a', label: 'A' },
        { list_name: 'lista', name: 'b', label: 'B' },
      ],
      settings: [{ form_title: 'Importado', form_id: 'importado', version: '2026' }],
    });

    expect(resposta.statusCode).toBe(201);
    const corpo = resposta.json();
    expect(corpo.ok).toBe(true);
    expect(corpo.key_do_xlsform).toBe('importado');
    // O `start` é metadado do XLSForm e não vira pergunta — e isso é dito.
    expect(corpo.perdas.some((p: { value: string }) => p.value === 'start')).toBe(true);
    expect(corpo.definicao.fields.map((f: { name: string }) => f.name)).toEqual([
      'codigo',
      'tipo',
      'medicoes',
      'total',
    ]);
  });

  it('exporta em JSON e em XLSForm', async () => {
    const json = await pedir('GET', `/admin/forms/${formId}/export?format=json`, ['admin']);
    expect(json.statusCode).toBe(200);
    expect(json.json().form_id).toBe(formId);

    const xls = await pedir('GET', `/admin/forms/${formId}/export?format=xlsform`, ['admin']);
    expect(xls.statusCode).toBe(200);
    const corpo = xls.json();
    expect(corpo.workbook.survey.map((r: { name: string }) => r.name)).toContain('codigo');
    // O limiar de precisão não existe no XLSForm, e o exportador diz isso.
    expect(corpo.perdas.some((p: { reason: string }) => p.reason.includes('max_accuracy_m'))).toBe(
      true,
    );
  });
});

suite('F2.12 — arquivar', () => {
  it('apaga as vistas e não apaga um registo', async () => {
    const antes = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions
    `;
    const resposta = await pedir('DELETE', `/admin/forms/${formId}`, ['admin']);
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().vistas_apagadas).toBeGreaterThan(0);

    const vistas = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM information_schema.views
      WHERE table_schema = 'cvf_views' AND table_name LIKE ${`v_${projectKey}_%`}
    `;
    expect(vistas[0]!.n).toBe(0);

    const depois = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions
    `;
    expect(depois[0]!.n).toBe(antes[0]!.n);
  });

  it('um formulário arquivado deixa de aparecer ao técnico', async () => {
    const resposta = await pedir('GET', '/forms', ['tecnico']);
    expect(resposta.json().formularios).toEqual([]);
  });
});

suite('F6.5 — utilizadores, papéis e equipas', () => {
  /**
   * Antes disto, pôr um técnico a trabalhar obrigava a escrever SQL numa
   * consola de produção — que corre como dono das tabelas e ignora o RLS.
   */
  it('um técnico não gere pessoas', async () => {
    expect((await pedir('GET', '/admin/users', ['tecnico'])).statusCode).toBe(403);
  });

  it('lista quem já entrou, com papéis, equipas e quantos formulários vê', async () => {
    const resposta = await pedir('GET', '/admin/users', ['admin']);
    expect(resposta.statusCode).toBe(200);
    const nomes = resposta.json().utilizadores.map((u: { username: string }) => u.username);
    expect(nomes).toContain('admin.demo');
  });

  it('cria uma equipa e mete lá alguém', async () => {
    const equipa = await pedir('POST', '/admin/teams', ['admin'], {
      key: 'bengo',
      nome: 'Brigada do Bengo',
    });
    expect(equipa.statusCode).toBe(201);
    const equipaId = equipa.json().id;

    const [utilizador] = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE subject = ${subjectAdmin}
    `;
    const membros = await pedir('POST', `/admin/teams/${equipaId}/members`, ['admin'], {
      utilizadores: [utilizador!.id],
    });
    expect(membros.statusCode).toBe(201);

    const lista = await pedir('GET', `/admin/teams/${equipaId}/members`, ['admin']);
    expect(lista.json().membros).toHaveLength(1);

    // Substituir e não somar: o que o ecrã mostra é o estado final.
    await pedir('POST', `/admin/teams/${equipaId}/members`, ['admin'], { utilizadores: [] });
    expect(
      (await pedir('GET', `/admin/teams/${equipaId}/members`, ['admin'])).json().membros,
    ).toHaveLength(0);
  });

  it('uma chave de equipa repetida é recusada', async () => {
    await pedir('POST', '/admin/teams', ['admin'], { key: 'uige', nome: 'Uíge' });
    const segunda = await pedir('POST', '/admin/teams', ['admin'], { key: 'uige', nome: 'Outra' });
    expect(segunda.statusCode).toBe(400);
  });

  it('não se atribui um papel de outra organização', async () => {
    // Sem esta verificação, um gestor podia dar a alguém o papel de outra
    // organização e, com ele, as atribuições de formulário penduradas nesse
    // papel.
    const outraOrg = randomUUID();
    const papelDeFora = randomUUID();
    await sql`INSERT INTO organizations (id, key, name) VALUES (${outraOrg}, ${'z' + outraOrg.slice(0, 8)}, 'Outra')`;
    await sql`INSERT INTO roles (id, org_id, key, name) VALUES (${papelDeFora}, ${outraOrg}, 'x', 'De fora')`;

    const [utilizador] = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE subject = ${subjectAdmin}
    `;
    try {
      const resposta = await pedir('POST', `/admin/users/${utilizador!.id}/roles`, ['admin'], {
        papeis: [papelDeFora],
      });
      expect(resposta.statusCode).toBe(400);
    } finally {
      await sql`DELETE FROM roles WHERE id = ${papelDeFora}`;
      await sql`DELETE FROM organizations WHERE id = ${outraOrg}`;
    }
  });

  it('um utilizador de outra organização não existe para este administrador', async () => {
    const resposta = await pedir('POST', `/admin/users/${randomUUID()}/roles`, ['admin'], {
      papeis: [],
    });
    expect(resposta.statusCode).toBe(404);
  });
});
