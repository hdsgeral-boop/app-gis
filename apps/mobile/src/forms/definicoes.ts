import { collectFields, type FormDefinition } from '@cvforms/form-core';

/**
 * Definições de formulário no telefone (F3.1).
 *
 * Guardadas TODAS as versões, não só a corrente: um registo criado com a v3
 * tem de continuar a abrir com a v3 depois de sair a v4 (ESPECIFICACAO §10).
 * Apagar versões antigas para poupar espaço poupa kilobytes e custa a
 * capacidade de reabrir trabalho de campo — não se faz.
 *
 * O hash decide se vale a pena descarregar. Numa rede que se paga ao megabyte,
 * voltar a descarregar uma definição que não mudou é dinheiro do técnico.
 */

/**
 * O subconjunto do `expo-sqlite` que estes módulos usam. Existe para os testes
 * poderem correr contra SQLite a sério em Node, sem emulador.
 *
 * Os parâmetros são obrigatórios de propósito: a assinatura do `expo-sqlite`
 * não aceita `undefined`, e deixá-los opcionais aqui só adiaria o erro para o
 * sítio onde é mais caro descobri-lo.
 */
export type ValorLigado = string | number | boolean | null | Uint8Array;

export interface BaseLocal {
  runAsync(source: string, params: ValorLigado[]): Promise<unknown>;
  getFirstAsync<T>(source: string, params: ValorLigado[]): Promise<T | null>;
  getAllAsync<T>(source: string, params: ValorLigado[]): Promise<T[]>;
}

/** O que a API devolve em `GET /forms`. */
export interface FormularioRemoto {
  form_id: string;
  key: string;
  titulo: Record<string, string>;
  projecto_id: string;
  versao: number;
  hash: string;
  permissoes: {
    criar: boolean;
    editar_proprios: boolean;
    editar_todos: boolean;
    apagar: boolean;
  };
}

/** Cliente da API, injectado para os testes não precisarem de rede. */
export interface ClienteDeFormularios {
  listar(): Promise<FormularioRemoto[]>;
  definicao(formId: string, versao: number): Promise<{ hash: string; definicao: FormDefinition }>;
}

export interface ResultadoDaSincronizacao {
  descarregadas: number;
  jaActualizadas: number;
  falhadas: Array<{ form_id: string; versao: number; motivo: string }>;
}

/**
 * Traz as definições em falta.
 *
 * Uma definição que falhe não impede as outras: um técnico com cinco
 * formulários atribuídos não pode ficar sem nenhum porque um deles tem um
 * problema no servidor.
 */
export async function sincronizarDefinicoes(
  db: BaseLocal,
  cliente: ClienteDeFormularios,
): Promise<ResultadoDaSincronizacao> {
  const resultado: ResultadoDaSincronizacao = {
    descarregadas: 0,
    jaActualizadas: 0,
    falhadas: [],
  };

  const remotos = await cliente.listar();

  for (const remoto of remotos) {
    await db.runAsync(
      `INSERT INTO forms (id, project_id, key, title, current_version, can_create, can_edit_own, can_edit_all)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id, key = excluded.key, title = excluded.title,
         current_version = excluded.current_version, can_create = excluded.can_create,
         can_edit_own = excluded.can_edit_own, can_edit_all = excluded.can_edit_all,
         archived_at = NULL`,
      [
        remoto.form_id,
        remoto.projecto_id,
        remoto.key,
        JSON.stringify(remoto.titulo),
        remoto.versao,
        remoto.permissoes.criar ? 1 : 0,
        remoto.permissoes.editar_proprios ? 1 : 0,
        remoto.permissoes.editar_todos ? 1 : 0,
      ],
    );

    const guardada = await db.getFirstAsync<{ hash: string }>(
      `SELECT hash FROM form_versions WHERE form_id = ? AND version = ?`,
      [remoto.form_id, remoto.versao],
    );
    if (guardada?.hash === remoto.hash) {
      resultado.jaActualizadas++;
      continue;
    }

    try {
      const descarregada = await cliente.definicao(remoto.form_id, remoto.versao);
      await guardarDefinicao(
        db,
        remoto.form_id,
        remoto.versao,
        descarregada.hash,
        descarregada.definicao,
      );
      resultado.descarregadas++;
    } catch (erro) {
      resultado.falhadas.push({
        form_id: remoto.form_id,
        versao: remoto.versao,
        motivo: erro instanceof Error ? erro.message : String(erro),
      });
    }
  }

  // Um formulário que deixou de estar atribuído é marcado como arquivado, e
  // NÃO é apagado: os registos já recolhidos com ele ainda têm de subir
  // (ver PLANO.md, F5.8).
  const idsRemotos = remotos.map((r) => r.form_id);
  const marcadores = idsRemotos.map(() => '?').join(',');
  await db.runAsync(
    idsRemotos.length > 0
      ? `UPDATE forms SET archived_at = datetime('now') WHERE id NOT IN (${marcadores}) AND archived_at IS NULL`
      : `UPDATE forms SET archived_at = datetime('now') WHERE archived_at IS NULL`,
    idsRemotos,
  );

  return resultado;
}

