import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { isUuidV7 } from '@cvforms/form-core';

import type { BaseLocal } from '@/forms/definicoes';
import {
  ESQUEMA_INDICE_DE_PROCURA,
  estadoDaVersao,
  reconstruirIndiceDeProcura,
  ESQUEMA_JUSTIFICACOES,
  abrirParaEdicao,
  apagarRegisto,
  contarRegistos,
  gravarRegisto,
  listarRegistos,
  lerRegisto,
  revisoesDe,
  submeter,
  ultimaRevisao,
} from './registos.js';

/**
 * F4.1 a F4.10 — recolha offline.
 *
 * Contra SQLite a sério, porque é SQL que se está a provar: que a revisão
 * anterior fica intacta, que a listagem aguenta 30 000 registos, e que apagar é
 * sempre um tombstone. Perder um registo de campo é o pior defeito possível
 * deste sistema, e é este ficheiro que o vigia.
 */

const ESQUEMA = `
  CREATE TABLE records (
    id TEXT PRIMARY KEY, org_id TEXT NOT NULL, project_id TEXT NOT NULL,
    form_id TEXT NOT NULL, form_version_id TEXT NOT NULL, current_revision_id TEXT,
    lat REAL, lon REAL, status TEXT NOT NULL DEFAULT 'rascunho', created_by TEXT,
    client_created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
    synced INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE record_revisions (
    id TEXT PRIMARY KEY, record_id TEXT NOT NULL, revision_no INTEGER NOT NULL,
    form_version_id TEXT NOT NULL, data TEXT NOT NULL, base_revision_id TEXT,
    device_id TEXT, client_created_at TEXT NOT NULL, synced INTEGER NOT NULL DEFAULT 0,
    UNIQUE (record_id, revision_no)
  );
  ${ESQUEMA_JUSTIFICACOES}
  ${ESQUEMA_INDICE_DE_PROCURA}
  CREATE INDEX records_form_idx ON records (form_id, updated_at DESC, id DESC);
  CREATE TABLE forms (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL,
    current_version INTEGER, can_create INTEGER NOT NULL DEFAULT 0,
    can_edit_own INTEGER NOT NULL DEFAULT 0, can_edit_all INTEGER NOT NULL DEFAULT 0,
    archived_at TEXT
  );
  CREATE TABLE form_versions (
    id TEXT PRIMARY KEY, form_id TEXT NOT NULL, version INTEGER NOT NULL,
    definition TEXT NOT NULL, hash TEXT NOT NULL, published_at TEXT,
    UNIQUE (form_id, version)
  );
`;

function abrir(): BaseLocal & { fechar(): void; bruto: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA);
  return {
    bruto: db,
    async runAsync(source: string, params: unknown[] = []) {
      return db.prepare(source).run(...(params as never[]));
    },
    async getFirstAsync<T>(source: string, params: unknown[] = []) {
      return (db.prepare(source).get(...(params as never[])) as T) ?? null;
    },
    async getAllAsync<T>(source: string, params: unknown[] = []) {
      return db.prepare(source).all(...(params as never[])) as T[];
    },
    fechar: () => db.close(),
  };
}

const BASE = {
  orgId: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d00',
  projectId: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d01',
  formId: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40',
  formVersionId: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d99',
};

describe('índice de procura', () => {
  it('acompanha as revisões: procurar encontra o valor novo e não o antigo', async () => {
    const db = abrir();
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'LC000123' },
      camposDeProcura: ['f_cod'],
    });
    expect(await listarRegistos(db, { procura: 'LC000123' })).toHaveLength(1);

    await gravarRegisto(db, {
      ...BASE,
      recordId,
      dados: { f_cod: 'LC999999' },
      camposDeProcura: ['f_cod'],
    });
    expect(await listarRegistos(db, { procura: 'LC000123' })).toHaveLength(0);
    expect(await listarRegistos(db, { procura: 'LC999999' })).toHaveLength(1);
  });

  it('a procura não distingue maiúsculas de minúsculas', async () => {
    const db = abrir();
    await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'LC000123' },
      camposDeProcura: ['f_cod'],
    });
    expect(await listarRegistos(db, { procura: 'lc0001' })).toHaveLength(1);
  });
});

