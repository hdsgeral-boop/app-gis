/**
 * F5 do lado do servidor — registos, revisões, conflitos e idempotência.
 *
 * As três coisas que este ficheiro existe para provar, e que são as três
 * formas conhecidas de perder trabalho de campo:
 *   - um `POST` repetido por causa da rede não duplica o registo;
 *   - duas revisões construídas sobre a mesma base guardam-se as duas;
 *   - uma revisão com dados inválidos é gravada na mesma, e fica visível.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { uuidv7 } from '@cvforms/form-core';
import postgres from 'postgres';

import { AppModule } from '../src/app.module.js';
import { comContexto } from '../src/db/contexto.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

let app: NestFastifyApplication;
let jwks: Server;
let issuer: string;
let chave: CryptoKey;
let sql: postgres.Sql;

const orgId = randomUUID();
const projectId = randomUUID();
const formId = randomUUID();
const versaoId = randomUUID();
const subjectTecnico = randomUUID();
const subjectOutro = randomUUID();
const KID = 'chave-de-teste';

const PONTO = {
  lat: -8.8383,
  lon: 13.2344,
  accuracy_m: 0.8,
  fix_type: 'fixed',
  source: 'external_tcp',
};

const DEFINICAO = {
  spec_version: 1,
  form_id: formId,
  version: 1,
  title: { pt: 'Local de Consumo' },
  settings: { geometry_field: 'f_geo', max_accuracy_m: 2 },
  fields: [
    {
      id: 'f_cod',
      name: 'codigo',
      type: 'text',
      label: { pt: 'Código' },
      required: true,
      constraint: { op: 'matches', args: ['$self', '^LC[0-9]{6}$'] },
      constraint_message: { pt: 'Formato esperado: LC000000' },
    },
    { id: 'f_geo', name: 'localizacao', type: 'geopoint', label: { pt: 'Localização' } },
    {
      id: 'g_cont',
      name: 'contadores',
      type: 'repeat',
      label: { pt: 'Contadores' },
      fields: [{ id: 'f_ns', name: 'numero_serie', type: 'text', label: { pt: 'Série' } }],
    },
  ],
};

async function token(subject: string, papeis = ['tecnico']): Promise<string> {
  return new SignJWT({
    preferred_username: subject === subjectTecnico ? 'tecnico.demo' : 'outro.demo',
    org_id: orgId,
    realm_access: { roles: papeis },
  })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(subject)
    .setIssuer(issuer)
    .setAudience('cvforms-mobile')
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(chave);
}

async function pedir(
  metodo: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  opcoes: {
    corpo?: unknown;
    subject?: string;
    papeis?: string[];
    cabecalhos?: Record<string, string>;
  } = {},
) {
  return app.inject({
    method: metodo,
    url,
    headers: {
      authorization: `Bearer ${await token(opcoes.subject ?? subjectTecnico, opcoes.papeis)}`,
      ...opcoes.cabecalhos,
    },
    ...(opcoes.corpo === undefined ? {} : { payload: opcoes.corpo as object }),
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
  process.env.KEYCLOAK_AUDIENCE = 'cvforms-mobile';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';

  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await sql`INSERT INTO organizations (id, key, name) VALUES (${orgId}, ${'org' + orgId.slice(0, 8)}, 'Org dos registos')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projectId}, ${orgId}, ${'p' + projectId.slice(0, 6)}, 'Piloto')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
            VALUES (${formId}, ${orgId}, ${projectId}, 'local_consumo', ${sql.json({ pt: 'Local de Consumo' })}, 1)`;
  await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
            VALUES (${versaoId}, ${formId}, 1, ${sql.json(DEFINICAO as never)}, 'sha256:v1', now())`;

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  // O utilizador interno nasce ao primeiro pedido autenticado; a atribuição
  // precisa do id dele.
  await pedir('GET', '/me');
  const [utilizador] = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE subject = ${subjectTecnico}
  `;
  await sql`
    INSERT INTO form_assignments (id, form_id, principal_type, principal_id,
                                  can_read, can_create, can_edit_own, can_edit_all, can_delete)
    VALUES (${randomUUID()}, ${formId}, 'user', ${utilizador!.id}, true, true, true, false, true)
  `;
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM gps_fixes WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formId})`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formId})`;
  await sql`DELETE FROM records WHERE form_id = ${formId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM idempotency_keys WHERE user_id IN (SELECT id FROM users WHERE org_id = ${orgId})`;
  await sql`DELETE FROM form_assignments WHERE form_id = ${formId}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${formId}`;
  await sql`DELETE FROM forms WHERE id = ${formId}`;
  await sql`DELETE FROM users WHERE org_id = ${orgId}`;
  await sql`DELETE FROM projects WHERE org_id = ${orgId}`;
  await sql`DELETE FROM organizations WHERE id = ${orgId}`;
  await sql?.end();
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
}, 120_000);

suite('F6.2 — a API corre sujeita ao RLS', () => {
  it('dentro de um pedido, o papel é o restrito e o contexto está definido', async () => {
    const observado = await comContexto(
      { pool: sql, papel: 'cvforms_app', orgId, userId: undefined, administracao: false },
      async () => {
        const contexto = (await import('../src/db/contexto.js')).contextoActual();
        const [linha] = await contexto!.sql<Array<{ papel: string; org: string; admin: string }>>`
          SELECT current_user AS papel,
                 current_setting('cvf.org_id', true) AS org,
                 current_setting('cvf.admin', true) AS admin
        `;
        return linha!;
      },
    );

    // Se o papel aqui fosse o dono das tabelas, TODAS as políticas da migração
    // 0004 deixavam de valer, e sem erro nenhum. É o modo de falha do ADR-0010.
    expect(observado.papel).toBe('cvforms_app');
    expect(observado.org).toBe(orgId);
    expect(observado.admin).toBe('false');
  });

  it('a ligação volta ao pool limpa, sem papel nem contexto', async () => {
    await comContexto(
      { pool: sql, papel: 'cvforms_app', orgId, userId: undefined, administracao: true },
      async () => undefined,
    );

    // Uma ligação devolvida ao pool com `SET ROLE` por reverter contaminaria o
    // pedido seguinte, e o sintoma seria dados na organização errada.
    const [depois] = await sql<Array<{ papel: string; org: string }>>`
      SELECT current_user AS papel, current_setting('cvf.org_id', true) AS org
    `;
    expect(depois!.papel).toBe('cvforms');
    expect(depois!.org === '' || depois!.org === null).toBe(true);
  });
});

suite('criar um registo', () => {
  it('o id vem do cliente e tem de ser UUIDv7', async () => {
    const resposta = await pedir('POST', '/records', {
      corpo: { id: randomUUID(), form_id: formId, data: { f_cod: 'LC000001' } },
    });
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().message).toContain('UUIDv7');
  });

  it('grava a revisão 1, sem base, e devolve o estado', async () => {
    const id = uuidv7();
    const resposta = await pedir('POST', '/records', {
      corpo: {
        id,
        form_id: formId,
        data: { f_cod: 'LC000123', f_geo: PONTO },
        device_id: 'telefone-1',
      },
    });
    expect(resposta.statusCode, resposta.body).toBe(201);
    const corpo = resposta.json();
    expect(corpo).toMatchObject({
      record_id: id,
      revision_no: 1,
      status: 'rascunho',
      conflito: false,
    });
    expect(corpo.problemas).toEqual([]);

    const [registo] = await sql<Array<{ current_revision_id: string; lat: number; lon: number }>>`
      SELECT current_revision_id, ST_Y(geom) AS lat, ST_X(geom) AS lon FROM records WHERE id = ${id}
    `;
    expect(registo!.current_revision_id).toBe(corpo.revision_id);
    // A geometria do registo vem do campo indicado em settings.geometry_field.
    expect(Number(registo!.lat)).toBeCloseTo(-8.8383, 6);
  });

  it('escreve um gps_fix por cada ponto, com precisão e origem (restrição 8)', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000200', f_geo: PONTO } },
    });
    const fixes = await sql<
      Array<{ field_id: string; accuracy_m: number; fix_type: string; source: string }>
    >`
      SELECT field_id, accuracy_m, fix_type, source FROM gps_fixes WHERE record_id = ${id}
    `;
    expect(fixes).toHaveLength(1);
    expect(fixes[0]).toMatchObject({
      field_id: 'f_geo',
      fix_type: 'fixed',
      source: 'external_tcp',
    });
  });

  it('sem atribuição de criação, recusa', async () => {
    const resposta = await pedir('POST', '/records', {
      subject: subjectOutro,
      corpo: { id: uuidv7(), form_id: formId, data: { f_cod: 'LC000999' } },
    });
    expect(resposta.statusCode).toBe(403);
  });
});

suite('dados inválidos não se perdem', () => {
  it('a revisão é gravada, o registo fica needs_review, e diz-se porquê', async () => {
    const id = uuidv7();
    const resposta = await pedir('POST', '/records', {
      corpo: {
        id,
        form_id: formId,
        data: { f_cod: 'nao-cumpre-o-formato' },
        status: 'submetido',
      },
    });

    // 201, e não 422: recusar deixaria o registo preso na fila do telefone.
    expect(resposta.statusCode).toBe(201);
    const corpo = resposta.json();
    expect(corpo.status).toBe('needs_review');
    expect(corpo.problemas.map((p: { code: string }) => p.code)).toContain('restricao');

    const [linha] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions WHERE record_id = ${id}
    `;
    expect(linha!.n).toBe(1);
  });

  it('acima do limiar de precisão sem justificação também fica needs_review', async () => {
    const id = uuidv7();
    const resposta = await pedir('POST', '/records', {
      corpo: {
        id,
        form_id: formId,
        data: { f_cod: 'LC000300', f_geo: { ...PONTO, accuracy_m: 25 } },
      },
    });
    expect(resposta.json().problemas.map((p: { code: string }) => p.code)).toContain(
      'precisao_acima_do_limiar',
    );
    expect(resposta.json().status).toBe('needs_review');
  });

  it('com justificação escrita, grava sem problema e a justificação fica na revisão', async () => {
    const id = uuidv7();
    const resposta = await pedir('POST', '/records', {
      corpo: {
        id,
        form_id: formId,
        data: { f_cod: 'LC000301', f_geo: { ...PONTO, accuracy_m: 25 } },
        justificacao_de_precisao: 'Sem céu aberto: recolhido junto ao muro do PT.',
      },
    });
    expect(resposta.json().status).toBe('rascunho');
    const [revisao] = await sql<Array<{ accuracy_override_reason: string }>>`
      SELECT accuracy_override_reason FROM record_revisions WHERE record_id = ${id}
    `;
    expect(revisao!.accuracy_override_reason).toContain('muro do PT');
  });
});

suite('editar e conflitos (ADR-0007)', () => {
  it('editar cria a revisão seguinte, encadeada na anterior', async () => {
    const id = uuidv7();
    const primeira = await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000400' } },
    });
    const base = primeira.json().revision_id;

    const segunda = await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000401' } },
      cabecalhos: { 'if-match': base },
    });
    expect(segunda.statusCode).toBe(200);
    expect(segunda.json()).toMatchObject({ revision_no: 2, conflito: false });

    const revisoes = await sql<Array<{ revision_no: number; base_revision_id: string | null }>>`
      SELECT revision_no, base_revision_id FROM record_revisions WHERE record_id = ${id} ORDER BY revision_no
    `;
    expect(revisoes.map((r) => r.base_revision_id)).toEqual([null, base]);
  });

  it('dois dispositivos sobre a mesma base: ambas ficam, registo em needs_review', async () => {
    const id = uuidv7();
    const criado = await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000500' }, device_id: 'telefone-1' },
    });
    const base = criado.json().revision_id;

    // O primeiro telefone sincroniza.
    const a = await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000501' }, device_id: 'telefone-1' },
      cabecalhos: { 'if-match': base },
    });
    expect(a.json().conflito).toBe(false);

    // O segundo estava offline e ainda tem a base antiga.
    const b = await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000502' }, device_id: 'telefone-2' },
      cabecalhos: { 'if-match': base },
    });
    expect(b.statusCode).toBe(200);
    expect(b.json().conflito).toBe(true);
    expect(b.json().status).toBe('needs_review');

    // Nenhum trabalho se perdeu: três revisões, e as duas em conflito têm a
    // mesma base.
    const revisoes = await sql<
      Array<{ revision_no: number; base_revision_id: string | null; data: { f_cod: string } }>
    >`
      SELECT revision_no, base_revision_id, data FROM record_revisions WHERE record_id = ${id} ORDER BY revision_no
    `;
    expect(revisoes).toHaveLength(3);
    expect(revisoes.map((r) => r.data.f_cod)).toEqual(['LC000500', 'LC000501', 'LC000502']);
    expect(revisoes[1]!.base_revision_id).toBe(base);
    expect(revisoes[2]!.base_revision_id).toBe(base);
  });

  it('o endpoint de conflitos mostra os ramos para alguém escolher', async () => {
    const id = uuidv7();
    const criado = await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000600' } },
    });
    const base = criado.json().revision_id;
    await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000601' } },
      cabecalhos: { 'if-match': base },
    });
    await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000602' } },
      cabecalhos: { 'if-match': base },
    });

    const resposta = await pedir('GET', `/records/${id}/conflitos`);
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json();
    expect(corpo.estado).toBe('needs_review');
    expect(corpo.conflitos).toHaveLength(1);
    expect(corpo.conflitos[0].ramos).toBe(2);
  });

  it('o histórico completo está disponível', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000700' } },
    });
    await pedir('PATCH', `/records/${id}`, { corpo: { data: { f_cod: 'LC000701' } } });

    const resposta = await pedir('GET', `/records/${id}/revisions`);
    expect(resposta.json().revisoes.map((r: { revision_no: number }) => r.revision_no)).toEqual([
      1, 2,
    ]);
  });
});

suite('idempotência', () => {
  it('o mesmo POST repetido não duplica o registo', async () => {
    const id = uuidv7();
    const corpo = { id, form_id: formId, data: { f_cod: 'LC000800' } };
    const chave = `teste-${id}`;

    const primeira = await pedir('POST', '/records', {
      corpo,
      cabecalhos: { 'idempotency-key': chave },
    });
    const segunda = await pedir('POST', '/records', {
      corpo,
      cabecalhos: { 'idempotency-key': chave },
    });

    expect(primeira.json().revision_id).toBe(segunda.json().revision_id);
    const [linha] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions WHERE record_id = ${id}
    `;
    expect(linha!.n).toBe(1);
  });

  it('a mesma chave com outro corpo é recusada em vez de responder a antiga', async () => {
    const chave = `teste-conflito-${uuidv7()}`;
    await pedir('POST', '/records', {
      corpo: { id: uuidv7(), form_id: formId, data: { f_cod: 'LC000900' } },
      cabecalhos: { 'idempotency-key': chave },
    });
    const segunda = await pedir('POST', '/records', {
      corpo: { id: uuidv7(), form_id: formId, data: { f_cod: 'LC000901' } },
      cabecalhos: { 'idempotency-key': chave },
    });
    expect(segunda.statusCode).toBe(409);
  });
});

suite('ADR-0011 — perder a atribuição com trabalho por sincronizar', () => {
  it('o que já foi recolhido sobe na mesma; criar de novo é que fica vedado', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC001400' } },
    });

    const [utilizador] = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE subject = ${subjectTecnico}
    `;
    const atribuicao = await sql<Array<Record<string, unknown>>>`
      SELECT * FROM form_assignments WHERE form_id = ${formId} AND principal_id = ${utilizador!.id}
    `;

    // O administrador tira-lhe a atribuição enquanto ele está no mato.
    await sql`DELETE FROM form_assignments WHERE form_id = ${formId} AND principal_id = ${utilizador!.id}`;

    // A subida do que ele já tinha recolhido passa.
    const subida = await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC001401' } },
    });
    expect(subida.statusCode, subida.body).toBe(200);
    expect(subida.json().revision_no).toBe(2);

    // Criar um registo novo, não.
    const novo = await pedir('POST', '/records', {
      corpo: { id: uuidv7(), form_id: formId, data: { f_cod: 'LC001402' } },
    });
    expect(novo.statusCode).toBe(403);

    // E deixa de ver o formulário e os registos.
    expect((await pedir('GET', '/forms')).json().formularios).toEqual([]);

    // Devolve-se a atribuição para os testes seguintes não dependerem desta ordem.
    const a = atribuicao[0]!;
    await sql`
      INSERT INTO form_assignments (id, form_id, principal_type, principal_id,
                                    can_read, can_create, can_edit_own, can_edit_all, can_delete)
      VALUES (${a['id'] as string}, ${formId}, 'user', ${utilizador!.id}, true, true, true, false, true)
    `;
  });
});

suite('apagar e restaurar', () => {
  it('apagar é um tombstone e as revisões ficam todas', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC001000' } },
    });

    const apagado = await pedir('DELETE', `/records/${id}`);
    expect(apagado.json()).toMatchObject({ apagado: true, tombstone: true });

    const [linha] = await sql<Array<{ deleted_at: Date | null; revisoes: number }>>`
      SELECT r.deleted_at,
             (SELECT count(*)::int FROM record_revisions v WHERE v.record_id = r.id) AS revisoes
      FROM records r WHERE r.id = ${id}
    `;
    expect(linha!.deleted_at).not.toBeNull();
    expect(linha!.revisoes).toBe(1);

    // Deixa de aparecer na listagem, mas continua na base.
    const lista = await pedir('GET', `/records?form_id=${formId}`);
    expect(lista.json().registos.some((r: { id: string }) => r.id === id)).toBe(false);
  });

  it('restaurar devolve o registo à listagem', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC001100' } },
    });
    await pedir('DELETE', `/records/${id}`);
    const restaurado = await pedir('POST', `/records/${id}/restore`);
    expect(restaurado.json().restaurado).toBe(true);

    const lista = await pedir('GET', `/records?form_id=${formId}`);
    expect(lista.json().registos.some((r: { id: string }) => r.id === id)).toBe(true);
  });
});

suite('listagem', () => {
  it('filtra por bbox, que é o que o mapa e o QGIS fazem', async () => {
    const dentro = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id: dentro, form_id: formId, data: { f_cod: 'LC001200', f_geo: PONTO } },
    });
    const fora = uuidv7();
    await pedir('POST', '/records', {
      corpo: {
        id: fora,
        form_id: formId,
        data: { f_cod: 'LC001201', f_geo: { ...PONTO, lat: 40.0, lon: -8.0 } },
      },
    });

    const resposta = await pedir('GET', `/records?form_id=${formId}&bbox=13.0,-9.0,13.5,-8.5`);
    const ids = resposta.json().registos.map((r: { id: string }) => r.id);
    expect(ids).toContain(dentro);
    expect(ids).not.toContain(fora);
  });

  it('um bbox mal formado é recusado', async () => {
    const resposta = await pedir('GET', `/records?form_id=${formId}&bbox=isto-nao-e-um-bbox`);
    expect(resposta.statusCode).toBe(400);
  });

  it('quem não tem o formulário atribuído não vê nada', async () => {
    const resposta = await pedir('GET', '/records', { subject: subjectOutro });
    expect(resposta.json().registos).toEqual([]);
  });

  it('updated_since só devolve o que mudou depois', async () => {
    const futuro = new Date(Date.now() + 60_000).toISOString();
    const resposta = await pedir('GET', `/records?form_id=${formId}&updated_since=${futuro}`);
    expect(resposta.json().registos).toEqual([]);
  });
});

suite('auditoria', () => {
  it('criar, editar e apagar ficam registados, sem o conteúdo das respostas', async () => {
    const id = uuidv7();
    await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC001300' } },
    });
    await pedir('PATCH', `/records/${id}`, { corpo: { data: { f_cod: 'LC001301' } } });
    await pedir('DELETE', `/records/${id}`);

    const linhas = await sql<Array<{ action: string; metadata: Record<string, unknown> | null }>>`
      SELECT action, metadata FROM audit_log
      WHERE entity_type = 'record' AND entity_id = ${id} ORDER BY at
    `;
    expect(linhas.map((l) => l.action)).toEqual(['criar', 'actualizar', 'apagar']);
    // Restrição inegociável 9: nada de dados pessoais nos registos de auditoria.
    expect(JSON.stringify(linhas)).not.toContain('LC001300');
  });
});

suite('F5.7 — resolver um conflito', () => {
  /** Cria um registo e faz dois telefones gravarem sobre a mesma base. */
  async function comConflito() {
    const id = uuidv7();
    const criado = await pedir('POST', '/records', {
      corpo: { id, form_id: formId, data: { f_cod: 'LC000900' }, device_id: 'telefone-1' },
    });
    const base = criado.json().revision_id;

    await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000901' }, device_id: 'telefone-1' },
      cabecalhos: { 'if-match': base },
    });
    const segunda = await pedir('PATCH', `/records/${id}`, {
      corpo: { data: { f_cod: 'LC000902' }, device_id: 'telefone-2' },
      cabecalhos: { 'if-match': base },
    });
    expect(segunda.json().conflito).toBe(true);
    return { id, base };
  }

  it('os ramos vêm com os dados, para o painel os mostrar lado a lado', async () => {
    const { id } = await comConflito();
    const resposta = await pedir('GET', `/records/${id}/conflitos`);
    const corpo = resposta.json();

    expect(corpo.estado).toBe('needs_review');
    expect(corpo.conflitos).toHaveLength(1);
    // Sem os dados, o painel tinha de fazer uma chamada por revisão para
    // desenhar duas colunas — e são as duas colunas que a F5.7 pede.
    expect(corpo.revisoes).toHaveLength(2);
    expect(corpo.revisoes.map((r: { data: { f_cod: string } }) => r.data.f_cod).sort()).toEqual([
      'LC000901',
      'LC000902',
    ]);
  });

  it('escolher um ramo grava uma revisão nova e NÃO apaga o outro', async () => {
    const { id } = await comConflito();
    const conflitos = (await pedir('GET', `/records/${id}/conflitos`)).json();
    const escolhida = conflitos.revisoes.find(
      (r: { data: { f_cod: string } }) => r.data.f_cod === 'LC000901',
    );

    const resposta = await pedir('POST', `/records/${id}/resolver`, {
      papeis: ['admin'],
      corpo: { revisao_escolhida: escolhida.id, nota: 'a primeira leitura tinha o código certo' },
    });
    expect(resposta.statusCode).toBe(201);
    expect(resposta.json()).toMatchObject({ resolvido: true, status: 'submetido' });

    const revisoes = await sql<Array<{ revision_no: number; data: { f_cod: string } }>>`
      SELECT revision_no, data FROM record_revisions WHERE record_id = ${id} ORDER BY revision_no
    `;
    // Quatro: a inicial, os dois ramos, e a da resolução. Uma revisão nunca se
    // apaga nem se sobrescreve (restrição inegociável 4).
    expect(revisoes).toHaveLength(4);
    expect(revisoes.map((r) => r.data.f_cod)).toEqual([
      'LC000900',
      'LC000901',
      'LC000902',
      'LC000901',
    ]);

    const [registo] = await sql<Array<{ status: string; current_revision_id: string }>>`
      SELECT status, current_revision_id FROM records WHERE id = ${id}
    `;
    expect(registo!.status).toBe('submetido');
    expect(registo!.current_revision_id).toBe(resposta.json().revisao);
  });

  it('a decisão e a nota ficam na auditoria', async () => {
    const { id } = await comConflito();
    const conflitos = (await pedir('GET', `/records/${id}/conflitos`)).json();
    await pedir('POST', `/records/${id}/resolver`, {
      papeis: ['admin'],
      corpo: { revisao_escolhida: conflitos.revisoes[0].id, nota: 'receptor externo' },
    });

    const [linha] = await sql<Array<{ metadata: { nota: string; escolhida: string } }>>`
      SELECT metadata FROM audit_log
      WHERE entity_id = ${id} AND metadata ? 'resolucao_de_conflito'
      ORDER BY at DESC LIMIT 1
    `;
    expect(linha!.metadata.nota).toBe('receptor externo');
    expect(linha!.metadata.escolhida).toBe(conflitos.revisoes[0].id);
  });

  it('quem só pode editar os próprios registos não decide o de ninguém', async () => {
    const { id } = await comConflito();
    const conflitos = (await pedir('GET', `/records/${id}/conflitos`)).json();
    const resposta = await pedir('POST', `/records/${id}/resolver`, {
      corpo: { revisao_escolhida: conflitos.revisoes[0].id },
    });
    expect(resposta.statusCode).toBe(403);
  });

  it('uma revisão de outro registo é recusada', async () => {
    const { id } = await comConflito();
    const outro = await comConflito();
    const conflitosDoOutro = (await pedir('GET', `/records/${outro.id}/conflitos`)).json();

    const resposta = await pedir('POST', `/records/${id}/resolver`, {
      papeis: ['admin'],
      corpo: { revisao_escolhida: conflitosDoOutro.revisoes[0].id },
    });
    expect(resposta.statusCode).toBe(400);
  });
});
