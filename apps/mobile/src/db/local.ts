import { ESQUEMA_CAMADAS } from '../mapas/camadas';
import * as SQLite from 'expo-sqlite';

/**
 * SQLite local — a fonte de verdade da app.
 *
 * Restrição inegociável 2: a app escreve sempre primeiro aqui. Nenhum botão
 * «Guardar» faz uma chamada HTTP. A sincronização é uma consequência, nunca
 * uma condição para gravar.
 *
 * O esquema é FIXO e nunca muda quando se publica um formulário: as respostas
 * vivem em JSON numa só tabela, exactamente como no Postgres. É o que permite
 * publicar um formulário novo sem publicar uma versão nova da app.
 *
 * A partir da F5 estas tabelas passam a ser geridas pelo PowerSync. O esquema
 * é deliberadamente o mesmo, para que a passagem não obrigue a migrar dados
 * no telefone de ninguém.
 */
const NOME_DA_BASE = 'cvforms.db';

const ESQUEMA = [
  `PRAGMA journal_mode = WAL;`,

  // Uma linha por registo. Igual ao Postgres, menos o que só o servidor sabe.
  `CREATE TABLE IF NOT EXISTS records (
     id                  TEXT PRIMARY KEY,
     org_id              TEXT NOT NULL,
     project_id          TEXT NOT NULL,
     form_id             TEXT NOT NULL,
     form_version_id     TEXT NOT NULL,
     current_revision_id TEXT,
     lat                 REAL,
     lon                 REAL,
     status              TEXT NOT NULL DEFAULT 'rascunho',
     created_by          TEXT,
     client_created_at   TEXT NOT NULL,
     updated_at          TEXT NOT NULL,
     deleted_at          TEXT,
     -- 0 enquanto o servidor não confirmar. É o que distingue "gravado no
     -- telefone" de "seguro no servidor", e o que a lista mostra ao técnico.
     synced              INTEGER NOT NULL DEFAULT 0
   );`,

  // Append-only, como no servidor. Nunca há UPDATE nem DELETE aqui.
  `CREATE TABLE IF NOT EXISTS record_revisions (
     id                TEXT PRIMARY KEY,
     record_id         TEXT NOT NULL,
     revision_no       INTEGER NOT NULL,
     form_version_id   TEXT NOT NULL,
     data              TEXT NOT NULL,
     base_revision_id  TEXT,
     device_id         TEXT,
     client_created_at TEXT NOT NULL,
     synced            INTEGER NOT NULL DEFAULT 0,
     UNIQUE (record_id, revision_no)
   );`,

  // Definições descarregadas. Todas as versões, não só a corrente: um registo
  // criado com a versão 3 tem de continuar a abrir com a versão 3.
  `CREATE TABLE IF NOT EXISTS form_versions (
     id           TEXT PRIMARY KEY,
     form_id      TEXT NOT NULL,
     version      INTEGER NOT NULL,
     definition   TEXT NOT NULL,
     hash         TEXT NOT NULL,
     published_at TEXT,
     UNIQUE (form_id, version)
   );`,

  `CREATE TABLE IF NOT EXISTS forms (
     id              TEXT PRIMARY KEY,
     project_id      TEXT NOT NULL,
     key             TEXT NOT NULL,
     title           TEXT NOT NULL,
     current_version INTEGER,
     can_create      INTEGER NOT NULL DEFAULT 0,
     can_edit_own    INTEGER NOT NULL DEFAULT 0,
     can_edit_all    INTEGER NOT NULL DEFAULT 0,
     archived_at     TEXT
   );`,

  // Fila de anexos, separada da dos registos: o registo sincroniza mesmo com
  // fotos por subir (ESPECIFICACAO §10).
  `CREATE TABLE IF NOT EXISTS attachments (
     id           TEXT PRIMARY KEY,
     record_id    TEXT NOT NULL,
     revision_id  TEXT,
     field_id     TEXT NOT NULL,
     local_uri    TEXT NOT NULL,
     mime_type    TEXT,
     bytes        INTEGER,
     hash         TEXT,
     upload_state TEXT NOT NULL DEFAULT 'pendente',
     created_at   TEXT NOT NULL
   );`,

  // Todo o ponto guardado leva precisão, tipo e origem (restrição 8).
  `CREATE TABLE IF NOT EXISTS gps_fixes (
     id              TEXT PRIMARY KEY,
     record_id       TEXT NOT NULL,
     revision_id     TEXT,
     field_id        TEXT NOT NULL,
     lat             REAL NOT NULL,
     lon             REAL NOT NULL,
     alt             REAL,
     accuracy_m      REAL NOT NULL,
     fix_type        TEXT NOT NULL,
     source          TEXT NOT NULL,
     satellites      INTEGER,
     pdop            REAL,
     hdop            REAL,
     receiver_model  TEXT,
     collected_at    TEXT,
     synced          INTEGER NOT NULL DEFAULT 0
   );`,

  // Quem está autenticado e a que organização pertence. Sem isto, um registo
  // gravado offline não saberia a que organização pertence, e adivinhar é o
  // caminho mais curto para dados de campo na organização errada.
  `CREATE TABLE IF NOT EXISTS sessao (
     chave TEXT PRIMARY KEY,
     valor TEXT NOT NULL
   );`,

  // Rascunhos: trabalho a meio, que muda a cada tecla. Vive à parte das
  // revisões, que são factos imutáveis e vão todos subir (ver forms/rascunhos.ts).
  `CREATE TABLE IF NOT EXISTS rascunhos (
     record_id        TEXT PRIMARY KEY,
     form_id          TEXT NOT NULL,
     form_version_id  TEXT NOT NULL,
     form_version     INTEGER NOT NULL,
     data             TEXT NOT NULL,
     base_revision_id TEXT,
     seccao_actual    INTEGER NOT NULL DEFAULT 0,
     criado_em        TEXT NOT NULL,
     actualizado_em   TEXT NOT NULL
   );`,

  // Índice de procura: derivado e descartável, reconstrói-se das revisões.
  // Sem ele, procurar num telefone com 30 000 registos significa analisar
  // 30 000 objectos JSON a cada tecla (ver dados/registos.ts).
  `CREATE TABLE IF NOT EXISTS indice_de_procura (
     record_id TEXT NOT NULL,
     field_id  TEXT NOT NULL,
     valor     TEXT NOT NULL,
     PRIMARY KEY (record_id, field_id)
   );`,
  `CREATE INDEX IF NOT EXISTS indice_de_procura_valor ON indice_de_procura (valor);`,

  // A justificação de ter gravado acima do limiar de precisão pertence à
  // revisão em que foi escrita, e não ao registo (ESPECIFICACAO §11).
  `CREATE TABLE IF NOT EXISTS justificacoes_de_precisao (
     revision_id TEXT PRIMARY KEY,
     record_id   TEXT NOT NULL,
     motivo      TEXT NOT NULL,
     criado_em   TEXT NOT NULL
   );`,

  // O `id` faz parte do índice porque faz parte da ordenação: sem ele, o
  // SQLite serve o filtro pelo índice mas ordena 30 000 linhas em memória, e a
  // listagem passa dos 200 ms num telefone (ver dados/registos.ts).
  `CREATE INDEX IF NOT EXISTS records_form_idx ON records (form_id, updated_at DESC, id DESC);`,
  `CREATE INDEX IF NOT EXISTS records_por_sincronizar_idx ON records (synced) WHERE synced = 0;`,
  `CREATE INDEX IF NOT EXISTS revisions_record_idx ON record_revisions (record_id, revision_no);`,
  `CREATE INDEX IF NOT EXISTS attachments_estado_idx ON attachments (upload_state);`,

  // Camadas de mapa (F8). Ver `src/mapas/camadas.ts`.
  ESQUEMA_CAMADAS,
  `CREATE INDEX IF NOT EXISTS rascunhos_form_idx ON rascunhos (form_id, actualizado_em DESC);`,
];