describe('F4.1 e F4.2 — criar registo e gravar revisão', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('o id é UUIDv7 gerado no telefone', async () => {
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: { f_cod: 'LC000123' } });
    expect(isUuidV7(recordId)).toBe(true);
  });

  it('a primeira revisão não tem base, e o registo aponta para ela', async () => {
    const { recordId, revisionId } = await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'LC000123' },
    });
    const revisao = await ultimaRevisao(db, recordId);
    expect(revisao).toMatchObject({ revision_no: 1, base_revision_id: null, id: revisionId });
    expect((await lerRegisto(db, recordId))?.current_revision_id).toBe(revisionId);
  });

  it('o cliente escreve sempre rascunho', async () => {
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });
    expect((await lerRegisto(db, recordId))?.status).toBe('rascunho');
  });

  it('nasce por sincronizar, e é isso que a lista mostra ao técnico', async () => {
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });
    expect((await lerRegisto(db, recordId))?.synced).toBe(false);
  });

  it('a geometria do registo vem do campo indicado em settings', async () => {
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      dados: {},
      geometria: { lat: -8.8383, lon: 13.2344 },
    });
    const registo = await lerRegisto(db, recordId);
    expect(registo?.lat).toBeCloseTo(-8.8383, 6);
    expect(registo?.lon).toBeCloseTo(13.2344, 6);
  });
});

describe('F4.5 e F4.10 — editar', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('editar cria uma revisão nova e deixa a anterior intacta', async () => {
    const primeira = await gravarRegisto(db, { ...BASE, dados: { f_cod: 'LC000123' } });
    const segunda = await gravarRegisto(db, {
      ...BASE,
      recordId: primeira.recordId,
      dados: { f_cod: 'LC000123', f_n: 12 },
    });

    expect(segunda.revisionNo).toBe(2);
    const historico = await revisoesDe(db, primeira.recordId);
    expect(historico).toHaveLength(2);
    // A revisão 1 continua exactamente como foi gravada.
    expect(historico[0]?.dados).toEqual({ f_cod: 'LC000123' });
    expect(historico[1]?.dados).toEqual({ f_cod: 'LC000123', f_n: 12 });
    expect(historico[1]?.base_revision_id).toBe(primeira.revisionId);
  });

  it('duas edições offline encadeiam-se, sem perder nenhuma', async () => {
    const a = await gravarRegisto(db, { ...BASE, dados: { v: 1 } });
    const b = await gravarRegisto(db, { ...BASE, recordId: a.recordId, dados: { v: 2 } });
    const c = await gravarRegisto(db, { ...BASE, recordId: a.recordId, dados: { v: 3 } });

    const historico = await revisoesDe(db, a.recordId);
    expect(historico.map((r) => r.dados['v'])).toEqual([1, 2, 3]);
    expect(historico.map((r) => r.base_revision_id)).toEqual([null, a.revisionId, b.revisionId]);
    expect(c.revisionNo).toBe(3);
  });

  it('reabrir devolve exactamente o que estava escrito', async () => {
    const dados = {
      f_cod: 'LC000123',
      g_cont: [{ f_ns: 'A-1', g_leit: [{ f_v: 10.5 }] }],
    };
    const { recordId } = await gravarRegisto(db, { ...BASE, dados });
    const aberto = await abrirParaEdicao(db, recordId);
    expect(aberto?.revisao.dados).toEqual(dados);
  });

  it('reabrir usa a versão de formulário com que o registo foi criado', async () => {
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      formVersionId: 'versao-3',
      dados: {},
    });
    // Entretanto sai a v4 e o formulário passa a apontar para ela; o registo
    // continua a abrir com a v3.
    const aberto = await abrirParaEdicao(db, recordId);
    expect(aberto?.registo.form_version_id).toBe('versao-3');
    expect(aberto?.revisao.form_version_id).toBe('versao-3');
  });
});

