import { uuidv7 } from '@cvforms/form-core';

import type { BaseLocal, ValorLigado } from '@/forms/definicoes';

/**
 * Fila de subida (F5.3 e F5.5).
 *
 * Vive no SQLite, e não em memória: fechar a app, ficar sem bateria ou
 * reiniciar o telefone não pode perder nada do que já foi gravado. É a mesma
 * regra de sempre — perder um registo de campo é o pior defeito possível.
 *
 * Três decisões que governam este ficheiro:
 *
 * 1. **Nada sai da fila por ter falhado.** Um erro de rede volta a ser tentado
 *    com espera crescente; um erro permanente (o servidor recusou) fica
 *    ESTACIONADO, com o motivo à vista, à espera de decisão humana. Apagar
 *    seria a única forma de perder trabalho, e por isso não existe.
 * 2. **A ordem por registo é preservada.** As revisões de um registo têm de
 *    subir pela ordem em que foram criadas, senão o servidor vê conflitos onde
 *    não há nenhum. Entre registos diferentes a ordem não importa.
 * 3. **A espera tem tecto.** O backoff cresce até cinco minutos e pára aí: um
 *    técnico que reencontra rede depois de duas horas no mato não pode ficar à
 *    espera de mais duas horas por causa de uma fórmula exponencial.
 */

export const ESQUEMA_DA_FILA = `
  CREATE TABLE IF NOT EXISTS fila_de_subida (
    id                TEXT PRIMARY KEY,
    tipo              TEXT NOT NULL,
    record_id         TEXT NOT NULL,
    revision_id       TEXT,
    /* Corpo do pedido, já pronto. Guardado para a subida não depender de
       voltar a ler o estado, que pode ter mudado entretanto. */
    payload           TEXT NOT NULL,
    /* Chave de idempotência, estável entre tentativas: é o que impede que um
       pedido que chegou mas cuja resposta se perdeu duplique o registo. */
    chave             TEXT NOT NULL,
    sequencia         INTEGER NOT NULL,
    tentativas        INTEGER NOT NULL DEFAULT 0,
    proxima_tentativa TEXT NOT NULL,
    estado            TEXT NOT NULL DEFAULT 'pendente',
    ultimo_erro       TEXT,
    criado_em         TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fila_pendentes ON fila_de_subida (estado, proxima_tentativa);
  CREATE INDEX IF NOT EXISTS fila_por_registo ON fila_de_subida (record_id, sequencia);
`;

export type TipoDeItem = 'criar' | 'actualizar' | 'apagar';
export type EstadoDoItem = 'pendente' | 'estacionado';

export interface ItemDaFila {
  id: string;
  tipo: TipoDeItem;
  record_id: string;
  revision_id: string | null;
  payload: Record<string, unknown>;
  chave: string;
  sequencia: number;
  tentativas: number;
  proxima_tentativa: string;
  estado: EstadoDoItem;
  ultimo_erro: string | null;
}

/** O que a subida devolve. É o transporte que decide o que é permanente. */
export type ResultadoDaSubida =
  | { ok: true }
  /** Falha temporária: sem rede, 5xx, tempo esgotado. Volta a tentar. */
  | { ok: false; permanente: false; motivo: string }
  /** Falha permanente: o servidor recusou. Estaciona à espera de um humano. */
  | { ok: false; permanente: true; motivo: string };

export interface Transporte {
  enviar(item: ItemDaFila): Promise<ResultadoDaSubida>;
}

export async function prepararFila(db: BaseLocal): Promise<void> {
  await db.runAsync(ESQUEMA_DA_FILA, []);
}

export interface EnfileirarInput {
  tipo: TipoDeItem;
  recordId: string;
  revisionId?: string | null;
  payload: Record<string, unknown>;
  /** Injectável para os testes. */
  agora?: Date;
}

