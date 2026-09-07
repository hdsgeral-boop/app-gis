import { uuidv7, type RecordData, type RecordStatus } from '@cvforms/form-core';

import type { BaseLocal, ValorLigado } from '@/forms/definicoes';

/**
 * Registos e revisões no telefone (F4).
 *
 * As três regras que governam este ficheiro inteiro:
 *   - escreve-se sempre primeiro aqui, nunca na rede (restrição 2);
 *   - o `id` é UUIDv7 gerado no telefone e não muda nunca (restrição 3);
 *   - uma revisão nunca é alterada nem apagada; editar cria a seguinte
 *     (restrição 4).
 *
 * Perder um registo de campo é o pior defeito possível deste sistema. Quando
 * houver dúvida entre duplicar e perder, duplica-se.
 */

export interface Registo {
  id: string;
  org_id: string;
  project_id: string;
  form_id: string;
  form_version_id: string;
  current_revision_id: string | null;
  lat: number | null;
  lon: number | null;
  status: RecordStatus;
  created_by: string | null;
  client_created_at: string;
  updated_at: string;
  deleted_at: string | null;
  synced: boolean;
}

export interface Revisao {
  id: string;
  record_id: string;
  revision_no: number;
  form_version_id: string;
  dados: RecordData;
  base_revision_id: string | null;
  device_id: string | null;
  client_created_at: string;
  synced: boolean;
}

export interface GravarRegistoInput {
  /** Ausente cria um registo novo; presente cria a revisão seguinte. */
  recordId?: string;
  orgId: string;
  projectId: string;
  formId: string;
  formVersionId: string;
  dados: RecordData;
  deviceId?: string | null;
  autorId?: string | null;
  /** Estado a atribuir. O cliente escreve sempre `rascunho` (§13.7). */
  status?: RecordStatus;
  /** Coordenada que alimenta o mapa, vinda de `settings.geometry_field`. */
  geometria?: { lat: number; lon: number } | null;
  /** Justificação escrita quando se gravou acima do limiar de precisão. */
  justificacaoDePrecisao?: string | null;
  /**
   * `id` dos campos marcados como `searchable` na definição. Vêm de fora
   * porque este módulo não conhece formulários — só dados.
   */
  camposDeProcura?: readonly string[];
}

export interface GravarRegistoResultado {
  recordId: string;
  revisionId: string;
  revisionNo: number;
}

/**
 * Grava uma revisão. É o único caminho por onde os dados de campo entram.
 *
 * A revisão nova aponta para a anterior em `base_revision_id`, e é isso que
 * permite ao servidor detectar dois dispositivos a editar o mesmo registo a
 * partir da mesma base — o conflito da F5.6.
 */