describe('F4.6 — estados', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('submeter é um acto explícito e só se aplica a rascunhos', async () => {
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });
    await submeter(db, recordId);
    expect((await lerRegisto(db, recordId))?.status).toBe('submetido');

    // Submeter outra vez não muda nada nem rebenta.
    await submeter(db, recordId);
    expect((await lerRegisto(db, recordId))?.status).toBe('submetido');
  });

  it('uma revisão nova num registo submetido não o devolve a rascunho', async () => {
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: { v: 1 } });
    await submeter(db, recordId);
    await gravarRegisto(db, { ...BASE, recordId, dados: { v: 2 } });
    expect((await lerRegisto(db, recordId))?.status).toBe('submetido');
  });
});

describe('F4.8 — relógio do dispositivo errado', () => {
  it('o relógio do telefone é gravado mas não decide a ordem', async () => {
    const db = abrir();

    // Um telefone de campo com o relógio a anos de distância é comum: perde a
    // bateria, perde a hora, e ninguém a acerta antes de ir trabalhar.
    const antigo = await gravarRegisto(db, { ...BASE, dados: { v: 'primeiro' } });
    await db.runAsync(`UPDATE records SET client_created_at = ? WHERE id = ?`, [
      '2001-01-01T00:00:00.000Z',
      antigo.recordId,
    ]);
    await db.runAsync(`UPDATE record_revisions SET client_created_at = ? WHERE record_id = ?`, [
      '2001-01-01T00:00:00.000Z',
      antigo.recordId,
    ]);

    const recente = await gravarRegisto(db, { ...BASE, dados: { v: 'segundo' } });

    // O que o telefone diz fica gravado, tal e qual, para se poder auditar.
    expect((await lerRegisto(db, antigo.recordId))?.client_created_at).toBe(
      '2001-01-01T00:00:00.000Z',
    );

    // Mas a ordem da listagem não vem daí: vem de `updated_at`, que é escrito
    // a cada gravação, e no servidor será `server_received_at` (§13.8).
    const lista = await listarRegistos(db, { formId: BASE.formId, limite: 10 });
    expect(lista.map((l) => l.id)).toEqual([recente.recordId, antigo.recordId]);
  });

  it('o histórico de revisões ordena por número, não por relógio', async () => {
    const db = abrir();
    const primeira = await gravarRegisto(db, { ...BASE, dados: { v: 1 } });
    await gravarRegisto(db, { ...BASE, recordId: primeira.recordId, dados: { v: 2 } });
    await db.runAsync(
      `UPDATE record_revisions SET client_created_at = ? WHERE record_id = ? AND revision_no = 2`,
      ['1999-01-01T00:00:00.000Z', primeira.recordId],
    );

    const historico = await revisoesDe(db, primeira.recordId);
    expect(historico.map((r) => r.revision_no)).toEqual([1, 2]);
    expect(historico.map((r) => r.dados['v'])).toEqual([1, 2]);
  });
});

describe('restrição inegociável 4 — nunca se apaga', () => {
  it('apagar é um tombstone, e as revisões ficam todas', async () => {
    const db = abrir();
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: { v: 1 } });
    await gravarRegisto(db, { ...BASE, recordId, dados: { v: 2 } });

    await apagarRegisto(db, recordId);

    const registo = await lerRegisto(db, recordId);
    expect(registo?.deleted_at).not.toBeNull();
    expect(await revisoesDe(db, recordId)).toHaveLength(2);
    // Some da listagem, mas continua na base.
    expect(await listarRegistos(db)).toHaveLength(0);
    expect(await contarRegistos(db)).toBe(0);
  });
});

