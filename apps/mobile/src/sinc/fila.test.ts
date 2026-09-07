import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

import type { BaseLocal } from '@/forms/definicoes';
import {
  ESQUEMA_DA_FILA,
  enfileirar,
  estadoDaFila,
  processarFila,
  proximaTentativa,
  retomarEstacionado,
  type ItemDaFila,
  type ResultadoDaSubida,
  type Transporte,
} from './fila.js';

/**
 * F5.3, F5.4 e F5.5 — a fila de subida sob rede de campo.
 *
 * O harness de rede é o próprio transporte: cada teste diz-lhe como falhar —
 * sem rede, servidor a 500, corte a meio, servidor a recusar — e o que se
 * verifica é sempre a mesma coisa: que nada se perde e que nada se duplica.
 */

const ESQUEMA = `
  CREATE TABLE records (id TEXT PRIMARY KEY, synced INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE record_revisions (id TEXT PRIMARY KEY, record_id TEXT, synced INTEGER NOT NULL DEFAULT 0);
  ${ESQUEMA_DA_FILA}
`;

function abrir(): BaseLocal & { bruto: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA);
  return {
    bruto: db,
    async runAsync(source: string, params: unknown[] = []) {
      if (params.length === 0 && source.includes('CREATE TABLE')) {
        db.exec(source);
        return {};
      }
      return db.prepare(source).run(...(params as never[]));
    },
    async getFirstAsync<T>(source: string, params: unknown[] = []) {
      return (db.prepare(source).get(...(params as never[])) as T) ?? null;
    },
    async getAllAsync<T>(source: string, params: unknown[] = []) {
      return db.prepare(source).all(...(params as never[])) as T[];
    },
  };
}

/** Transporte controlado: cada teste programa a resposta que quer. */
function transporte(
  responder: (item: ItemDaFila, tentativa: number) => ResultadoDaSubida,
): Transporte & { enviados: ItemDaFila[]; chaves: string[] } {
  const registo = {
    enviados: [] as ItemDaFila[],
    chaves: [] as string[],
    async enviar(item: ItemDaFila) {
      registo.enviados.push(item);
      registo.chaves.push(item.chave);
      return responder(item, registo.enviados.filter((e) => e.id === item.id).length);
    },
  };
  return registo;
}

const ok: ResultadoDaSubida = { ok: true };
const semRede: ResultadoDaSubida = { ok: false, permanente: false, motivo: 'sem rede' };
const recusado: ResultadoDaSubida = {
  ok: false,
  permanente: true,
  motivo: '403: o formulário deixou de lhe estar atribuído',
};

async function preparar(db: BaseLocal, recordId: string, revisionId: string): Promise<void> {
  await db.runAsync(`INSERT INTO records (id) VALUES (?)`, [recordId]);
  await db.runAsync(`INSERT INTO record_revisions (id, record_id) VALUES (?, ?)`, [
    revisionId,
    recordId,
  ]);
}

describe('F5.3 — a fila sobrevive a tudo o que o telefone faz', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('o que fica na fila está no disco, não na memória', async () => {
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: { a: 1 } });

    // Reabrir a fila é ler outra vez da base — é o que a app faz depois de ser
    // morta pelo sistema ou de o telefone reiniciar.
    const estado = await estadoDaFila(db);
    expect(estado.pendentes).toBe(1);
    expect(estado.itens[0]).toMatchObject({ record_id: 'r1', revision_id: 'v1', tentativas: 0 });
  });

  it('sobe e marca o registo e a revisão como sincronizados', async () => {
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });

    const resultado = await processarFila(
      db,
      transporte(() => ok),
    );
    expect(resultado).toMatchObject({ enviados: 1, adiados: 0, estacionados: 0 });

    const [registo] = await db.getAllAsync<{ synced: number }>(
      'SELECT synced FROM records WHERE id = ?',
      ['r1'],
    );
    const [revisao] = await db.getAllAsync<{ synced: number }>(
      'SELECT synced FROM record_revisions WHERE id = ?',
      ['v1'],
    );
    expect(registo?.synced).toBe(1);
    expect(revisao?.synced).toBe(1);
    expect((await estadoDaFila(db)).pendentes).toBe(0);
  });

  it('um registo com trabalho por subir não conta como sincronizado', async () => {
    await preparar(db, 'r1', 'v1');
    await db.runAsync(`INSERT INTO record_revisions (id, record_id) VALUES (?, ?)`, ['v2', 'r1']);
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });
    await enfileirar(db, { tipo: 'actualizar', recordId: 'r1', revisionId: 'v2', payload: {} });

    // Só o primeiro sobe: o segundo ainda não foi tentado nesta passagem.
    let primeiraVez = true;
    await processarFila(
      db,
      transporte(() => {
        if (primeiraVez) {
          primeiraVez = false;
          return ok;
        }
        return semRede;
      }),
    );

    const [registo] = await db.getAllAsync<{ synced: number }>(
      'SELECT synced FROM records WHERE id = ?',
      ['r1'],
    );
    expect(registo?.synced).toBe(0);
  });
});

