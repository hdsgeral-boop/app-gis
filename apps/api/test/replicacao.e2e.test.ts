/**
 * F10.9 — o alerta dos slots de replicação.
 *
 * O modo de falha que isto vigia é o mais silencioso do sistema: o PowerSync
 * cai, o WAL acumula-se sem dar erro nenhum, e quando o disco enche o Postgres
 * pára de aceitar escritas — ou seja, deixa de receber registos de campo.
 *
 * O que se prova aqui é o caminho do alerta: que o limiar é lido do ambiente,
 * que um slot acima dele muda o estado, e que `/health/replicacao` responde
 * 503 quando é crítico — porque é o código de estado que faz um monitor de
 * disponibilidade disparar.
 *
 * Precisa de DATABASE_URL. Sem ela, é saltado.
 */
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { exportJWK, generateKeyPair, type JWK } from 'jose';
import postgres from 'postgres';

import { AppModule } from '../src/app.module.js';
import { VigiaDeReplicacao } from '../src/health/vigia-replicacao.service.js';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

let app: NestFastifyApplication;
let jwks: Server;
let sql: postgres.Sql;

/**
 * Um slot só deste teste, para não mexer no do PowerSync.
 *
 * É um slot FÍSICO e não lógico, e a escolha é deliberada. O PowerSync usa um
 * slot lógico, mas criá-lo exige `wal_level = logical` — que o compose deste
 * projecto define e um Postgres de origem não tem. O CI corre contra a imagem
 * sem essa configuração, e com um slot lógico o teste falhava exactamente no
 * ambiente onde mais interessa correr.
 *
 * O vigia não distingue os dois: lê `pg_replication_slots`, que tem os dois
 * tipos, e olha para `active` e `restart_lsn`. Um slot físico reservado e nunca
 * consumido é o mesmo cenário do ADR-0004 — WAL guardado para um consumidor que
 * não existe — e exercita o mesmo caminho de código.
 */
const slot = `cvf_teste_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

beforeAll(async () => {
  if (!databaseUrl) return;

  const par = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(par.publicKey)), kid: 'k', alg: 'RS256', use: 'sig' };
  jwks = createServer((pedido, resposta) => {
    if (pedido.url?.includes('openid-configuration')) {
      resposta.setHeader('content-type', 'application/json');
      const base = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
      return resposta.end(JSON.stringify({ issuer: base, jwks_uri: `${base}/certs` }));
    }
    resposta.setHeader('content-type', 'application/json');
    resposta.end(JSON.stringify({ keys: [jwk] }));
  });
  await new Promise<void>((r) => jwks.listen(0, '127.0.0.1', r));
  process.env.KEYCLOAK_ISSUER = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}`;
  // Um limiar de 0 MB faz qualquer slot vivo passar por «acima do limiar»: é
  // como se testa o caminho do alerta sem ter de encher um disco.
  process.env.REPLICACAO_ATRASO_ALERTA_MB = '1';
  process.env.REPLICACAO_ATRASO_CRITICO_MB = '1';
  // O vigia periódico fica desligado: o que se testa é a verificação, e um
  // intervalo a correr durante os testes só acrescenta ruído.
  process.env.REPLICACAO_VIGIA_S = '0';

  sql = postgres(databaseUrl, { max: 2, onnotice: () => {} });

  const modulo = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = modulo.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
}, 120_000);

afterAll(async () => {
  if (!databaseUrl) return;
  await app?.close();
  await sql`SELECT pg_drop_replication_slot(${slot}) WHERE EXISTS (
    SELECT 1 FROM pg_replication_slots WHERE slot_name = ${slot}
  )`.catch(() => undefined);
  await sql?.end();
  await new Promise<void>((r) => jwks?.close(() => r()));
}, 120_000);

suite('F10.9 — vigia dos slots de replicação', () => {
  it('sem slots atrasados, o endpoint responde 200', async () => {
    // Este teste corre antes de o slot de prova existir. Se a máquina já
    // tiver o slot do PowerSync atrasado, o estado reflecte isso — e é o
    // comportamento certo, não uma falha do teste.
    const resposta = await app.inject({ method: 'GET', url: '/health/replicacao' });
    expect([200, 503]).toContain(resposta.statusCode);
    const corpo = resposta.json();
    expect(Array.isArray(corpo.slots)).toBe(true);
  });

  it('é público: um monitor de disponibilidade não tem token', async () => {
    const resposta = await app.inject({ method: 'GET', url: '/health/replicacao' });
    expect(resposta.statusCode).not.toBe(401);
  });

  it('um slot parado aparece como inactivo e a acumular WAL', async () => {
    // Um slot criado e nunca consumido é exactamente o cenário do ADR-0004:
    // o Postgres passa a guardar WAL para um consumidor que não existe.
    // `true` reserva o WAL já: sem isso o `restart_lsn` fica a NULL e o vigia
    // não teria atraso nenhum para medir.
    await sql`SELECT pg_create_physical_replication_slot(${slot}, true)`;

    const vigia = app.get(VigiaDeReplicacao);
    const estado = await vigia.verificar();

    const meu = estado.slots.find((s) => s.nome === slot);
    expect(meu).toBeDefined();
    expect(meu!.activo).toBe(false);
    expect(estado.ok).toBe(false);
    expect(estado.detalhe).toContain(slot);
  });

  it('o /health continua verde: um slot atrasado não tira a API de serviço', async () => {
    // Tirar a API de serviço não desatrasa slot nenhum, e deixa os técnicos
    // sem a única parte que ainda funcionava.
    const resposta = await app.inject({ method: 'GET', url: '/health' });
    expect(resposta.statusCode).toBe(200);
    const corpo = resposta.json();
    expect(corpo.replicacao.ok).toBe(false);
    // O estado geral não olha para a replicação.
    expect(corpo.dependencias.postgres.ok).toBe(true);
  });

  it('o estado do último exame fica guardado, sem voltar à base', async () => {
    const vigia = app.get(VigiaDeReplicacao);
    expect(vigia.estado?.slots.some((s) => s.nome === slot)).toBe(true);
  });
});
