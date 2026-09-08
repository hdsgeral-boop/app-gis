/**
 * Projectos, ponta a ponta.
 *
 * PORQUE É QUE ISTO EXISTE. Um formulário pertence sempre a um projecto, e até
 * agora não havia como criar o primeiro sem um `INSERT` à mão na base. Numa
 * organização acabada de criar, o painel mostrava «não há nenhum projecto» e
 * não dava nada para carregar — um beco fechado que só se via com o sistema a
 * correr, nunca num teste.
 *
 * O que se prova: que se cria, que a chave não se repete dentro da mesma
 * organização, que uma organização não vê os projectos da outra, e que
 * arquivar um projecto com formulários é recusado — porque isso levaria os
 * registos de campo com ele.
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
const outraOrgId = randomUUID();
const subjectAdmin = randomUUID();
const subjectGestor = randomUUID();
const subjectTecnico = randomUUID();
const subjectDeOutraOrg = randomUUID();
const KID = 'chave-de-teste';

async function token(papeis: string[], subject: string, org = orgId): Promise<string> {
  return new SignJWT({
    preferred_username: `u${subject.slice(0, 6)}`,
    org_id: org,
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
  subject = subjectAdmin,
  org = orgId,
) {
  return app.inject({
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(papeis, subject, org)}` },
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
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';

  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await sql`
    INSERT INTO organizations (id, key, name)
    VALUES (${orgId}, ${'org' + orgId.slice(0, 8)}, 'Org dos projectos')
  `;
  await sql`
    INSERT INTO organizations (id, key, name)
    VALUES (${outraOrgId}, ${'org' + outraOrgId.slice(0, 8)}, 'Org vizinha')
  `;

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  await sql`SET session_replication_role = replica`;
  for (const org of [orgId, outraOrgId]) {
    await sql`DELETE FROM audit_log WHERE org_id = ${org}`;
    await sql`DELETE FROM form_access WHERE org_id = ${org}`;
    await sql`DELETE FROM forms WHERE org_id = ${org}`;
    await sql`DELETE FROM users WHERE org_id = ${org}`;
    await sql`DELETE FROM projects WHERE org_id = ${org}`;
    await sql`DELETE FROM organizations WHERE id = ${org}`;
  }
  await sql?.end();
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
}, 120_000);

suite('projectos', () => {
  let projectoId = '';

  it('uma organização nova não tem projectos, e diz isso sem rebentar', async () => {
    const resposta = await pedir('GET', '/admin/projects', ['admin']);
    expect(resposta.statusCode).toBe(200);
    expect(resposta.json().projectos).toEqual([]);
  });

  it('um administrador cria o primeiro projecto', async () => {
    const resposta = await pedir('POST', '/admin/projects', ['admin'], {
      key: 'piloto_bengo',
      nome: 'Piloto do Bengo',
      descricao: 'Levantamento de locais de consumo',
    });
    expect(resposta.statusCode).toBe(201);
    projectoId = resposta.json().id;
    expect(projectoId).toBeTruthy();
  });

  it('aparece na lista, com a contagem de formulários a zero', async () => {
    const lista = (await pedir('GET', '/admin/projects', ['admin'])).json().projectos;
    expect(lista).toHaveLength(1);
    expect(lista[0].key).toBe('piloto_bengo');
    expect(lista[0].formularios).toBe(0);
    expect(lista[0].archived_at).toBeNull();
  });

  it('e aparece no /me de quem administra, mesmo sem formulário nenhum', async () => {
    // Era exactamente aqui que o painel encravava: o /me filtrava os projectos
    // pelos que já tinham formulários acessíveis, e numa organização nova isso
    // dá zero — logo o ecrã de criar formulário não tinha onde o pôr, e não se
    // conseguia criar o primeiro formulário nenhum.
    const perfil = (await pedir('GET', '/me', ['admin'])).json();
    expect(perfil.projectos.map((p: { key: string }) => p.key)).toContain('piloto_bengo');
  });

  it('um técnico continua a não ver um projecto onde não recolhe nada', async () => {
    const perfil = (await pedir('GET', '/me', ['tecnico'], undefined, subjectTecnico)).json();
    expect(perfil.projectos).toEqual([]);
  });

  it('a chave não se repete dentro da mesma organização', async () => {
    const resposta = await pedir('POST', '/admin/projects', ['admin'], {
      key: 'piloto_bengo',
      nome: 'Outro qualquer',
    });
    expect(resposta.statusCode).toBe(400);
  });

  it('mas a organização vizinha pode usar a mesma chave', async () => {
    const resposta = await pedir(
      'POST',
      '/admin/projects',
      ['admin'],
      { key: 'piloto_bengo', nome: 'Piloto de outra gente' },
      subjectDeOutraOrg,
      outraOrgId,
    );
    expect(resposta.statusCode).toBe(201);
  });

  it('e não vê o projecto da primeira', async () => {
    const lista = (
      await pedir('GET', '/admin/projects', ['admin'], undefined, subjectDeOutraOrg, outraOrgId)
    ).json().projectos;
    expect(lista).toHaveLength(1);
    expect(lista[0].name).toBe('Piloto de outra gente');
  });

  it('uma chave com maiúsculas, espaços ou traços é recusada', async () => {
    // A chave entra no nome das vistas do PostGIS; deixar passar um espaço dá
    // um nome que precisa de aspas em todo o lado onde for lido.
    for (const key of ['Piloto Bengo', 'piloto-bengo', '']) {
      const resposta = await pedir('POST', '/admin/projects', ['admin'], { key, nome: 'X' });
      expect(resposta.statusCode).toBe(400);
    }
  });

  it('um gestor também cria; um técnico não', async () => {
    const gestor = await pedir(
      'POST',
      '/admin/projects',
      ['gestor'],
      { key: 'uige', nome: 'Uíge' },
      subjectGestor,
    );
    expect(gestor.statusCode).toBe(201);

    const tecnico = await pedir(
      'POST',
      '/admin/projects',
      ['tecnico'],
      { key: 'cabinda', nome: 'Cabinda' },
      subjectTecnico,
    );
    expect(tecnico.statusCode).toBe(403);
  });

  it('um projecto com formulários recusa-se a ser arquivado', async () => {
    // Arquivar em cascata levaria formulários — e por eles, registos de campo.
    const formId = randomUUID();
    const titulo = JSON.stringify({ pt: 'Teste' });
    await sql`
      INSERT INTO forms (id, org_id, project_id, key, title)
      VALUES (${formId}, ${orgId}, ${projectoId}, 'f_teste', ${titulo}::text::jsonb)
    `;
    const resposta = await pedir('DELETE', `/admin/projects/${projectoId}`, ['admin']);
    expect(resposta.statusCode).toBe(400);

    await sql`DELETE FROM form_access WHERE form_id = ${formId}`;
    await sql`DELETE FROM forms WHERE id = ${formId}`;
  });

  it('vazio, arquiva — e continua na lista, marcado', async () => {
    const resposta = await pedir('DELETE', `/admin/projects/${projectoId}`, ['admin']);
    expect(resposta.statusCode).toBe(200);

    const lista = (await pedir('GET', '/admin/projects', ['admin'])).json().projectos;
    const arquivado = lista.find((p: { id: string }) => p.id === projectoId);
    expect(arquivado.archived_at).not.toBeNull();
  });

  it('arquivar um projecto de outra organização dá 404, e não 403', async () => {
    // Um 403 confirmaria que ele existe. Para quem está de fora, não existe.
    const resposta = await pedir(
      'DELETE',
      `/admin/projects/${projectoId}`,
      ['admin'],
      undefined,
      subjectDeOutraOrg,
      outraOrgId,
    );
    expect(resposta.statusCode).toBe(404);
  });
});