export async function guardarDefinicao(
  db: BaseLocal,
  formId: string,
  versao: number,
  hash: string,
  definicao: FormDefinition,
): Promise<void> {
  await db.runAsync(
    `INSERT INTO form_versions (id, form_id, version, definition, hash, published_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(form_id, version) DO UPDATE SET
       definition = excluded.definition, hash = excluded.hash, published_at = excluded.published_at`,
    [
      `${formId}:${versao}`,
      formId,
      versao,
      JSON.stringify(definicao),
      hash,
      definicao.published_at ?? null,
    ],
  );
}

export async function lerDefinicao(
  db: BaseLocal,
  formId: string,
  versao: number,
): Promise<FormDefinition | undefined> {
  const linha = await db.getFirstAsync<{ definition: string }>(
    `SELECT definition FROM form_versions WHERE form_id = ? AND version = ?`,
    [formId, versao],
  );
  return linha ? (JSON.parse(linha.definition) as FormDefinition) : undefined;
}

/** A versão mais alta que está no telefone. É com esta que se cria de novo. */
export async function lerDefinicaoCorrente(
  db: BaseLocal,
  formId: string,
): Promise<FormDefinition | undefined> {
  const linha = await db.getFirstAsync<{ definition: string }>(
    `SELECT definition FROM form_versions WHERE form_id = ? ORDER BY version DESC LIMIT 1`,
    [formId],
  );
  return linha ? (JSON.parse(linha.definition) as FormDefinition) : undefined;
}

export interface FormularioLocal {
  id: string;
  key: string;
  titulo: Record<string, string>;
  versao: number | null;
  pode_criar: boolean;
  arquivado: boolean;
}

export async function listarFormulariosLocais(db: BaseLocal): Promise<FormularioLocal[]> {
  const linhas = await db.getAllAsync<{
    id: string;
    key: string;
    title: string;
    current_version: number | null;
    can_create: number;
    archived_at: string | null;
  }>(`SELECT id, key, title, current_version, can_create, archived_at FROM forms ORDER BY key`, []);

  return linhas.map((l) => ({
    id: l.id,
    key: l.key,
    titulo: JSON.parse(l.title) as Record<string, string>,
    versao: l.current_version,
    pode_criar: l.can_create === 1,
    arquivado: l.archived_at !== null,
  }));
}

/**
 * Os `id` dos campos pesquisáveis de todos os formulários que estão no
 * telefone.
 *
 * Numa consulta e não uma por formulário: a lista de registos chama isto a
 * cada tecla da procura, e cinco formulários dariam cinco viagens ao SQLite
 * por letra escrita.
 *
 * Só campos do âmbito raiz. Procurar por um valor que está dentro de uma
 * instância de repetível devolveria o registo sem dizer qual instância, o que
 * confunde mais do que ajuda — é a mesma regra do índice de procura.
 */
export async function camposPesquisaveis(db: BaseLocal): Promise<string[]> {
  const linhas = await db.getAllAsync<{ definition: string }>(
    `SELECT v.definition
     FROM form_versions v
     JOIN forms f ON f.id = v.form_id AND f.current_version = v.version
     WHERE f.archived_at IS NULL`,
    [],
  );

  const campos = new Set<string>();
  for (const linha of linhas) {
    try {
      const definicao = JSON.parse(linha.definition) as FormDefinition;
      for (const v of collectFields(definicao)) {
        if (v.field.searchable === true && v.repeatScope === undefined) campos.add(v.field.id);
      }
    } catch {
      // Uma definição ilegível não pode partir a procura das outras.
      continue;
    }
  }
  return [...campos];
}