describe('F4.3 e F4.4 — listagem e procura com muitos registos', () => {
  let db: ReturnType<typeof abrir>;
  const TOTAL = 30_000;

  beforeEach(async () => {
    db = abrir();
    // Inserir 30 000 registos pela API normal seria lento de mais para um teste
    // que corre a cada commit; o que interessa provar é a LEITURA com esse
    // volume, por isso a escrita vai directa e em lote.
    const agora = new Date().toISOString();
    db.bruto.exec('BEGIN');
    const registo = db.bruto.prepare(
      `INSERT INTO records (id, org_id, project_id, form_id, form_version_id, current_revision_id,
         status, client_created_at, updated_at, synced) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const revisao = db.bruto.prepare(
      `INSERT INTO record_revisions (id, record_id, revision_no, form_version_id, data, client_created_at, synced)
       VALUES (?,?,?,?,?,?,?)`,
    );
    const indice = db.bruto.prepare(
      `INSERT INTO indice_de_procura (record_id, field_id, valor) VALUES (?,?,?)`,
    );
    for (let i = 0; i < TOTAL; i++) {
      const rid = `r${String(i).padStart(6, '0')}`;
      const vid = `v${String(i).padStart(6, '0')}`;
      registo.run(
        rid,
        BASE.orgId,
        BASE.projectId,
        BASE.formId,
        BASE.formVersionId,
        vid,
        i % 3 === 0 ? 'submetido' : 'rascunho',
        agora,
        agora,
        0,
      );
      revisao.run(
        vid,
        rid,
        1,
        BASE.formVersionId,
        JSON.stringify({ f_cod: `LC${String(i).padStart(6, '0')}`, f_n: i }),
        agora,
        0,
      );
      indice.run(rid, 'f_cod', `lc${String(i).padStart(6, '0')}`);
    }
    db.bruto.exec('COMMIT');
  });

  it('lista uma página sem carregar os 30 000 para a memória', async () => {
    const inicio = performance.now();
    const pagina = await listarRegistos(db, { formId: BASE.formId, limite: 50 });
    const duracao = performance.now() - inicio;

    expect(pagina).toHaveLength(50);
    expect(await contarRegistos(db, BASE.formId)).toBe(TOTAL);
    expect(duracao).toBeLessThan(200);
  });

  it('a ordenação é servida pelo índice, e não por uma ordenação em memória', async () => {
    // O desempate pelo `id` faz parte da ordenação e por isso tem de fazer
    // parte do índice. Sem ele o SQLite filtra pelo índice mas ordena as
    // 30 000 linhas à parte, e o teste de duração acima começa a falhar por
    // vezes — que é a pior forma de dar por isso.
    const plano = await db.getAllAsync<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT r.id FROM records r JOIN record_revisions v ON v.id = r.current_revision_id
       WHERE r.deleted_at IS NULL AND r.form_id = ?
       ORDER BY r.updated_at DESC, r.id DESC LIMIT 50`,
      [BASE.formId],
    );
    const texto = plano.map((l) => l.detail).join(' | ');
    expect(texto).toContain('records_form_idx');
    expect(texto).not.toContain('USE TEMP B-TREE FOR ORDER BY');
  });

  it('a procura pelos campos pesquisáveis responde abaixo de 200 ms', async () => {
    const inicio = performance.now();
    const encontrados = await listarRegistos(db, {
      formId: BASE.formId,
      procura: 'LC029999',
      camposDeProcura: ['f_cod'],
      limite: 20,
    });
    const duracao = performance.now() - inicio;

    expect(encontrados).toHaveLength(1);
    expect(encontrados[0]?.dados['f_cod']).toBe('LC029999');
    // O critério da F4.4 é 200 ms com 30 000 registos, num telefone. Aqui
    // mede-se num portátil, e o limite fica em 200 ms na mesma: é a forma de
    // dar por uma regressão como a que já aconteceu — um `EXISTS`
    // correlacionado punha isto nos 150 ms mesmo com o índice construído.
    expect(duracao).toBeLessThan(200);
  });

  it('a procura filtra primeiro pelo índice, e não varre os registos', async () => {
    // O plano da consulta é parte do contrato desta função: se voltar a
    // aparecer aqui uma sondagem por registo, o tempo sobe uma ordem de
    // grandeza e o teste de duração acima começa a falhar por vezes, que é a
    // pior forma de dar por isso.
    const plano = await db.getAllAsync<{ detail: string }>(
      `EXPLAIN QUERY PLAN
       SELECT r.id FROM records r JOIN record_revisions v ON v.id = r.current_revision_id
       WHERE r.deleted_at IS NULL AND r.form_id = ?
         AND r.id IN (SELECT record_id FROM indice_de_procura WHERE valor LIKE ?)
       ORDER BY r.updated_at DESC LIMIT 20`,
      [BASE.formId, '%lc%'],
    );
    const texto = plano.map((l) => l.detail).join(' | ');
    expect(texto).toContain('SCAN indice_de_procura');
    expect(texto).not.toContain('CORRELATED');
  });

  it('filtra por estado', async () => {
    const submetidos = await listarRegistos(db, { status: 'submetido', limite: 10 });
    expect(submetidos.every((r) => r.status === 'submetido')).toBe(true);
  });

  it('pagina sem repetir nem saltar registos', async () => {
    const primeira = await listarRegistos(db, { limite: 20, deslocamento: 0 });
    const segunda = await listarRegistos(db, { limite: 20, deslocamento: 20 });
    const ids = new Set([...primeira, ...segunda].map((r) => r.id));
    expect(ids.size).toBe(40);
  });
});