let base: SQLite.SQLiteDatabase | undefined;

export async function abrirBaseLocal(): Promise<SQLite.SQLiteDatabase> {
  if (base) return base;
  const aberta = await SQLite.openDatabaseAsync(NOME_DA_BASE);
  for (const instrucao of ESQUEMA) {
    await aberta.execAsync(instrucao);
  }
  base = aberta;
  return aberta;
}

export interface ResumoLocal {
  rascunhos: number;
  registos: number;
  porSincronizar: number;
  formularios: number;
  anexosPendentes: number;
}

export async function resumoLocal(): Promise<ResumoLocal> {
  const db = await abrirBaseLocal();
  const linha = await db.getFirstAsync<ResumoLocal>(`
    SELECT
      (SELECT count(*) FROM records WHERE deleted_at IS NULL)        AS registos,
      (SELECT count(*) FROM records WHERE synced = 0)                AS porSincronizar,
      (SELECT count(*) FROM forms WHERE archived_at IS NULL)         AS formularios,
      (SELECT count(*) FROM attachments WHERE upload_state <> 'concluido') AS anexosPendentes,
      (SELECT count(*) FROM rascunhos)                               AS rascunhos
  `);
  return (
    linha ?? { registos: 0, porSincronizar: 0, formularios: 0, anexosPendentes: 0, rascunhos: 0 }
  );
}
