/**
 * F9 — anexos, ponta a ponta, com o MinIO a sério.
 *
 * O que se prova aqui é o circuito completo: a API assina, o ficheiro sobe
 * DIRECTAMENTE para o armazenamento sem passar por ela, e a segunda vez que o
 * mesmo conteúdo aparece não gasta um byte de rede.
 *
 * Precisa de DATABASE_URL e do MinIO do compose. Sem eles, é saltado.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose';
import { uuidv7 } from '@cvforms/form-core';
import postgres from 'postgres';

import { AppModule } from '../src/app.module.js';

const databaseUrl = process.env.DATABASE_URL;
const s3Endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000';

/** O MinIO pode não estar de pé; nesse caso saltam-se os casos que o usam. */
let minioDisponivel = false;

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
const subject = randomUUID();
const KID = 'chave-de-teste';
let recordId = '';

const CONTEUDO = Buffer.from('uma fotografia de um contador, em bytes fingidos mas reais');
const HASH = createHash('sha256').update(CONTEUDO).digest('hex');

async function token(papeis: string[] = ['tecnico']): Promise<string> {
  return new SignJWT({
    preferred_username: 'tecnico.demo',
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
  metodo: 'GET' | 'POST',
  url: string,
  corpo?: unknown,
  papeis: string[] = ['tecnico'],
) {
  return app.inject({
    method: metodo,
    url,
    headers: { authorization: `Bearer ${await token(papeis)}` },
    ...(corpo === undefined ? {} : { payload: corpo as object }),
  });
}

beforeAll(async () => {
  if (!databaseUrl) return;

  try {
    const resposta = await fetch(`${s3Endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(4000),
    });
    minioDisponivel = resposta.ok;
  } catch {
    minioDisponivel = false;
  }

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
  await sql`INSERT INTO organizations (id, key, name) VALUES (${orgId}, ${'org' + orgId.slice(0, 8)}, 'Org dos anexos')`;
  await sql`INSERT INTO projects (id, org_id, key, name) VALUES (${projectId}, ${orgId}, ${'p' + projectId.slice(0, 6)}, 'Piloto')`;
  await sql`INSERT INTO forms (id, org_id, project_id, key, title, current_version)
            VALUES (${formId}, ${orgId}, ${projectId}, 'anexos', ${sql.json({ pt: 'Com anexos' })}, 1)`;
  await sql`
    INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
    VALUES (${versaoId}, ${formId}, 1,
            ${JSON.stringify({
              spec_version: 1,
              form_id: formId,
              version: 1,
              title: { pt: 'Com anexos' },
              fields: [{ id: 'f_foto', name: 'foto', type: 'photo', label: { pt: 'Foto' } }],
            })}::text::jsonb,
            'sha256:v1', now())
  `;

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  await pedir('GET', '/me');
  const [utilizador] = await sql<Array<{ id: string }>>`
    SELECT id FROM users WHERE subject = ${subject}
  `;
  await sql`
    INSERT INTO form_assignments (id, form_id, principal_type, principal_id, can_read, can_create, can_edit_own)
    VALUES (${randomUUID()}, ${formId}, 'user', ${utilizador!.id}, true, true, true)
  `;

  recordId = uuidv7();
  const criado = await pedir('POST', '/records', {
    id: recordId,
    form_id: formId,
    data: { f_foto: [] },
  });
  if (criado.statusCode !== 201) throw new Error(`não criou o registo: ${criado.body}`);
}, 180_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  await sql`SET session_replication_role = replica`;
  await sql`DELETE FROM attachments WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formId})`;
  await sql`DELETE FROM gps_fixes WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formId})`;
  await sql`DELETE FROM record_revisions WHERE record_id IN (SELECT id FROM records WHERE form_id = ${formId})`;
  await sql`DELETE FROM records WHERE form_id = ${formId}`;
  await sql`DELETE FROM audit_log WHERE org_id = ${orgId}`;
  await sql`DELETE FROM form_access WHERE org_id = ${orgId}`;
  await sql`DELETE FROM form_assignments WHERE form_id = ${formId}`;
  await sql`DELETE FROM form_versions WHERE form_id = ${formId}`;
  await sql`DELETE FROM forms WHERE id = ${formId}`;
  await sql`DELETE FROM users WHERE org_id = ${orgId}`;
  await sql`DELETE FROM projects WHERE org_id = ${orgId}`;
  await sql`DELETE FROM organizations WHERE id = ${orgId}`;
  await sql?.end();
  await new Promise<void>((resolve) => jwks?.close(() => resolve()));
}, 180_000);

suite('F9.3 — o ficheiro não passa pela API', () => {
  it('assina um URL de upload com a chave derivada do hash', async () => {
    const id = uuidv7();
    const resposta = await pedir('POST', '/attachments/presign', {
      id,
      record_id: recordId,
      field_id: 'f_foto',
      hash: HASH,
      bytes: CONTEUDO.byteLength,
      mime_type: 'image/jpeg',
    });

    expect(resposta.statusCode, resposta.body).toBe(201);
    const corpo = resposta.json();
    expect(corpo.ja_existe).toBe(false);
    expect(corpo.upload.metodo).toBe('PUT');
    // A chave vem do conteúdo, não do id do anexo: é o que torna a
    // deduplicação possível.
    expect(corpo.storage_key).toContain(HASH);
    expect(corpo.storage_key.startsWith(`${orgId}/`)).toBe(true);
    expect(corpo.upload.url).toContain('X-Amz-Signature=');
  });

  it('recusa um tipo que não está na lista', async () => {
    const resposta = await pedir('POST', '/attachments/presign', {
      id: uuidv7(),
      record_id: recordId,
      field_id: 'f_foto',
      hash: HASH,
      bytes: 10,
      mime_type: 'application/x-msdownload',
    });
    expect(resposta.statusCode).toBe(400);
  });

  it('recusa um hash que não é um SHA-256', async () => {
    const resposta = await pedir('POST', '/attachments/presign', {
      id: uuidv7(),
      record_id: recordId,
      field_id: 'f_foto',
      hash: 'não-é-um-hash',
      bytes: 10,
      mime_type: 'image/jpeg',
    });
    expect(resposta.statusCode).toBe(400);
  });

  it('o URL assinado funciona mesmo: o ficheiro sobe e volta a descer', async () => {
    if (!minioDisponivel) {
      // Sem MinIO não se prova nada; dizer que sim seria pior.
      expect(minioDisponivel).toBe(false);
      return;
    }

    const id = uuidv7();
    const presign = (
      await pedir('POST', '/attachments/presign', {
        id,
        record_id: recordId,
        field_id: 'f_foto',
        hash: HASH,
        bytes: CONTEUDO.byteLength,
        mime_type: 'image/jpeg',
      })
    ).json();

    const alvo = presign.ja_existe ? null : presign.upload;
    if (alvo) {
      const envio = await fetch(alvo.url, {
        method: 'PUT',
        headers: alvo.cabecalhos,
        body: CONTEUDO,
      });
      expect(envio.status, await envio.text()).toBe(200);
    }

    const completo = await pedir('POST', `/attachments/${id}/complete`, {
      bytes: CONTEUDO.byteLength,
    });
    expect(completo.statusCode).toBe(201);

    const url = (await pedir('GET', `/attachments/${id}/url`)).json();
    const descarregado = await fetch(url.url);
    expect(descarregado.status).toBe(200);
    expect(Buffer.from(await descarregado.arrayBuffer())).toEqual(CONTEUDO);
  });
});

suite('F9.6 — deduplicação por hash', () => {
  it('a mesma foto num segundo registo não volta a subir', async () => {
    // Primeiro anexo, concluído.
    const primeiro = uuidv7();
    await pedir('POST', '/attachments/presign', {
      id: primeiro,
      record_id: recordId,
      field_id: 'f_foto',
      hash: HASH,
      bytes: CONTEUDO.byteLength,
      mime_type: 'image/jpeg',
    });
    await pedir('POST', `/attachments/${primeiro}/complete`, {});

    // Outro registo, o mesmo ficheiro.
    const outroRegisto = uuidv7();
    await pedir('POST', '/records', {
      id: outroRegisto,
      form_id: formId,
      data: { f_foto: [] },
    });

    const segundo = uuidv7();
    const resposta = await pedir('POST', '/attachments/presign', {
      id: segundo,
      record_id: outroRegisto,
      field_id: 'f_foto',
      hash: HASH,
      bytes: CONTEUDO.byteLength,
      mime_type: 'image/jpeg',
    });

    const corpo = resposta.json();
    expect(resposta.statusCode, resposta.body).toBe(201);
    expect(corpo.ja_existe).toBe(true);
    // Nem um byte de rede: é a diferença entre subir 30 fotos e subir 3.
    expect(corpo.upload).toBeNull();

    const [linha] = await sql<Array<{ upload_state: string; storage_key: string }>>`
      SELECT upload_state, storage_key FROM attachments WHERE id = ${segundo}
    `;
    expect(linha!.upload_state).toBe('concluido');
    expect(linha!.storage_key).toContain(HASH);
  });
});

suite('F9.2 — a fila dos anexos é separada da dos registos', () => {
  it('um registo com anexos pendentes sincroniza na mesma', async () => {
    const registo = uuidv7();
    await pedir('POST', '/records', { id: registo, form_id: formId, data: { f_foto: [] } });

    const anexo = uuidv7();
    await pedir('POST', '/attachments/presign', {
      id: anexo,
      record_id: registo,
      field_id: 'f_foto',
      hash: createHash('sha256').update('outro conteúdo qualquer').digest('hex'),
      bytes: 1234,
      mime_type: 'image/jpeg',
    });

    // A revisão sobe e fica gravada mesmo com a foto por subir.
    const revisao = await pedir('POST', `/records/${registo}`, undefined);
    void revisao;
    const [linha] = await sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM record_revisions WHERE record_id = ${registo}
    `;
    expect(linha!.n).toBeGreaterThanOrEqual(1);

    const pendentes = (await pedir('GET', `/attachments/pendentes/${registo}`)).json();
    expect(pendentes.pendentes).toHaveLength(1);
    expect(pendentes.pendentes[0].upload_state).toBe('pendente');
  });

  it('um upload truncado é marcado como falhado, e não como concluído', async () => {
    const anexo = uuidv7();
    await pedir('POST', '/attachments/presign', {
      id: anexo,
      record_id: recordId,
      field_id: 'f_foto',
      hash: createHash('sha256').update('conteúdo que vai ser truncado').digest('hex'),
      bytes: 5000,
      mime_type: 'image/jpeg',
    });

    const resposta = await pedir('POST', `/attachments/${anexo}/complete`, { bytes: 120 });
    expect(resposta.statusCode).toBe(400);
    expect(resposta.json().message).toContain('truncado');

    const [linha] = await sql<Array<{ upload_state: string }>>`
      SELECT upload_state FROM attachments WHERE id = ${anexo}
    `;
    // Marcar como concluído deixaria um ficheiro partido preso a um registo,
    // e ninguém daria por isso até tentar abri-lo.
    expect(linha!.upload_state).toBe('falhado');
  });
});