export async function gravarRegisto(
  db: BaseLocal,
  input: GravarRegistoInput,
): Promise<GravarRegistoResultado> {
  const agora = new Date().toISOString();
  const recordId = input.recordId ?? uuidv7();
  const existente = await lerRegisto(db, recordId);

  if (!existente) {
    await db.runAsync(
      `INSERT INTO records
         (id, org_id, project_id, form_id, form_version_id, current_revision_id,
          lat, lon, status, created_by, client_created_at, updated_at, synced)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 0)`,
      [
        recordId,
        input.orgId,
        input.projectId,
        input.formId,
        input.formVersionId,
        input.geometria?.lat ?? null,
        input.geometria?.lon ?? null,
        input.status ?? 'rascunho',
        input.autorId ?? null,
        agora,
        agora,
      ],
    );
  }

  const ultima = await ultimaRevisao(db, recordId);
  const revisionNo = (ultima?.revision_no ?? 0) + 1;
  const revisionId = uuidv7();

  await db.runAsync(
    `INSERT INTO record_revisions
       (id, record_id, revision_no, form_version_id, data, base_revision_id, device_id, client_created_at, synced)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [
      revisionId,
      recordId,
      revisionNo,
      input.formVersionId,
      JSON.stringify(input.dados),
      ultima?.id ?? null,
      input.deviceId ?? null,
      agora,
    ],
  );

  await db.runAsync(
    `UPDATE records SET current_revision_id = ?, updated_at = ?, synced = 0,
       lat = COALESCE(?, lat), lon = COALESCE(?, lon), status = COALESCE(?, status)
     WHERE id = ?`,
    [
      revisionId,
      agora,
      input.geometria?.lat ?? null,
      input.geometria?.lon ?? null,
      input.status ?? null,
      recordId,
    ],
  );

  await actualizarIndiceDeProcura(db, recordId, input.dados, input.camposDeProcura ?? []);

  if (input.justificacaoDePrecisao?.trim()) {
    // Fica ligada à revisão, e não ao registo: a justificação é sobre o que foi
    // recolhido naquele momento, e uma edição posterior não a herda.
    await db.runAsync(
      `INSERT INTO justificacoes_de_precisao (revision_id, record_id, motivo, criado_em)
       VALUES (?, ?, ?, ?)`,
      [revisionId, recordId, input.justificacaoDePrecisao.trim(), agora],
    );
  }

  return { recordId, revisionId, revisionNo };
}

/**
 * Índice de procura (F4.4).
 *
 * Sem isto, procurar significa varrer `json_extract` sobre todas as revisões
 * correntes — 30 000 objectos JSON analisados a cada tecla. Num portátil isso
 * já anda à beira dos 200 ms; num Android de gama baixa é inutilizável, e a
 * procura é a operação que um técnico faz mais vezes por dia.
 *
 * A tabela é derivada e descartável: reconstrói-se sempre a partir das
 * revisões. Guarda o valor em minúsculas para a comparação não depender de
 * como o técnico escreveu.
 */
export const ESQUEMA_INDICE_DE_PROCURA = `
  CREATE TABLE IF NOT EXISTS indice_de_procura (
    record_id TEXT NOT NULL,
    field_id  TEXT NOT NULL,
    valor     TEXT NOT NULL,
    PRIMARY KEY (record_id, field_id)
  );
  CREATE INDEX IF NOT EXISTS indice_de_procura_valor ON indice_de_procura (valor);
`;

export const ESQUEMA_JUSTIFICACOES = `
  CREATE TABLE IF NOT EXISTS justificacoes_de_precisao (
    revision_id TEXT PRIMARY KEY,
    record_id   TEXT NOT NULL,
    motivo      TEXT NOT NULL,
    criado_em   TEXT NOT NULL
  );
`;

/**
 * Reescreve as entradas de procura deste registo.
 *
 * Só campos do âmbito raiz: procurar por um valor que está dentro de uma
 * instância de repetível devolveria o registo sem dizer qual instância, o que
 * confunde mais do que ajuda.
 */
async function actualizarIndiceDeProcura(
  db: BaseLocal,
  recordId: string,
  dados: RecordData,
  campos: readonly string[],
): Promise<void> {
  await db.runAsync(`DELETE FROM indice_de_procura WHERE record_id = ?`, [recordId]);
  for (const campo of campos) {
    const valor = dados[campo];
    if (valor === null || valor === undefined || typeof valor === 'object') continue;
    await db.runAsync(
      `INSERT INTO indice_de_procura (record_id, field_id, valor) VALUES (?, ?, ?)`,
      [recordId, campo, String(valor).toLowerCase()],
    );
  }
}

/**
 * Reconstrói o índice de procura inteiro, a partir das revisões correntes.
 *
 * O índice é derivado: as entradas de um registo só são escritas quando ele é
 * gravado. Isso chega enquanto os campos `searchable` não mudam — mas basta
 * uma versão nova do formulário marcar mais um campo como pesquisável para os
 * registos antigos ficarem de fora da procura até alguém lhes tocar. Um
 * técnico a procurar por um código que existe e não aparece não conclui «o
 * índice está velho»: conclui que perdeu o registo.
 *
 * Corre em lotes e não numa transacção só: num telefone de gama baixa com
 * 30 000 registos, uma transacção única segura a base durante segundos e a
 * app fica presa. Um lote interrompido a meio deixa o índice incompleto, e
 * não errado — voltar a correr resolve.
 *
 * `camposDeProcura` recebe o `form_version_id` e devolve os `id` dos campos
 * pesquisáveis dessa versão. Fica de fora de propósito: este módulo não sabe
 * ler definições, e não é aqui que essa dependência deve entrar.
 */
export async function reconstruirIndiceDeProcura(
  db: BaseLocal,
  camposDeProcura: (formVersionId: string) => Promise<readonly string[]> | readonly string[],
  opcoes: { lote?: number } = {},
): Promise<{ registos: number; entradas: number }> {
  const lote = opcoes.lote ?? 200;
  const linhas = await db.getAllAsync<{ record_id: string; form_version_id: string; data: string }>(
    `SELECT r.id AS record_id, v.form_version_id, v.data
     FROM records r
     JOIN record_revisions v ON v.id = r.current_revision_id
     WHERE r.deleted_at IS NULL
     ORDER BY r.id`,
    [],
  );

  // Os campos por versão resolvem-se uma vez: um formulário com 30 000
  // registos tem meia dúzia de versões, e voltar a analisar a definição por
  // registo seria o mesmo trabalho 30 000 vezes.
  const porVersao = new Map<string, readonly string[]>();
  let entradas = 0;

  await db.runAsync(`DELETE FROM indice_de_procura`, []);

  for (let i = 0; i < linhas.length; i += lote) {
    for (const linha of linhas.slice(i, i + lote)) {
      let campos = porVersao.get(linha.form_version_id);
      if (!campos) {
        campos = await camposDeProcura(linha.form_version_id);
        porVersao.set(linha.form_version_id, campos);
      }
      if (campos.length === 0) continue;

      let dados: RecordData;
      try {
        dados = JSON.parse(linha.data) as RecordData;
      } catch {
        // Uma revisão ilegível não pára a reconstrução das outras. Perder o
        // índice de um registo é mau; perder o de todos é pior.
        continue;
      }

      for (const campo of campos) {
        const valor = dados[campo];
        if (valor === null || valor === undefined || typeof valor === 'object') continue;
        await db.runAsync(
          `INSERT OR REPLACE INTO indice_de_procura (record_id, field_id, valor) VALUES (?, ?, ?)`,
          [linha.record_id, campo, String(valor).toLowerCase()],
        );
        entradas++;
      }
    }
  }

  return { registos: linhas.length, entradas };
}

/**
 * Transição de estado.
 *
 * `rascunho` → `submetido` é um acto explícito do técnico (§13.7). Não
 * acontece por sincronizar, não acontece por sair do ecrã.
 */
export async function submeter(db: BaseLocal, recordId: string): Promise<void> {
  await db.runAsync(
    `UPDATE records SET status = 'submetido', updated_at = ?, synced = 0
     WHERE id = ? AND status = 'rascunho'`,
    [new Date().toISOString(), recordId],
  );
}

/** Soft delete com tombstone. Nunca há DELETE (restrição inegociável 4). */
export async function apagarRegisto(db: BaseLocal, recordId: string): Promise<void> {
  await db.runAsync(`UPDATE records SET deleted_at = ?, updated_at = ?, synced = 0 WHERE id = ?`, [
    new Date().toISOString(),
    new Date().toISOString(),
    recordId,
  ]);
}

export async function lerRegisto(db: BaseLocal, recordId: string): Promise<Registo | undefined> {
  const linha = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM records WHERE id = ?`,
    [recordId],
  );
  return linha ? paraRegisto(linha) : undefined;
}

