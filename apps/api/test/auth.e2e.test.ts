/**
 * Autenticação ponta a ponta, sem mocks do nosso código.
 *
 * O verificador de JWT é o mesmo que vai a produção: vai buscar as chaves a um
 * JWKS por HTTP. Em vez de o substituir por um duplo, levantamos aqui um
 * servidor de chaves a sério e assinamos tokens a sério. O que fica por provar
 * é só o Keycloak em si — e isso o Keycloak já prova.
 *
 * Precisa de DATABASE_URL. Sem ela, os testes são saltados.
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
let chavePrivada: CryptoKey;
let outraChavePrivada: CryptoKey;
let sql: postgres.Sql;

const orgId = randomUUID();
const projectId = randomUUID();
const formVisivel = randomUUID();
const formInvisivel = randomUUID();
const versaoVisivel = randomUUID();
const versaoInvisivel = randomUUID();
const subjectTecnico = randomUUID();
const KID = 'chave-de-teste';

interface OpcoesToken {
  subject?: string;
  orgId?: string | null;
  audience?: string;
  expiraEm?: string;
  papeis?: string[];
  chave?: CryptoKey;
}

async function token(opcoes: OpcoesToken = {}): Promise<string> {
  const payload: Record<string, unknown> = {
    preferred_username: 'tecnico.demo',
    email: 'tecnico.demo@exemplo.local',
    name: 'Técnico Demo',
    realm_access: { roles: opcoes.papeis ?? ['tecnico'] },
  };
  if (opcoes.orgId !== null) payload.org_id = opcoes.orgId ?? orgId;

  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject(opcoes.subject ?? subjectTecnico)
    .setIssuer(issuer)
    .setAudience(opcoes.audience ?? 'cvforms-mobile')
    .setIssuedAt()
    .setExpirationTime(opcoes.expiraEm ?? '10m')
    .sign(opcoes.chave ?? chavePrivada);
}

beforeAll(async () => {
  if (!databaseUrl) return;

  const par = await generateKeyPair('RS256', { extractable: true });
  chavePrivada = par.privateKey;
  const jwk: JWK = { ...(await exportJWK(par.publicKey)), kid: KID, alg: 'RS256', use: 'sig' };
  outraChavePrivada = (await generateKeyPair('RS256', { extractable: true })).privateKey;

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
  process.env.KEYCLOAK_AUDIENCE = 'cvforms-mobile,cvforms-admin';
  // Silencioso por omissão, para a saída dos testes ser legível — mas
  // sobreponível: um 500 inesperado sem stack custa meia hora a diagnosticar.
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'fatal';

  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });
  await semear();

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  await limpar();
  await sql?.end();
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
});

async function semear() {
  await sql`INSERT INTO organizations (id, key, name) VALUES (${orgId}, ${'org' + orgId.slice(0, 8)}, 'Org de teste')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projectId}, ${orgId}, 'piloto', 'Piloto Bengo')`;
  for (const [formId, versaoId, key, titulo] of [
    [formVisivel, versaoVisivel, 'local_consumo', 'Local de Consumo'],
    [formInvisivel, versaoInvisivel, 'cadastro_agua', 'Cadastro de Água'],
  ] as const) {
    await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
              VALUES (${formId}, ${orgId}, ${projectId}, ${key}, ${sql.json({ pt: titulo })}, 1)`;
    await sql`INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
              VALUES (${versaoId}, ${formId}, 1, ${sql.json({ spec_version: 1, fields: [] })}, ${'sha256:' + key}, now())`;
  }
}

async function limpar() {
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM form_assignments WHERE form_id IN (${formVisivel}, ${formInvisivel})`;
  await sql`DELETE FROM form_versions WHERE form_id IN (${formVisivel}, ${formInvisivel})`;
  await sql`DELETE FROM forms WHERE id IN (${formVisivel}, ${formInvisivel})`;
  await sql`DELETE FROM users WHERE org_id = ${orgId}`;
  await sql`DELETE FROM projects WHERE id = ${projectId}`;
  await sql`DELETE FROM organizations WHERE id = ${orgId}`;
  await sql`SET session_replication_role = origin`;
}

suite('/health', () => {
  it('responde sem token e diz que o Postgres e o PostGIS estão de pé', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dependencias.postgres.ok).toBe(true);
    expect(body.dependencias.postgis.ok).toBe(true);
    // O estado agregado NÃO se afirma aqui. Depende do MinIO e do PowerSync,
    // e quem só mexe na autenticação não tem de os ter a correr — pela mesma
    // razão que os testes sem DATABASE_URL são saltados em vez de falharem.
    // O que se afirma é a coerência: se as dependências dizem que estão bem, o
    // estado tem de dizer o mesmo.
    const todasOk = Object.values(body.dependencias as Record<string, { ok: boolean }>).every(
      (d) => d.ok,
    );
    expect(body.status).toBe(todasOk ? 'ok' : 'degradado');
  });

  it('não revela versões nem strings de ligação', async () => {
    const corpo = (await app.inject({ method: 'GET', url: '/health' })).payload;
    expect(corpo).not.toMatch(/postgres:\/\//);
    expect(corpo).not.toMatch(/password/i);
  });

  it('verifica o armazenamento e o serviço de sincronização', async () => {
    // Sem MinIO as fotografias não sobem, e sem PowerSync os telefones não
    // sincronizam. Nenhum dos dois dá erro na API: dá erro no telefone de
    // alguém que está a 200 km daqui.
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.dependencias).toHaveProperty('armazenamento');
    expect(body.dependencias).toHaveProperty('powersync');
  });

  it('F10.9 — vigia os slots de replicação, sem os deixar derrubar a API', async () => {
    // Um slot parado impede o Postgres de reciclar o WAL, e o WAL cheio pára
    // as escritas — ou seja, a base deixa de receber registos de campo. É o
    // modo de falha mais silencioso do sistema: nada dá erro até dar tudo.
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(Array.isArray(body.replicacao.slots)).toBe(true);
    for (const slot of body.replicacao.slots) {
      expect(slot).toHaveProperty('nome');
      expect(slot).toHaveProperty('atraso_mb');
    }
    // Um slot atrasado é um aviso para alguém ver, e não uma razão para o
    // balanceador tirar de serviço a única parte que ainda funcionava.
    expect(['ok', 'degradado']).toContain(body.status);
  });

  it('o /health não fica pendurado à espera de uma dependência muda', async () => {
    // Um /health pendurado é lido pelo balanceador como «morto»: a dependência
    // em baixo derrubaria a API que ainda respondia.
    const inicio = Date.now();
    await app.inject({ method: 'GET', url: '/health' });
    expect(Date.now() - inicio).toBeLessThan(5_000);
  });
});

suite('o guarda fecha por omissão', () => {
  it('recusa /me sem cabeçalho Authorization', async () => {
    const res = await app.inject({ method: 'GET', url: '/me' });
    expect(res.statusCode).toBe(401);
  });

  it('recusa um cabeçalho que não é Bearer', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Basic YWRtaW46YWRtaW4=' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('recusa um token que não é sequer um JWT', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: 'Bearer isto-nao-e-um-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('recusa um token assinado por outra chave', async () => {
    const res = await pedirMe(await token({ chave: outraChavePrivada }));
    expect(res.statusCode).toBe(401);
  });

  it('recusa um token expirado para lá da tolerância de relógio', async () => {
    const res = await pedirMe(await token({ expiraEm: '-1h' }));
    expect(res.statusCode).toBe(401);
  });

  it('aceita um token acabado de expirar, dentro da tolerância de relógio', async () => {
    // JWT_CLOCK_TOLERANCE_S existe porque os telefones de campo desacertam, e
    // um técnico não pode ficar sem trabalhar por causa de um relógio errado.
    // O custo é este, e é deliberado: uma janela curta em que um token
    // expirado ainda passa. Se um dia esta janela deixar de ser aceitável,
    // é aqui que a decisão se muda.
    const res = await pedirMe(await token({ expiraEm: '-30s' }));
    expect(res.statusCode).toBe(200);
  });

  it('recusa um token emitido para outra audiência', async () => {
    const res = await pedirMe(await token({ audience: 'outra-aplicacao' }));
    expect(res.statusCode).toBe(401);
  });

  it('recusa um token sem org_id — sem organização não há fronteira', async () => {
    const res = await pedirMe(await token({ orgId: null }));
    expect(res.statusCode).toBe(401);
  });

  it('nunca deixa o token entrar na resposta de erro', async () => {
    const jwt = await token({ expiraEm: '-1m' });
    const res = await pedirMe(jwt);
    expect(res.payload).not.toContain(jwt);
  });
});

suite('/me com um token válido', () => {
  it('aceita e espelha o utilizador do Keycloak na base', async () => {
    const res = await pedirMe(await token());
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.subject).toBe(subjectTecnico);
    expect(body.username).toBe('tecnico.demo');
    expect(body.org.id).toBe(orgId);
    expect(body.org.provisionada).toBe(true);
    expect(body.papeis).toContain('tecnico');
    expect(body.user_id).toBeTruthy();

    const [row] = await sql`SELECT username FROM users WHERE subject = ${subjectTecnico}`;
    expect(row?.username).toBe('tecnico.demo');
  });

  it('não duplica o utilizador ao segundo pedido', async () => {
    await pedirMe(await token());
    await pedirMe(await token());
    const [contagem] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE subject = ${subjectTecnico}`;
    expect(contagem?.n).toBe(1);
  });

  it('explica-se quando a organização do token ainda não existe na base', async () => {
    const res = await pedirMe(await token({ subject: randomUUID(), orgId: randomUUID() }));
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.org.provisionada).toBe(false);
    expect(body.formularios).toEqual([]);
    expect(body.aviso).toMatch(/organização/i);
  });
});

suite('ninguém vê um formulário que não lhe foi atribuído', () => {
  it('sem atribuições, a lista de formulários vem vazia', async () => {
    const body = (await pedirMe(await token())).json();
    expect(body.formularios).toEqual([]);
    expect(body.projectos).toEqual([]);
  });

  it('com uma atribuição, vê esse formulário e só esse', async () => {
    const [utilizador] = await sql`SELECT id FROM users WHERE subject = ${subjectTecnico}`;
    await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, can_create)
              VALUES (${randomUUID()}, ${formVisivel}, 'user', ${utilizador!.id}, true, true)`;

    const body = (await pedirMe(await token())).json();
    expect(body.formularios).toHaveLength(1);
    expect(body.formularios[0].form_id).toBe(formVisivel);
    expect(body.formularios[0].pode_criar).toBe(true);
    expect(body.formularios[0].pode_apagar).toBe(false);
    expect(body.formularios.map((f: { form_id: string }) => f.form_id)).not.toContain(
      formInvisivel,
    );
  });

  it('mostra o projecto só porque lá tem um formulário atribuído', async () => {
    const body = (await pedirMe(await token())).json();
    expect(body.projectos).toHaveLength(1);
    expect(body.projectos[0].id).toBe(projectId);
  });

  it('deixa de o ver quando o formulário é arquivado', async () => {
    await sql`UPDATE forms SET archived_at = now() WHERE id = ${formVisivel}`;
    const body = (await pedirMe(await token())).json();
    expect(body.formularios).toEqual([]);
    await sql`UPDATE forms SET archived_at = NULL WHERE id = ${formVisivel}`;
  });

  it('junta permissões de várias atribuições pela mais permissiva', async () => {
    const [utilizador] = await sql`SELECT id FROM users WHERE subject = ${subjectTecnico}`;
    const equipa = randomUUID();
    await sql`INSERT INTO teams (id, org_id, key, name) VALUES (${equipa}, ${orgId}, 'campo', 'Equipa de campo')`;
    await sql`INSERT INTO team_members (team_id, user_id) VALUES (${equipa}, ${utilizador!.id})`;
    await sql`INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, can_delete)
              VALUES (${randomUUID()}, ${formVisivel}, 'team', ${equipa}, true, true)`;

    const body = (await pedirMe(await token())).json();
    expect(body.formularios).toHaveLength(1);
    expect(body.formularios[0].pode_criar).toBe(true); // da atribuição directa
    expect(body.formularios[0].pode_apagar).toBe(true); // da equipa

    await sql`DELETE FROM form_assignments WHERE principal_id = ${equipa}`;
    await sql`DELETE FROM team_members WHERE team_id = ${equipa}`;
    await sql`DELETE FROM teams WHERE id = ${equipa}`;
  });
});

function pedirMe(jwt: string) {
  return app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${jwt}` } });
}
