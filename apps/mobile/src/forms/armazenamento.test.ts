import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { FormDefinition } from '@cvforms/form-core';

import {
  guardarDefinicao,
  lerDefinicao,
  lerDefinicaoCorrente,
  listarFormulariosLocais,
  sincronizarDefinicoes,
  type BaseLocal,
  type ClienteDeFormularios,
  type FormularioRemoto,
} from './definicoes.js';
import {
  GravadorDeRascunho,
  abrirRascunho,
  apagarRascunho,
  gravarRascunho,
  lerRascunho,
  listarRascunhos,
  prepararRascunhos,
} from './rascunhos.js';

/**
 * F3.1 e F3.9 — definições em cache e rascunhos.
 *
 * Corre contra SQLite a sério (`node:sqlite`), e não contra um duplo: o que se
 * está a provar é SQL — `ON CONFLICT`, chaves únicas, o que fica gravado
 * depois de a app morrer. Um duplo em memória confirmaria só que o código
 * chama as funções que o autor julgava.
 */

/** O esquema da app, na parte que estes módulos usam. */
const ESQUEMA = `
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

/** Adaptador do `node:sqlite` para a interface que a app usa do expo-sqlite. */
function abrir(): BaseLocal & { fechar(): void } {
  const db = new DatabaseSync(':memory:');
  db.exec(ESQUEMA);
  return {
    async runAsync(source: string, params: unknown[] = []) {
      if (params.length === 0 && /;\s*$/.test(source.trim()) && source.includes('CREATE')) {
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
    fechar: () => db.close(),
  };
}

function definicao(formId: string, versao: number): FormDefinition {
  return {
    spec_version: 1,
    form_id: formId,
    version: versao,
    title: { pt: 'Local de Consumo' },
    published_at: '2026-09-05T10:00:00Z',
    fields: [{ id: 'f_cod', name: 'codigo', type: 'text', label: { pt: 'Código' } }],
  } as FormDefinition;
}

const FORM = '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40';

function remoto(versao: number, hash: string): FormularioRemoto {
  return {
    form_id: FORM,
    key: 'local_consumo',
    titulo: { pt: 'Local de Consumo' },
    projecto_id: '0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d00',
    versao,
    hash,
    permissoes: { criar: true, editar_proprios: true, editar_todos: false, apagar: false },
  };
}

/** Cliente que conta os descarregamentos, para se ver o que foi poupado. */
function clienteFalso(
  formularios: FormularioRemoto[],
  falha?: string,
): ClienteDeFormularios & {
  descarregamentos: number;
} {
  const cliente = {
    descarregamentos: 0,
    async listar() {
      return formularios;
    },
    async definicao(formId: string, versao: number) {
      cliente.descarregamentos++;
      if (falha) throw new Error(falha);
      return { hash: `sha256:v${versao}`, definicao: definicao(formId, versao) };
    },
  };
  return cliente;
}

describe('F3.1 — definições em cache', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(() => {
    db = abrir();
  });

  it('descarrega e guarda a definição', async () => {
    const cliente = clienteFalso([remoto(1, 'sha256:v1')]);
    const resultado = await sincronizarDefinicoes(db, cliente);

    expect(resultado.descarregadas).toBe(1);
    expect(await lerDefinicao(db, FORM, 1)).toMatchObject({ version: 1 });
    const formularios = await listarFormulariosLocais(db);
    expect(formularios[0]).toMatchObject({ key: 'local_consumo', pode_criar: true, versao: 1 });
  });

  it('não volta a descarregar se o hash não mudou', async () => {
    const cliente = clienteFalso([remoto(1, 'sha256:v1')]);
    await sincronizarDefinicoes(db, cliente);
    const segunda = await sincronizarDefinicoes(db, cliente);

    expect(cliente.descarregamentos).toBe(1);
    expect(segunda.descarregadas).toBe(0);
    expect(segunda.jaActualizadas).toBe(1);
  });

  it('descarrega quando sai uma versão nova, e guarda as duas', async () => {
    await sincronizarDefinicoes(db, clienteFalso([remoto(1, 'sha256:v1')]));
    await sincronizarDefinicoes(db, clienteFalso([remoto(2, 'sha256:v2')]));

    // A v1 continua lá: um registo criado com ela tem de continuar a abrir.
    expect(await lerDefinicao(db, FORM, 1)).toMatchObject({ version: 1 });
    expect(await lerDefinicao(db, FORM, 2)).toMatchObject({ version: 2 });
    expect(await lerDefinicaoCorrente(db, FORM)).toMatchObject({ version: 2 });
  });

  it('uma definição que falha não impede as outras', async () => {
    const bom = remoto(1, 'sha256:v1');
    const mau = { ...remoto(1, 'sha256:vX'), form_id: 'outro-formulario' };
    const cliente: ClienteDeFormularios = {
      async listar() {
        return [bom, mau];
      },
      async definicao(formId, versao) {
        if (formId === 'outro-formulario') throw new Error('500 do servidor');
        return { hash: 'sha256:v1', definicao: definicao(formId, versao) };
      },
    };

    const resultado = await sincronizarDefinicoes(db, cliente);
    expect(resultado.descarregadas).toBe(1);
    expect(resultado.falhadas).toEqual([
      { form_id: 'outro-formulario', versao: 1, motivo: '500 do servidor' },
    ]);
    expect(await lerDefinicao(db, FORM, 1)).toBeDefined();
  });

  it('um formulário que deixou de estar atribuído é arquivado, nunca apagado', async () => {
    await sincronizarDefinicoes(db, clienteFalso([remoto(1, 'sha256:v1')]));
    await sincronizarDefinicoes(db, clienteFalso([]));

    const formularios = await listarFormulariosLocais(db);
    expect(formularios).toHaveLength(1);
    expect(formularios[0]?.arquivado).toBe(true);
    // A definição fica: os registos já recolhidos com ela ainda têm de subir.
    expect(await lerDefinicao(db, FORM, 1)).toBeDefined();
  });

  it('guardar a mesma versão duas vezes actualiza em vez de rebentar', async () => {
    await guardarDefinicao(db, FORM, 1, 'sha256:a', definicao(FORM, 1));
    await guardarDefinicao(db, FORM, 1, 'sha256:b', definicao(FORM, 1));
    const linha = await db.getFirstAsync<{ hash: string }>(
      'SELECT hash FROM form_versions WHERE form_id = ? AND version = ?',
      [FORM, 1],
    );
    expect(linha?.hash).toBe('sha256:b');
  });
});

describe('F3.9 — rascunhos', () => {
  let db: ReturnType<typeof abrir>;
  beforeEach(async () => {
    db = abrir();
    await prepararRascunhos(db);
  });

  it('abrir gera um UUIDv7 no telefone e não o muda mais', async () => {
    const rascunho = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
    });
    expect(rascunho.record_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);

    const outra = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
      recordId: rascunho.record_id,
    });
    expect(outra.record_id).toBe(rascunho.record_id);
  });

  it('matar a app a meio não perde o que estava escrito', async () => {
    const rascunho = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
    });
    await gravarRascunho(db, rascunho.record_id, { f_cod: 'LC000123', f_n: 12 }, 2);

    // Reabrir é ler outra vez da base — é exactamente o que a app faz depois
    // de ser morta pelo sistema.
    const relido = await lerRascunho(db, rascunho.record_id);
    expect(relido?.dados).toEqual({ f_cod: 'LC000123', f_n: 12 });
    expect(relido?.seccao_actual).toBe(2);
  });

  it('grava repetíveis aninhados sem perder estrutura', async () => {
    const rascunho = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
    });
    const dados = {
      g_cont: [
        { f_ns: 'A-1', g_leit: [{ f_v: 10.5 }, { f_v: 20 }] },
        { f_ns: 'A-2', g_leit: [] },
      ],
    };
    await gravarRascunho(db, rascunho.record_id, dados);
    expect((await lerRascunho(db, rascunho.record_id))?.dados).toEqual(dados);
  });

  it('o gravador com atraso escreve uma vez só, e o gravarJa não deixa nada por gravar', async () => {
    const rascunho = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
    });
    const gravador = new GravadorDeRascunho(db, rascunho.record_id, 5);

    gravador.agendar({ f_cod: 'A' });
    gravador.agendar({ f_cod: 'AB' });
    gravador.agendar({ f_cod: 'ABC' });
    await gravador.gravarJa();

    expect((await lerRascunho(db, rascunho.record_id))?.dados).toEqual({ f_cod: 'ABC' });
  });

  it('lista e apaga', async () => {
    const a = await abrirRascunho(db, { formId: FORM, formVersionId: 'v1', formVersion: 1 });
    const b = await abrirRascunho(db, { formId: FORM, formVersionId: 'v1', formVersion: 1 });
    expect(await listarRascunhos(db, FORM)).toHaveLength(2);

    await apagarRascunho(db, a.record_id);
    const restantes = await listarRascunhos(db, FORM);
    expect(restantes).toHaveLength(1);
    expect(restantes[0]?.record_id).toBe(b.record_id);
  });

  it('guarda a revisão de base, para uma edição saber sobre o que foi construída', async () => {
    const rascunho = await abrirRascunho(db, {
      formId: FORM,
      formVersionId: 'v1',
      formVersion: 1,
      baseRevisionId: 'revisao-anterior',
      dados: { f_cod: 'LC000001' },
    });
    expect(rascunho.base_revision_id).toBe('revisao-anterior');
    expect((await lerRascunho(db, rascunho.record_id))?.dados).toEqual({ f_cod: 'LC000001' });
  });
});