describe('F5.4 — rede de campo', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('sem rede, adia com espera crescente e não perde o item', async () => {
    const agora = new Date('2026-09-05T10:00:00Z');
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {}, agora });

    const resultado = await processarFila(
      db,
      transporte(() => semRede),
      { agora },
    );
    expect(resultado).toMatchObject({ adiados: 1, enviados: 0, restaPendente: true });

    const estado = await estadoDaFila(db);
    expect(estado.pendentes).toBe(1);
    expect(estado.itens[0]?.tentativas).toBe(1);
    expect(estado.itens[0]?.ultimo_erro).toBe('sem rede');
    expect(new Date(estado.itens[0]!.proxima_tentativa).getTime()).toBeGreaterThan(agora.getTime());
  });

  it('um item adiado não é tentado antes da hora', async () => {
    const agora = new Date('2026-09-05T10:00:00Z');
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {}, agora });

    await processarFila(
      db,
      transporte(() => semRede),
      { agora },
    );

    const segunda = transporte(() => ok);
    const logoASeguir = new Date(agora.getTime() + 100);
    const resultado = await processarFila(db, segunda, { agora: logoASeguir });
    expect(segunda.enviados).toHaveLength(0);
    expect(resultado.enviados).toBe(0);
  });

  it('quando a rede volta, sobe tudo o que estava à espera', async () => {
    const agora = new Date('2026-09-05T10:00:00Z');
    await preparar(db, 'r1', 'v1');
    await preparar(db, 'r2', 'v2');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {}, agora });
    await enfileirar(db, { tipo: 'criar', recordId: 'r2', revisionId: 'v2', payload: {}, agora });

    await processarFila(
      db,
      transporte(() => semRede),
      { agora },
    );

    const maisTarde = new Date(agora.getTime() + 10 * 60_000);
    const resultado = await processarFila(
      db,
      transporte(() => ok),
      { agora: maisTarde },
    );
    expect(resultado.enviados).toBe(2);
    expect((await estadoDaFila(db)).pendentes).toBe(0);
  });

  it('a espera cresce mas tem tecto de cinco minutos', () => {
    const agora = new Date('2026-09-05T10:00:00Z');
    const espera = (n: number) => proximaTentativa(n, agora).getTime() - agora.getTime();

    expect(espera(1)).toBeGreaterThan(1500);
    expect(espera(1)).toBeLessThan(2500);
    expect(espera(3)).toBeGreaterThan(espera(1));
    // Sem tecto, à décima tentativa a espera seriam 17 minutos, e um técnico
    // que reencontra rede ficaria à espera por causa de uma fórmula.
    expect(espera(20)).toBeLessThanOrEqual(5 * 60_000 * 1.2);
  });

  it('um registo que falha não bloqueia os outros', async () => {
    await preparar(db, 'r1', 'v1');
    await preparar(db, 'r2', 'v2');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });
    await enfileirar(db, { tipo: 'criar', recordId: 'r2', revisionId: 'v2', payload: {} });

    const resultado = await processarFila(
      db,
      transporte((item) => (item.record_id === 'r1' ? semRede : ok)),
    );
    expect(resultado).toMatchObject({ enviados: 1, adiados: 1 });
  });

  it('as revisões do mesmo registo sobem por ordem, e uma falha trava as seguintes', async () => {
    await preparar(db, 'r1', 'v1');
    await db.runAsync(`INSERT INTO record_revisions (id, record_id) VALUES (?, ?)`, ['v2', 'r1']);
    await db.runAsync(`INSERT INTO record_revisions (id, record_id) VALUES (?, ?)`, ['v3', 'r1']);
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });
    await enfileirar(db, { tipo: 'actualizar', recordId: 'r1', revisionId: 'v2', payload: {} });
    await enfileirar(db, { tipo: 'actualizar', recordId: 'r1', revisionId: 'v3', payload: {} });

    // A primeira falha: sem travão, a v2 e a v3 subiriam antes da v1 e o
    // servidor via conflitos que não existem.
    const rede = transporte((item) => (item.revision_id === 'v1' ? semRede : ok));
    const resultado = await processarFila(db, rede);

    expect(rede.enviados.map((e) => e.revision_id)).toEqual(['v1']);
    expect(resultado.restaPendente).toBe(true);
  });
});