describe('justificação de precisão', () => {
  it('fica ligada à revisão em que foi escrita, não ao registo', async () => {
    const db = abrir();
    const primeira = await gravarRegisto(db, {
      ...BASE,
      dados: {},
      justificacaoDePrecisao: 'Sem céu aberto: recolhido junto ao muro do PT.',
    });
    await gravarRegisto(db, { ...BASE, recordId: primeira.recordId, dados: { v: 2 } });

    const linhas = await db.getAllAsync<{ revision_id: string; motivo: string }>(
      'SELECT revision_id, motivo FROM justificacoes_de_precisao WHERE record_id = ?',
      [primeira.recordId],
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]?.revision_id).toBe(primeira.revisionId);
  });
});

describe('reconstrução do índice de procura', () => {
  /**
   * O índice só é escrito quando um registo é gravado. Basta uma versão nova
   * marcar mais um campo como `searchable` para os registos antigos ficarem de
   * fora da procura — e um técnico que procura um código que existe e não
   * aparece conclui que perdeu o registo, não que o índice está velho.
   */
  it('põe no índice campos que não eram pesquisáveis quando o registo foi gravado', async () => {
    const db = abrir();
    await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'LC000123', f_nome: 'Bairro Azul' },
      camposDeProcura: ['f_cod'],
    });
    expect(await listarRegistos(db, { procura: 'Bairro' })).toHaveLength(0);

    const resultado = await reconstruirIndiceDeProcura(db, () => ['f_cod', 'f_nome']);

    expect(resultado.registos).toBe(1);
    expect(resultado.entradas).toBe(2);
    expect(await listarRegistos(db, { procura: 'Bairro' })).toHaveLength(1);
    expect(await listarRegistos(db, { procura: 'LC000123' })).toHaveLength(1);
  });

  it('indexa a revisão corrente e não a primeira', async () => {
    const db = abrir();
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'ANTIGO' },
      camposDeProcura: ['f_cod'],
    });
    await gravarRegisto(db, { ...BASE, recordId, dados: { f_cod: 'NOVO' }, camposDeProcura: [] });

    await reconstruirIndiceDeProcura(db, () => ['f_cod']);

    expect(await listarRegistos(db, { procura: 'ANTIGO' })).toHaveLength(0);
    expect(await listarRegistos(db, { procura: 'NOVO' })).toHaveLength(1);
  });

  it('não indexa registos apagados', async () => {
    const db = abrir();
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'LC000123' },
      camposDeProcura: ['f_cod'],
    });
    await apagarRegisto(db, recordId);

    const resultado = await reconstruirIndiceDeProcura(db, () => ['f_cod']);
    expect(resultado.registos).toBe(0);
  });

  it('uma revisão ilegível não pára a reconstrução das outras', async () => {
    // Perder o índice de um registo é mau; perder o de todos é pior.
    const db = abrir();
    await gravarRegisto(db, { ...BASE, dados: { f_cod: 'BOM' }, camposDeProcura: ['f_cod'] });
    const { recordId } = await gravarRegisto(db, {
      ...BASE,
      dados: { f_cod: 'MAU' },
      camposDeProcura: ['f_cod'],
    });
    db.bruto
      .prepare(`UPDATE record_revisions SET data = '{isto não é json' WHERE record_id = ?`)
      .run(recordId);

    const resultado = await reconstruirIndiceDeProcura(db, () => ['f_cod']);
    expect(resultado.entradas).toBe(1);
    expect(await listarRegistos(db, { procura: 'BOM' })).toHaveLength(1);
  });

  it('resolve os campos uma vez por versão, e não uma vez por registo', async () => {
    // Com 30 000 registos e meia dúzia de versões, a diferença é entre
    // reconstruir o índice e a app parecer bloqueada.
    const db = abrir();
    for (let i = 0; i < 5; i++) {
      await gravarRegisto(db, { ...BASE, dados: { f_cod: `LC${i}` }, camposDeProcura: [] });
    }
    let chamadas = 0;
    await reconstruirIndiceDeProcura(db, () => {
      chamadas++;
      return ['f_cod'];
    });
    expect(chamadas).toBe(1);
  });
});

