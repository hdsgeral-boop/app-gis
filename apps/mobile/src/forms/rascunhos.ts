import { uuidv7, type RecordData } from '@cvforms/form-core';

import type { BaseLocal } from './definicoes.js';

/**
 * Rascunhos gravados a cada alteração (F3.9).
 *
 * Restrição inegociável 2: escreve-se sempre primeiro no SQLite local, e
 * nenhuma gravação faz uma chamada HTTP. Matar a app a meio de um formulário
 * não pode perder nada — é o pior defeito possível deste sistema.
 *
 * Porquê uma tabela própria e não uma revisão: uma revisão é um facto — foi
 * gravada, é imutável e vai subir. Um rascunho é trabalho a meio, que muda a
 * cada tecla. Misturá-los encheria a tabela append-only de estados
 * intermédios que ninguém quer sincronizar.
 */

export const ESQUEMA_RASCUNHOS = `
  CREATE TABLE IF NOT EXISTS rascunhos (
    record_id        TEXT PRIMARY KEY,
    form_id          TEXT NOT NULL,
    form_version_id  TEXT NOT NULL,
    /* Versão do formulário com que este rascunho está a ser preenchido. */
    form_version     INTEGER NOT NULL,
    data             TEXT NOT NULL,
    /* Revisão em que este rascunho se baseia. NULL se for um registo novo. */
    base_revision_id TEXT,
    seccao_actual    INTEGER NOT NULL DEFAULT 0,
    criado_em        TEXT NOT NULL,
    actualizado_em   TEXT NOT NULL
  );
`;

export interface Rascunho {
  record_id: string;
  form_id: string;
  form_version_id: string;
  form_version: number;
  dados: RecordData;
  base_revision_id: string | null;
  seccao_actual: number;
  actualizado_em: string;
}

export async function prepararRascunhos(db: BaseLocal): Promise<void> {
  await db.runAsync(ESQUEMA_RASCUNHOS, []);
}

export interface NovoRascunho {
  formId: string;
  formVersionId: string;
  formVersion: number;
  /** `undefined` cria um registo novo com um UUIDv7 gerado aqui. */
  recordId?: string;
  baseRevisionId?: string | null;
  dados?: RecordData;
}

/**
 * Abre um rascunho. O `id` do registo é gerado no telefone (restrição
 * inegociável 3) e não muda nunca — nem quando sincroniza.
 */
export async function abrirRascunho(db: BaseLocal, novo: NovoRascunho): Promise<Rascunho> {
  const recordId = novo.recordId ?? uuidv7();
  const existente = await lerRascunho(db, recordId);
  if (existente) return existente;

  const agora = new Date().toISOString();
  const rascunho: Rascunho = {
    record_id: recordId,
    form_id: novo.formId,
    form_version_id: novo.formVersionId,
    form_version: novo.formVersion,
    dados: novo.dados ?? {},
    base_revision_id: novo.baseRevisionId ?? null,
    seccao_actual: 0,
    actualizado_em: agora,
  };

  await db.runAsync(
    `INSERT INTO rascunhos
       (record_id, form_id, form_version_id, form_version, data, base_revision_id, seccao_actual, criado_em, actualizado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rascunho.record_id,
      rascunho.form_id,
      rascunho.form_version_id,
      rascunho.form_version,
      JSON.stringify(rascunho.dados),
      rascunho.base_revision_id,
      0,
      agora,
      agora,
    ],
  );
  return rascunho;
}

/** Grava o estado do rascunho. Chamado a cada alteração. */
export async function gravarRascunho(
  db: BaseLocal,
  recordId: string,
  dados: RecordData,
  seccaoActual = 0,
): Promise<void> {
  await db.runAsync(
    `UPDATE rascunhos SET data = ?, seccao_actual = ?, actualizado_em = ? WHERE record_id = ?`,
    [JSON.stringify(dados), seccaoActual, new Date().toISOString(), recordId],
  );
}

export async function lerRascunho(db: BaseLocal, recordId: string): Promise<Rascunho | undefined> {
  const linha = await db.getFirstAsync<{
    record_id: string;
    form_id: string;
    form_version_id: string;
    form_version: number;
    data: string;
    base_revision_id: string | null;
    seccao_actual: number;
    actualizado_em: string;
  }>(`SELECT * FROM rascunhos WHERE record_id = ?`, [recordId]);
  if (!linha) return undefined;
  return {
    record_id: linha.record_id,
    form_id: linha.form_id,
    form_version_id: linha.form_version_id,
    form_version: linha.form_version,
    dados: JSON.parse(linha.data) as RecordData,
    base_revision_id: linha.base_revision_id,
    seccao_actual: linha.seccao_actual,
    actualizado_em: linha.actualizado_em,
  };
}

export async function listarRascunhos(db: BaseLocal, formId?: string): Promise<Rascunho[]> {
  const linhas = await db.getAllAsync<{
    record_id: string;
    form_id: string;
    form_version_id: string;
    form_version: number;
    data: string;
    base_revision_id: string | null;
    seccao_actual: number;
    actualizado_em: string;
  }>(
    formId
      ? `SELECT * FROM rascunhos WHERE form_id = ? ORDER BY actualizado_em DESC`
      : `SELECT * FROM rascunhos ORDER BY actualizado_em DESC`,
    formId ? [formId] : [],
  );
  return linhas.map((l) => ({
    record_id: l.record_id,
    form_id: l.form_id,
    form_version_id: l.form_version_id,
    form_version: l.form_version,
    dados: JSON.parse(l.data) as RecordData,
    base_revision_id: l.base_revision_id,
    seccao_actual: l.seccao_actual,
    actualizado_em: l.actualizado_em,
  }));
}

export async function apagarRascunho(db: BaseLocal, recordId: string): Promise<void> {
  await db.runAsync(`DELETE FROM rascunhos WHERE record_id = ?`, [recordId]);
}

/**
 * Gravação com atraso, para não escrever no disco a cada tecla.
 *
 * O atraso é curto de propósito — 400 ms — e há sempre um `gravarJa()` para os
 * momentos em que a app pode morrer: ao mudar de secção, ao ir para segundo
 * plano, ao sair do ecrã. Entre o custo de escrever de mais e o risco de
 * perder o que o técnico escreveu, escolhe-se sempre escrever de mais.
 */
export class GravadorDeRascunho {
  private pendente: { dados: RecordData; seccao: number } | undefined;
  private temporizador: ReturnType<typeof setTimeout> | undefined;
  private aGravar: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: BaseLocal,
    private readonly recordId: string,
    private readonly atrasoMs = 400,
  ) {}

  agendar(dados: RecordData, seccao = 0): void {
    this.pendente = { dados, seccao };
    if (this.temporizador) return;
    this.temporizador = setTimeout(() => {
      this.temporizador = undefined;
      void this.gravarJa();
    }, this.atrasoMs);
  }

  /** Grava agora o que estiver pendente. Devolve quando estiver no disco. */
  async gravarJa(): Promise<void> {
    if (this.temporizador) {
      clearTimeout(this.temporizador);
      this.temporizador = undefined;
    }
    const pendente = this.pendente;
    if (!pendente) return this.aGravar;
    this.pendente = undefined;
    this.aGravar = this.aGravar.then(() =>
      gravarRascunho(this.db, this.recordId, pendente.dados, pendente.seccao),
    );
    return this.aGravar;
  }
}