export async function enfileirar(db: BaseLocal, input: EnfileirarInput): Promise<ItemDaFila> {
  const agora = input.agora ?? new Date();
  const [ultimo] = await db.getAllAsync<{ n: number }>(
    `SELECT COALESCE(max(sequencia), 0) AS n FROM fila_de_subida WHERE record_id = ?`,
    [input.recordId],
  );
  const sequencia = (ultimo?.n ?? 0) + 1;
  const id = uuidv7();

  await db.runAsync(
    `INSERT INTO fila_de_subida
       (id, tipo, record_id, revision_id, payload, chave, sequencia, proxima_tentativa, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.tipo,
      input.recordId,
      input.revisionId ?? null,
      JSON.stringify(input.payload),
      // A chave de idempotência é a da REVISÃO, e não do item: se a fila for
      // reconstruída, a mesma revisão continua a ter a mesma chave, e o
      // servidor reconhece-a.
      input.revisionId ?? `${input.recordId}:${input.tipo}:${sequencia}`,
      sequencia,
      agora.toISOString(),
      agora.toISOString(),
    ],
  );

  return {
    id,
    tipo: input.tipo,
    record_id: input.recordId,
    revision_id: input.revisionId ?? null,
    payload: input.payload,
    chave: input.revisionId ?? `${input.recordId}:${input.tipo}:${sequencia}`,
    sequencia,
    tentativas: 0,
    proxima_tentativa: agora.toISOString(),
    estado: 'pendente',
    ultimo_erro: null,
  };
}

export interface ResultadoDoProcessamento {
  enviados: number;
  adiados: number;
  estacionados: number;
  /** `true` se ficou trabalho por fazer que ainda vai ser tentado. */
  restaPendente: boolean;
}

/**
 * Processa a fila até acabar ou até um item bloquear o seu registo.
 *
 * Um item que falha bloqueia os seguintes DO MESMO REGISTO — sem isso, a
 * revisão 3 subiria antes da 2 e o servidor via um conflito inventado. Os
 * outros registos continuam a subir normalmente.
 */
export async function processarFila(
  db: BaseLocal,
  transporte: Transporte,
  opcoes: { agora?: Date; limite?: number } = {},
): Promise<ResultadoDoProcessamento> {
  const agora = opcoes.agora ?? new Date();
  const limite = opcoes.limite ?? 200;
  const resultado: ResultadoDoProcessamento = {
    enviados: 0,
    adiados: 0,
    estacionados: 0,
    restaPendente: false,
  };

  const itens = await lerPendentes(db, agora, limite);
  const bloqueados = new Set<string>();

  for (const item of itens) {
    if (bloqueados.has(item.record_id)) {
      resultado.restaPendente = true;
      continue;
    }

    const resposta = await transporte.enviar(item);

    if (resposta.ok) {
      await db.runAsync(`DELETE FROM fila_de_subida WHERE id = ?`, [item.id]);
      await marcarSincronizado(db, item);
      resultado.enviados++;
      continue;
    }

    bloqueados.add(item.record_id);

    if (resposta.permanente) {
      await db.runAsync(
        `UPDATE fila_de_subida SET estado = 'estacionado', ultimo_erro = ?, tentativas = tentativas + 1
         WHERE id = ?`,
        [resposta.motivo, item.id],
      );
      resultado.estacionados++;
      continue;
    }

    const tentativas = item.tentativas + 1;
    await db.runAsync(
      `UPDATE fila_de_subida SET tentativas = ?, proxima_tentativa = ?, ultimo_erro = ? WHERE id = ?`,
      [tentativas, proximaTentativa(tentativas, agora).toISOString(), resposta.motivo, item.id],
    );
    resultado.adiados++;
    resultado.restaPendente = true;
  }

  return resultado;
}

/**
 * Espera antes da tentativa seguinte: 2 s, 4 s, 8 s… até um tecto de 5 minutos,
 * com uma variação aleatória de ±20 %.
 *
 * A variação existe porque vinte telefones que perdem a rede na mesma célula
 * voltam a tentar todos ao mesmo segundo, e essa é exactamente a forma de a
 * rede voltar a cair no momento em que volta.
 */
export function proximaTentativa(tentativas: number, agora: Date): Date {
  const TECTO_MS = 5 * 60_000;
  const base = Math.min(2000 * 2 ** Math.max(0, tentativas - 1), TECTO_MS);
  const variacao = base * 0.2 * (Math.random() * 2 - 1);
  return new Date(agora.getTime() + base + variacao);
}

async function lerPendentes(db: BaseLocal, agora: Date, limite: number): Promise<ItemDaFila[]> {
  const linhas = await db.getAllAsync<Record<string, ValorLigado>>(
    `SELECT * FROM fila_de_subida
     WHERE estado = 'pendente' AND proxima_tentativa <= ?
     ORDER BY record_id, sequencia
     LIMIT ?`,
    [agora.toISOString(), limite],
  );
  return linhas.map(paraItem);
}

/** Tudo o que está na fila, para o ecrã poder mostrar o que falta subir. */
export async function estadoDaFila(db: BaseLocal): Promise<{
  pendentes: number;
  estacionados: number;
  itens: ItemDaFila[];
}> {
  const linhas = await db.getAllAsync<Record<string, ValorLigado>>(
    `SELECT * FROM fila_de_subida ORDER BY criado_em`,
    [],
  );
  const itens = linhas.map(paraItem);
  return {
    pendentes: itens.filter((i) => i.estado === 'pendente').length,
    estacionados: itens.filter((i) => i.estado === 'estacionado').length,
    itens,
  };
}

/**
 * Devolve um item estacionado à fila. É a única saída de um estacionamento, e
 * é sempre por decisão de alguém — nunca automática.
 */
export async function retomarEstacionado(
  db: BaseLocal,
  id: string,
  agora = new Date(),
): Promise<void> {
  await db.runAsync(
    `UPDATE fila_de_subida SET estado = 'pendente', tentativas = 0, proxima_tentativa = ?
     WHERE id = ? AND estado = 'estacionado'`,
    [agora.toISOString(), id],
  );
}

async function marcarSincronizado(db: BaseLocal, item: ItemDaFila): Promise<void> {
  if (item.revision_id) {
    await db.runAsync(`UPDATE record_revisions SET synced = 1 WHERE id = ?`, [item.revision_id]);
  }
  // O registo só conta como sincronizado quando não sobrar nada dele na fila.
  await db.runAsync(
    `UPDATE records SET synced = 1
     WHERE id = ? AND NOT EXISTS (SELECT 1 FROM fila_de_subida WHERE record_id = ?)`,
    [item.record_id, item.record_id],
  );
}

function paraItem(linha: Record<string, ValorLigado>): ItemDaFila {
  return {
    id: String(linha['id']),
    tipo: String(linha['tipo']) as TipoDeItem,
    record_id: String(linha['record_id']),
    revision_id: linha['revision_id'] === null ? null : String(linha['revision_id']),
    payload: JSON.parse(String(linha['payload'])) as Record<string, unknown>,
    chave: String(linha['chave']),
    sequencia: Number(linha['sequencia']),
    tentativas: Number(linha['tentativas']),
    proxima_tentativa: String(linha['proxima_tentativa']),
    estado: String(linha['estado']) as EstadoDoItem,
    ultimo_erro: linha['ultimo_erro'] === null ? null : String(linha['ultimo_erro']),
  };
}