describe('F5.9 — versão de formulário desactualizada', () => {
  function comFormulario(
    db: ReturnType<typeof abrir>,
    versaoCorrente: number,
    versaoDoRegisto = 1,
  ) {
    db.bruto
      .prepare(`INSERT INTO forms (id, project_id, key, title, current_version) VALUES (?,?,?,?,?)`)
      .run(BASE.formId, BASE.projectId, 'f', '{}', versaoCorrente);
    db.bruto
      .prepare(
        `INSERT INTO form_versions (id, form_id, version, definition, hash) VALUES (?,?,?,?,?)`,
      )
      .run(BASE.formVersionId, BASE.formId, versaoDoRegisto, '{}', 'sha256:x');
  }

  it('avisa quando saiu uma versão nova depois do registo', async () => {
    const db = abrir();
    comFormulario(db, 3, 1);
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });

    const estado = await estadoDaVersao(db, recordId);
    expect(estado?.doRegisto).toBe(1);
    expect(estado?.corrente).toBe(3);
    expect(estado?.desactualizado).toBe(true);
    expect(estado?.aviso).toContain('versão 1');
  });

  it('não avisa quando o registo está na versão corrente', async () => {
    const db = abrir();
    comFormulario(db, 1, 1);
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });

    const estado = await estadoDaVersao(db, recordId);
    expect(estado?.desactualizado).toBe(false);
    expect(estado?.aviso).toBeUndefined();
  });

  it('sem a definição original, diz para sincronizar antes de abrir', async () => {
    // Abrir com outra versão mudaria o significado de respostas que ninguém
    // voltou a dar. É a regra da §10, e é por isso que o telefone guarda todas
    // as versões em vez de só a corrente.
    const db = abrir();
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: {} });

    const estado = await estadoDaVersao(db, recordId);
    expect(estado?.originalDisponivel).toBe(false);
    expect(estado?.aviso).toContain('Sincroniza');
  });

  it('abrir para edição traz o estado da versão junto', async () => {
    const db = abrir();
    comFormulario(db, 2, 1);
    const { recordId } = await gravarRegisto(db, { ...BASE, dados: { f_cod: 'x' } });

    const aberto = await abrirParaEdicao(db, recordId);
    expect(aberto?.versao.desactualizado).toBe(true);
    // A revisão continua a ser a original: avisar não é converter.
    expect(aberto?.revisao.form_version_id).toBe(BASE.formVersionId);
  });
});