describe('F5.5 — retoma depois de um corte a meio', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('um pedido que chegou mas cuja resposta se perdeu não duplica: a chave é a mesma', async () => {
    const agora = new Date('2026-09-05T10:00:00Z');
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {}, agora });

    // Primeira tentativa: o servidor recebeu, mas a resposta perdeu-se no
    // caminho de volta — o cliente vê um erro de rede.
    const primeira = transporte(() => semRede);
    await processarFila(db, primeira, { agora });

    const segunda = transporte(() => ok);
    await processarFila(db, segunda, { agora: new Date(agora.getTime() + 10 * 60_000) });

    // A mesma chave de idempotência nas duas: o servidor reconhece o pedido e
    // devolve a resposta original em vez de criar outro registo.
    expect(primeira.chaves[0]).toBe(segunda.chaves[0]);
    expect(segunda.chaves[0]).toBe('v1');
  });

  it('a chave é a da revisão, e sobrevive a reconstruir a fila', async () => {
    await preparar(db, 'r1', 'v1');
    const primeiro = await enfileirar(db, {
      tipo: 'criar',
      recordId: 'r1',
      revisionId: 'v1',
      payload: {},
    });
    await db.runAsync(`DELETE FROM fila_de_subida WHERE id = ?`, [primeiro.id]);
    const segundo = await enfileirar(db, {
      tipo: 'criar',
      recordId: 'r1',
      revisionId: 'v1',
      payload: {},
    });
    expect(segundo.chave).toBe(primeiro.chave);
  });
});

describe('uma recusa do servidor estaciona, nunca apaga', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('estaciona com o motivo à vista', async () => {
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });

    const resultado = await processarFila(
      db,
      transporte(() => recusado),
    );
    expect(resultado.estacionados).toBe(1);

    const estado = await estadoDaFila(db);
    expect(estado.estacionados).toBe(1);
    expect(estado.itens[0]?.ultimo_erro).toContain('deixou de lhe estar atribuído');
    // Continua lá. Apagar seria a única forma de perder trabalho de campo.
    expect(estado.itens).toHaveLength(1);
  });

  it('um item estacionado não é tentado outra vez sozinho', async () => {
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });
    await processarFila(
      db,
      transporte(() => recusado),
    );

    const seguinte = transporte(() => ok);
    await processarFila(db, seguinte, { agora: new Date(Date.now() + 3600_000) });
    expect(seguinte.enviados).toHaveLength(0);
  });

  it('alguém pode devolvê-lo à fila, e aí sobe', async () => {
    await preparar(db, 'r1', 'v1');
    await enfileirar(db, { tipo: 'criar', recordId: 'r1', revisionId: 'v1', payload: {} });
    await processarFila(
      db,
      transporte(() => recusado),
    );

    const estado = await estadoDaFila(db);
    await retomarEstacionado(db, estado.itens[0]!.id);

    const resultado = await processarFila(
      db,
      transporte(() => ok),
    );
    expect(resultado.enviados).toBe(1);
    expect((await estadoDaFila(db)).itens).toHaveLength(0);
  });
});
