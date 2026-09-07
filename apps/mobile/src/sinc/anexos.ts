import type { BaseLocal, ValorLigado } from '@/forms/definicoes';

/**
 * Fila dos anexos (F9.2, F9.4, F9.5 e F9.7).
 *
 * Separada da fila dos registos, e a razão é a que está na ESPECIFICACAO §10:
 * **o registo sincroniza mesmo com fotos por subir**. Uma foto de 2 MB numa
 * rede de campo demora minutos; prender a subida do registo a ela significaria
 * que o trabalho do dia só ficava seguro quando a última foto acabasse.
 *
 * Três políticas, todas com o mesmo motivo por trás — a rede de campo custa
 * dinheiro ao técnico e à empresa:
 *   - **só por Wi-Fi, por omissão**, e o técnico pode mudar (F9.4);
 *   - **prioridade baixa**: os registos passam sempre à frente;
 *   - **o ficheiro local só se apaga depois de o servidor confirmar** (F9.7).
 */

export const ESQUEMA_DOS_ANEXOS = `
  CREATE TABLE IF NOT EXISTS fila_de_anexos (
    id            TEXT PRIMARY KEY,
    record_id     TEXT NOT NULL,
    field_id      TEXT NOT NULL,
    local_uri     TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    bytes         INTEGER NOT NULL,
    /* SHA-256 do conteúdo: é por ele que o servidor deduplica. */
    hash          TEXT NOT NULL,
    estado        TEXT NOT NULL DEFAULT 'pendente',
    tentativas    INTEGER NOT NULL DEFAULT 0,
    ultimo_erro   TEXT,
    /* Preenchido quando o servidor confirma. Só então se pode apagar o local. */
    confirmado_em TEXT,
    criado_em     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS fila_de_anexos_estado ON fila_de_anexos (estado, criado_em);
  CREATE INDEX IF NOT EXISTS fila_de_anexos_hash ON fila_de_anexos (hash);
`;

export type EstadoDoAnexo = 'pendente' | 'a_enviar' | 'concluido' | 'falhado';

export interface AnexoNaFila {
  id: string;
  record_id: string;
  field_id: string;
  local_uri: string;
  mime_type: string;
  bytes: number;
  hash: string;
  estado: EstadoDoAnexo;
  tentativas: number;
  ultimo_erro: string | null;
  confirmado_em: string | null;
}

export interface PoliticaDeRede {
  /** `true` quando o telefone está em Wi-Fi. */
  wifi: boolean;
  /** O técnico autorizou subir por dados móveis. */
  permitirDadosMoveis: boolean;
}

/** Decide se se pode subir agora. É a F9.4, e nada mais. */
export function podeEnviar(politica: PoliticaDeRede): boolean {
  return politica.wifi || politica.permitirDadosMoveis;
}

export interface ClienteDeAnexos {
  /**
   * Pede autorização ao servidor. Se ele responder que o conteúdo já existe,
   * não há nada para enviar — é a deduplicação por hash (F9.6).
   */
  presign(
    anexo: AnexoNaFila,
  ): Promise<{ jaExiste: boolean; url?: string; cabecalhos?: Record<string, string> }>;
  /** Envia o ficheiro para o URL assinado. Não passa pela API. */
  enviar(anexo: AnexoNaFila, url: string, cabecalhos: Record<string, string>): Promise<void>;
  /** Confirma ao servidor que acabou. */
  completar(anexo: AnexoNaFila): Promise<void>;
}

export interface ResultadoDosAnexos {
  enviados: number;
  jaExistiam: number;
  adiados: number;
  falhados: number;
  /** `true` quando não se enviou nada por causa da política de rede. */
  travadoPelaRede: boolean;
}

export async function prepararFilaDeAnexos(db: BaseLocal): Promise<void> {
  await db.runAsync(ESQUEMA_DOS_ANEXOS, []);
}

export interface NovoAnexo {
  id: string;
  recordId: string;
  fieldId: string;
  localUri: string;
  mimeType: string;
  bytes: number;
  hash: string;
  agora?: Date;
}