suite('F10.3 — exportar anexos', () => {
  it('o manifesto liga cada ficheiro ao registo por caminho relativo', async () => {
    // O critério da fase. Sem o caminho relativo, uma pasta com três mil
    // fotografias não se liga ao CSV de maneira nenhuma.
    const resposta = await pedir('GET', `/admin/exports/${formId}/anexos`, undefined, ['admin']);
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json();

    expect(corpo.anexos.length).toBeGreaterThan(0);
    for (const anexo of corpo.anexos) {
      expect(anexo.caminho).toMatch(new RegExp(`^anexos/${anexo.record_id}/`));
      // O URL é assinado e expira: um manifesto eterno seria uma chave
      // permanente para todas as fotografias, guardada num ficheiro de texto.
      expect(anexo.url).toContain('X-Amz-Signature');
    }
    expect(new Date(corpo.expira_em).getTime()).toBeGreaterThan(Date.now());
  });

  it('o guião de descarga constrói a árvore de pastas sozinho', async () => {
    const resposta = await pedir('GET', `/admin/exports/${formId}/anexos?format=sh`, undefined, [
      'admin',
    ]);
    expect(resposta.statusCode).toBe(200);
    expect(resposta.payload).toContain('#!/bin/sh');
    expect(resposta.payload).toContain('--create-dirs');
    // Retoma o que ficou a meio: numa ligação de campo isso acontece.
    expect(resposta.payload).toContain('-C -');
  });

  it('um técnico não exporta os anexos de ninguém', async () => {
    const resposta = await pedir('GET', `/admin/exports/${formId}/anexos`);
    expect(resposta.statusCode).toBe(403);
  });
});