export async function ultimaRevisao(db: BaseLocal, recordId: string): Promise<Revisao | undefined> {
  const linha = await db.getFirstAsync<Record<string, unknown>>(
    `SELECT * FROM record_revisions WHERE record_id = ? ORDER BY revision_no DESC LIMIT 1`,
    [recordId],
  );
  return linha ? paraRevisao(linha) : undefined;
}

/** Histórico completo, da mais antiga para a mais recente. */
export async function revisoesDe(db: BaseLocal, recordId: string): Promise<Revisao[]> {
  const linhas = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM record_revisions WHERE record_id = ? ORDER BY revision_no`,
    [recordId],
  );
  return linhas.map(paraRevisao);
}

/**
 * Dados com que um registo se reabre: os da revisão corrente, com a versão de
 * formulário com que foi criado (F4.7).
 */
export async function abrirParaEdicao(
  db: BaseLocal,
  recordId: string,
): Promise<{ registo: Registo; revisao: Revisao; versao: EstadoDaVersao } | undefined> {
  const registo = await lerRegisto(db, recordId);
  if (!registo) return undefined;
  const revisao = await ultimaRevisao(db, recordId);
  if (!revisao) return undefined;
  const versao = await estadoDaVersao(db, recordId);
  if (!versao) return undefined;
  return { registo, revisao, versao };
}

export interface EstadoDaVersao {
  /** Versão com que o registo foi recolhido. */
  doRegisto: number | null;
  /** Versão publicada corrente do formulário, tal como o telefone a conhece. */
  corrente: number | null;
  /** `true` quando saiu uma versão nova depois de este registo ser recolhido. */
  desactualizado: boolean;
  /**
   * `true` se a definição original ainda está no telefone. Se não estiver, o
   * registo NÃO se abre para edição — abri-lo com outro esquema mudaria o
   * significado de respostas que ninguém voltou a dar.
   */
  originalDisponivel: boolean;
  aviso: string | undefined;
}

/**
 * Em que versão é que este registo está, e o que isso implica (F5.9).
 *
 * A regra da especificação §10: um registo criado com a versão 3 continua a
 * abrir com a versão 3 depois de sair a 4. A app avisa que há uma versão nova
 * — para o técnico saber que os registos novos vão ter perguntas diferentes —
 * e NÃO converte nada.
 *
 * Converter automaticamente seria o erro fácil de cometer aqui: um campo
 * removido na versão 4 desapareceria da resposta, e um campo renomeado passaria
 * a estar vazio. Uma migração de dados de campo não se faz sem alguém decidir.
 */
export async function estadoDaVersao(
  db: BaseLocal,
  recordId: string,
): Promise<EstadoDaVersao | undefined> {
  const linha = await db.getFirstAsync<{
    form_version_id: string;
    versao_do_registo: number | null;
    versao_corrente: number | null;
  }>(
    `SELECT r.form_version_id,
            v.version AS versao_do_registo,
            f.current_version AS versao_corrente
     FROM records r
     LEFT JOIN forms f ON f.id = r.form_id
     LEFT JOIN form_versions v ON v.id = r.form_version_id
     WHERE r.id = ?`,
    [recordId],
  );
  if (!linha) return undefined;

  const originalDisponivel = linha.versao_do_registo !== null;
  const desactualizado =
    linha.versao_do_registo !== null &&
    linha.versao_corrente !== null &&
    linha.versao_corrente > linha.versao_do_registo;

  return {
    doRegisto: linha.versao_do_registo,
    corrente: linha.versao_corrente,
    desactualizado,
    originalDisponivel,
    aviso: !originalDisponivel
      ? 'A definição com que este registo foi recolhido não está no telefone. Sincroniza antes de o abrir — abri-lo com outra versão mudaria o significado das respostas.'
      : desactualizado
        ? `Este registo foi recolhido com a versão ${linha.versao_do_registo}; já há a ${linha.versao_corrente}. Continua a abrir na versão original, de propósito. Registos novos usam a versão nova.`
        : undefined,
  };
}

export interface FiltroDeListagem {
  formId?: string;
  status?: RecordStatus;
  /** Texto a procurar nos campos marcados como `searchable`. */
  procura?: string;
  /** `id` dos campos pesquisáveis do formulário. */
  camposDeProcura?: string[];
  limite?: number;
  deslocamento?: number;
}

export interface LinhaDaListagem {
  id: string;
  form_id: string;
  status: RecordStatus;
  updated_at: string;
  synced: boolean;
  lat: number | null;
  lon: number | null;
  dados: RecordData;
}

/**
 * Listagem paginada (F4.3 e F4.4).
 *
 * A paginação não é opcional: 30 000 registos locais são normais num projecto
 * de cadastro, e carregá-los todos para a memória de um Android de gama baixa
 * enche-a.
 *
 * A ordenação desempata pelo `id`, e não é um detalhe: dois registos gravados
 * no mesmo milissegundo têm o mesmo `updated_at`, e sem desempate o SQLite
 * devolve-os por ordem arbitrária — o que faz uma lista paginada repetir uma
 * linha numa página e saltá-la na seguinte. Como os `id` são UUIDv7, o
 * desempate é pelo instante em que foram gerados, que é a ordem certa.
 */
export async function listarRegistos(
  db: BaseLocal,
  filtro: FiltroDeListagem = {},
): Promise<LinhaDaListagem[]> {
  const condicoes: string[] = ['r.deleted_at IS NULL'];
  const params: ValorLigado[] = [];

  if (filtro.formId) {
    condicoes.push('r.form_id = ?');
    params.push(filtro.formId);
  }
  if (filtro.status) {
    condicoes.push('r.status = ?');
    params.push(filtro.status);
  }

  const procura = filtro.procura?.trim().toLowerCase();
  if (procura) {
    // A forma desta condição foi medida, e a diferença é de 5x com 30 000
    // registos. Com `EXISTS (...)` correlacionado, o SQLite conduz a consulta
    // por `records` e faz uma sondagem ao índice por cada um dos 30 000 — o
    // plano mostra CORRELATED SCALAR SUBQUERY. Com `IN (subconsulta)`, varre o
    // índice UMA vez, que é uma tabela estreita, e depois vai buscar por chave
    // primária os poucos registos que sobraram.
    const camposFiltrados = filtro.camposDeProcura?.length
      ? ` AND field_id IN (${filtro.camposDeProcura.map(() => '?').join(',')})`
      : '';
    condicoes.push(
      `r.id IN (SELECT record_id FROM indice_de_procura
                WHERE valor LIKE ?${camposFiltrados})`,
    );
    params.push(`%${procura}%`, ...(filtro.camposDeProcura ?? []));
  }

  params.push(filtro.limite ?? 50, filtro.deslocamento ?? 0);

  const linhas = await db.getAllAsync<Record<string, unknown>>(
    `SELECT r.id, r.form_id, r.status, r.updated_at, r.synced, r.lat, r.lon, v.data
     FROM records r
     JOIN record_revisions v ON v.id = r.current_revision_id
     WHERE ${condicoes.join(' AND ')}
     ORDER BY r.updated_at DESC, r.id DESC
     LIMIT ? OFFSET ?`,
    params,
  );

  return linhas.map((l) => ({
    id: String(l['id']),
    form_id: String(l['form_id']),
    status: String(l['status']) as RecordStatus,
    updated_at: String(l['updated_at']),
    synced: l['synced'] === 1,
    lat: l['lat'] === null ? null : Number(l['lat']),
    lon: l['lon'] === null ? null : Number(l['lon']),
    dados: JSON.parse(String(l['data'])) as RecordData,
  }));
}

export async function contarRegistos(db: BaseLocal, formId?: string): Promise<number> {
  const linha = await db.getFirstAsync<{ n: number }>(
    formId
      ? `SELECT count(*) AS n FROM records WHERE deleted_at IS NULL AND form_id = ?`
      : `SELECT count(*) AS n FROM records WHERE deleted_at IS NULL`,
    formId ? [formId] : [],
  );
  return linha?.n ?? 0;
}

function paraRegisto(l: Record<string, unknown>): Registo {
  return {
    id: String(l['id']),
    org_id: String(l['org_id']),
    project_id: String(l['project_id']),
    form_id: String(l['form_id']),
    form_version_id: String(l['form_version_id']),
    current_revision_id:
      l['current_revision_id'] === null ? null : String(l['current_revision_id']),
    lat: l['lat'] === null ? null : Number(l['lat']),
    lon: l['lon'] === null ? null : Number(l['lon']),
    status: String(l['status']) as RecordStatus,
    created_by: l['created_by'] === null ? null : String(l['created_by']),
    client_created_at: String(l['client_created_at']),
    updated_at: String(l['updated_at']),
    deleted_at: l['deleted_at'] === null ? null : String(l['deleted_at']),
    synced: l['synced'] === 1,
  };
}

function paraRevisao(l: Record<string, unknown>): Revisao {
  return {
    id: String(l['id']),
    record_id: String(l['record_id']),
    revision_no: Number(l['revision_no']),
    form_version_id: String(l['form_version_id']),
    dados: JSON.parse(String(l['data'])) as RecordData,
    base_revision_id: l['base_revision_id'] === null ? null : String(l['base_revision_id']),
    device_id: l['device_id'] === null ? null : String(l['device_id']),
    client_created_at: String(l['client_created_at']),
    synced: l['synced'] === 1,
  };
}