export async function enfileirarAnexo(db: BaseLocal, novo: NovoAnexo): Promise<void> {
  await db.runAsync(
    `INSERT INTO fila_de_anexos (id, record_id, field_id, local_uri, mime_type, bytes, hash, criado_em)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    [
      novo.id,
      novo.recordId,
      novo.fieldId,
      novo.localUri,
      novo.mimeType,
      novo.bytes,
      novo.hash.toLowerCase(),
      (novo.agora ?? new Date()).toISOString(),
    ],
  );
}

/**
 * Processa a fila.
 *
 * Um anexo que falhe NÃO trava os outros: ao contrário das revisões, dois
 * anexos não têm ordem entre si. E nenhum sai da fila por ter falhado — fica
 * `falhado` com o motivo à vista, à espera de decisão.
 */
export async function processarAnexos(
  db: BaseLocal,
  cliente: ClienteDeAnexos,
  politica: PoliticaDeRede,
  opcoes: { limite?: number } = {},
): Promise<ResultadoDosAnexos> {
  const resultado: ResultadoDosAnexos = {
    enviados: 0,
    jaExistiam: 0,
    adiados: 0,
    falhados: 0,
    travadoPelaRede: false,
  };

  if (!podeEnviar(politica)) {
    // Não é um erro nem uma falha: é a política a funcionar. O ecrã mostra
    // «à espera de Wi-Fi» e o técnico decide se quer gastar dados.
    const [pendentes] = await db.getAllAsync<{ n: number }>(
      `SELECT count(*) AS n FROM fila_de_anexos WHERE estado = 'pendente'`,
      [],
    );
    resultado.adiados = pendentes?.n ?? 0;
    resultado.travadoPelaRede = resultado.adiados > 0;
    return resultado;
  }

  const linhas = await db.getAllAsync<Record<string, ValorLigado>>(
    `SELECT * FROM fila_de_anexos WHERE estado IN ('pendente', 'a_enviar')
     ORDER BY criado_em LIMIT ?`,
    [opcoes.limite ?? 20],
  );

  for (const linha of linhas) {
    const anexo = paraAnexo(linha);
    try {
      const autorizacao = await cliente.presign(anexo);

      if (autorizacao.jaExiste) {
        await concluir(db, anexo.id);
        resultado.jaExistiam++;
        continue;
      }
      if (!autorizacao.url) throw new Error('o servidor não devolveu URL de envio');

      // `a_enviar` marca a tentativa ANTES de a fazer: se a app morrer a meio
      // do upload, ao reabrir sabe-se que este ficou pelo caminho e retoma-se
      // (F9.5). O servidor deduplica pelo hash, por isso repetir não duplica.
      await db.runAsync(`UPDATE fila_de_anexos SET estado = 'a_enviar' WHERE id = ?`, [anexo.id]);
      await cliente.enviar(anexo, autorizacao.url, autorizacao.cabecalhos ?? {});
      await cliente.completar(anexo);
      await concluir(db, anexo.id);
      resultado.enviados++;
    } catch (erro) {
      const motivo = erro instanceof Error ? erro.message : String(erro);
      await db.runAsync(
        `UPDATE fila_de_anexos
         SET estado = 'pendente', tentativas = tentativas + 1, ultimo_erro = ?
         WHERE id = ?`,
        [motivo, anexo.id],
      );
      resultado.falhados++;
    }
  }

  return resultado;
}

async function concluir(db: BaseLocal, id: string): Promise<void> {
  await db.runAsync(
    `UPDATE fila_de_anexos SET estado = 'concluido', confirmado_em = ?, ultimo_erro = NULL WHERE id = ?`,
    [new Date().toISOString(), id],
  );
}

/**
 * Ficheiros locais que já se podem apagar (F9.7).
 *
 * A condição é uma só e não tem excepções: o servidor confirmou. Apagar antes
 * disso, por falta de espaço ou por qualquer outra razão, é perder trabalho de
 * campo — e é o pior defeito possível deste sistema.
 */
export async function anexosSeguroApagar(db: BaseLocal): Promise<AnexoNaFila[]> {
  const linhas = await db.getAllAsync<Record<string, ValorLigado>>(
    `SELECT * FROM fila_de_anexos
     WHERE estado = 'concluido' AND confirmado_em IS NOT NULL
     ORDER BY confirmado_em`,
    [],
  );
  return linhas.map(paraAnexo);
}

/** Marca o ficheiro local como apagado, mantendo o registo do anexo. */
export async function marcarLocalApagado(db: BaseLocal, id: string): Promise<void> {
  await db.runAsync(
    `UPDATE fila_de_anexos SET local_uri = '' WHERE id = ? AND estado = 'concluido'`,
    [id],
  );
}

export interface ResumoDosAnexos {
  pendentes: number;
  bytesPendentes: number;
  falhados: number;
  concluidos: number;
  bytesRecuperaveis: number;
}

/** O que o ecrã mostra ao técnico antes de ele decidir gastar dados. */
export async function resumoDosAnexos(db: BaseLocal): Promise<ResumoDosAnexos> {
  const [linha] = await db.getAllAsync<Record<string, number>>(
    `SELECT
       COALESCE(sum(CASE WHEN estado IN ('pendente','a_enviar') THEN 1 ELSE 0 END), 0) AS pendentes,
       COALESCE(sum(CASE WHEN estado IN ('pendente','a_enviar') THEN bytes ELSE 0 END), 0) AS bytes_pendentes,
       COALESCE(sum(CASE WHEN tentativas >= 5 THEN 1 ELSE 0 END), 0) AS falhados,
       COALESCE(sum(CASE WHEN estado = 'concluido' THEN 1 ELSE 0 END), 0) AS concluidos,
       COALESCE(sum(CASE WHEN estado = 'concluido' AND local_uri <> '' THEN bytes ELSE 0 END), 0) AS bytes_recuperaveis
     FROM fila_de_anexos`,
    [],
  );
  return {
    pendentes: Number(linha?.['pendentes'] ?? 0),
    bytesPendentes: Number(linha?.['bytes_pendentes'] ?? 0),
    falhados: Number(linha?.['falhados'] ?? 0),
    concluidos: Number(linha?.['concluidos'] ?? 0),
    bytesRecuperaveis: Number(linha?.['bytes_recuperaveis'] ?? 0),
  };
}

function paraAnexo(linha: Record<string, ValorLigado>): AnexoNaFila {
  return {
    id: String(linha['id']),
    record_id: String(linha['record_id']),
    field_id: String(linha['field_id']),
    local_uri: String(linha['local_uri']),
    mime_type: String(linha['mime_type']),
    bytes: Number(linha['bytes']),
    hash: String(linha['hash']),
    estado: String(linha['estado']) as EstadoDoAnexo,
    tentativas: Number(linha['tentativas']),
    ultimo_erro: linha['ultimo_erro'] === null ? null : String(linha['ultimo_erro']),
    confirmado_em: linha['confirmado_em'] === null ? null : String(linha['confirmado_em']),
  };
}
