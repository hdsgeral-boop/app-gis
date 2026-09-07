import type { BaseLocal } from '../forms/definicoes';

/**
 * Camadas de mapa no telefone (F8, ADR-0005).
 *
 * O QUE ESTE MÓDULO DECIDE, e que é a parte difícil da F8:
 *
 * 1. **Que camada usar.** A que o técnico escolheu; senão a que o
 *    administrador marcou como fundo; senão nenhuma — e nesse caso o mapa
 *    mostra os pontos sobre cinzento em vez de mentir com um mapa online que
 *    não vai carregar.
 * 2. **Quando descarregar.** Só as marcadas como automáticas, só em Wi-Fi, e
 *    só quando há espaço. Um mapa de 300 MB por rede móvel custa dinheiro real
 *    ao técnico, e um telefone cheio deixa de gravar registos — que é muito
 *    pior do que ficar sem mapa.
 * 3. **Se o ficheiro que está cá é o certo.** Pelo hash. Um download
 *    interrompido deixa um ficheiro com o tamanho errado, e um PMTiles
 *    truncado não dá erro: dá um mapa que carrega metade e pára.
 *
 * O ficheiro NÃO passa pela API: vem directamente do armazenamento com um URL
 * assinado, como os anexos (F9.3).
 */

export const ESQUEMA_CAMADAS = `
  CREATE TABLE IF NOT EXISTS map_layers (
    id            TEXT PRIMARY KEY,
    nome          TEXT NOT NULL,
    descricao     TEXT,
    tipo          TEXT NOT NULL,
    project_id    TEXT,
    style_url     TEXT,
    bytes         INTEGER,
    sha256        TEXT,
    zoom_min      INTEGER,
    zoom_max      INTEGER,
    descarga_auto INTEGER NOT NULL DEFAULT 0,
    por_omissao   INTEGER NOT NULL DEFAULT 0,
    -- Caminho local do ficheiro já descarregado. NULL = ainda não está cá.
    ficheiro_uri  TEXT,
    -- Bytes já escritos, para se saber o que falta sem abrir o ficheiro.
    bytes_locais  INTEGER,
    origem        TEXT NOT NULL DEFAULT 'servidor',
    actualizado_em TEXT
  );
  CREATE INDEX IF NOT EXISTS map_layers_projecto_idx ON map_layers (project_id);
`;

export interface CamadaLocal {
  id: string;
  nome: string;
  descricao: string | null;
  tipo: 'pmtiles' | 'estilo_online';
  project_id: string | null;
  style_url: string | null;
  bytes: number | null;
  sha256: string | null;
  zoom_min: number | null;
  zoom_max: number | null;
  descarga_auto: boolean;
  por_omissao: boolean;
  ficheiro_uri: string | null;
  bytes_locais: number | null;
  /** `servidor` veio do painel; `manual` foi o técnico que a escolheu. */
  origem: 'servidor' | 'manual';
}

interface LinhaDeCamada {
  id: string;
  nome: string;
  descricao: string | null;
  tipo: string;
  project_id: string | null;
  style_url: string | null;
  bytes: number | null;
  sha256: string | null;
  zoom_min: number | null;
  zoom_max: number | null;
  descarga_auto: number;
  por_omissao: number;
  ficheiro_uri: string | null;
  bytes_locais: number | null;
  origem: string;
}

function daLinha(l: LinhaDeCamada): CamadaLocal {
  return {
    id: l.id,
    nome: l.nome,
    descricao: l.descricao,
    tipo: l.tipo === 'estilo_online' ? 'estilo_online' : 'pmtiles',
    project_id: l.project_id,
    style_url: l.style_url,
    bytes: l.bytes,
    sha256: l.sha256,
    zoom_min: l.zoom_min,
    zoom_max: l.zoom_max,
    descarga_auto: l.descarga_auto === 1,
    por_omissao: l.por_omissao === 1,
    ficheiro_uri: l.ficheiro_uri,
    bytes_locais: l.bytes_locais,
    origem: l.origem === 'manual' ? 'manual' : 'servidor',
  };
}

/** O que o servidor diz que existe. */
export interface CamadaRemota {
  id: string;
  nome: string;
  descricao: string | null;
  tipo: 'pmtiles' | 'estilo_online';
  projecto_id: string | null;
  bytes: number | null;
  sha256: string | null;
  zoom_min: number | null;
  zoom_max: number | null;
  style_url: string | null;
  descarga_automatica: boolean;
  por_omissao: boolean;
}

/**
 * Guarda a lista que veio do servidor, sem perder o que já está descarregado.
 *
 * O `ficheiro_uri` e o `bytes_locais` NÃO são tocados: a lista do servidor diz
 * o que existe, não o que este telefone já tem. Apagá-los aqui obrigaria a
 * descarregar 300 MB outra vez a cada sincronização.
 *
 * As camadas que o técnico escolheu à mão também não são tocadas — o servidor
 * não sabe delas e não tem que saber.
 */
export async function guardarCamadas(db: BaseLocal, remotas: CamadaRemota[]): Promise<void> {
  for (const c of remotas) {
    await db.runAsync(
      `INSERT INTO map_layers (id, nome, descricao, tipo, project_id, style_url, bytes, sha256,
                               zoom_min, zoom_max, descarga_auto, por_omissao, origem, actualizado_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'servidor', ?)
       ON CONFLICT(id) DO UPDATE SET
         nome = excluded.nome, descricao = excluded.descricao, tipo = excluded.tipo,
         project_id = excluded.project_id, style_url = excluded.style_url,
         bytes = excluded.bytes, sha256 = excluded.sha256,
         zoom_min = excluded.zoom_min, zoom_max = excluded.zoom_max,
         descarga_auto = excluded.descarga_auto, por_omissao = excluded.por_omissao,
         actualizado_em = excluded.actualizado_em`,
      [
        c.id,
        c.nome,
        c.descricao,
        c.tipo,
        c.projecto_id,
        c.style_url,
        c.bytes,
        c.sha256,
        c.zoom_min,
        c.zoom_max,
        c.descarga_automatica ? 1 : 0,
        c.por_omissao ? 1 : 0,
        new Date().toISOString(),
      ],
    );
  }

  // Uma camada que o servidor deixou de anunciar é arquivada, e não apagada:
  // o ficheiro pode estar cá e ainda servir. Perde-se a linha do servidor, não
  // o mapa que o técnico tem.
  const ids = remotas.map((c) => c.id);
  const marcadores = ids.map(() => '?').join(',');
  await db.runAsync(
    ids.length
      ? `UPDATE map_layers SET origem = 'manual'
         WHERE origem = 'servidor' AND ficheiro_uri IS NOT NULL AND id NOT IN (${marcadores})`
      : `UPDATE map_layers SET origem = 'manual'
         WHERE origem = 'servidor' AND ficheiro_uri IS NOT NULL`,
    ids,
  );
  await db.runAsync(
    ids.length
      ? `DELETE FROM map_layers WHERE origem = 'servidor' AND ficheiro_uri IS NULL AND id NOT IN (${marcadores})`
      : `DELETE FROM map_layers WHERE origem = 'servidor' AND ficheiro_uri IS NULL`,
    ids,
  );
}

/** Regista um ficheiro que o técnico escolheu no telefone. */
export async function acrescentarCamadaManual(
  db: BaseLocal,
  camada: { id: string; nome: string; uri: string; bytes: number },
): Promise<void> {
  await db.runAsync(
    `INSERT INTO map_layers (id, nome, tipo, ficheiro_uri, bytes, bytes_locais, origem, actualizado_em)
     VALUES (?, ?, 'pmtiles', ?, ?, ?, 'manual', ?)
     ON CONFLICT(id) DO UPDATE SET
       nome = excluded.nome, ficheiro_uri = excluded.ficheiro_uri,
       bytes = excluded.bytes, bytes_locais = excluded.bytes_locais`,
    [camada.id, camada.nome, camada.uri, camada.bytes, camada.bytes, new Date().toISOString()],
  );
}

export async function listarCamadas(db: BaseLocal, projectId?: string): Promise<CamadaLocal[]> {
  const linhas = await db.getAllAsync<LinhaDeCamada>(
    projectId
      ? `SELECT * FROM map_layers WHERE project_id IS NULL OR project_id = ? ORDER BY por_omissao DESC, nome`
      : `SELECT * FROM map_layers ORDER BY por_omissao DESC, nome`,
    projectId ? [projectId] : [],
  );
  return linhas.map(daLinha);
}

/** Só as que estão mesmo prontas a desenhar. */
export async function camadasDisponiveis(db: BaseLocal): Promise<CamadaLocal[]> {
  const todas = await listarCamadas(db);
  return todas.filter((c) => estaPronta(c));
}

/**
 * Uma camada está pronta quando se pode desenhar com ela AGORA.
 *
 * Um `pmtiles` com o ficheiro a meio não conta: um PMTiles truncado não dá
 * erro nenhum — dá um mapa que carrega metade e pára, e quem está no terreno
 * conclui que a área não tem mapa.
 */
export function estaPronta(camada: CamadaLocal): boolean {
  if (camada.tipo === 'estilo_online') return Boolean(camada.style_url);
  if (!camada.ficheiro_uri) return false;
  if (camada.bytes && camada.bytes_locais && camada.bytes_locais < camada.bytes) return false;
  return true;
}

/**
 * A camada de fundo a usar.
 *
 * Pela ordem: a que o técnico escolheu, a que o administrador marcou, e nada.
 * Devolver uma camada online quando não há rede seria pior do que não devolver
 * nenhuma — o ecrã ficava à espera de mosaicos que nunca chegam, sem dizer
 * porquê.
 */
export async function camadaDeFundo(
  db: BaseLocal,
  escolhida?: string,
): Promise<CamadaLocal | undefined> {
  const prontas = await camadasDisponiveis(db);
  if (escolhida) {
    const dela = prontas.find((c) => c.id === escolhida);
    if (dela) return dela;
  }
  return prontas.find((c) => c.por_omissao && c.tipo === 'pmtiles') ?? prontas[0];
}

/** O que ainda falta descarregar, por ordem do que é mais pequeno. */
export async function porDescarregar(db: BaseLocal): Promise<CamadaLocal[]> {
  const todas = await listarCamadas(db);
  return todas
    .filter((c) => c.tipo === 'pmtiles' && c.origem === 'servidor' && !estaPronta(c))
    .sort((a, b) => (a.bytes ?? 0) - (b.bytes ?? 0));
}

export async function marcarDescarregada(
  db: BaseLocal,
  id: string,
  uri: string,
  bytes: number,
): Promise<void> {
  await db.runAsync(`UPDATE map_layers SET ficheiro_uri = ?, bytes_locais = ? WHERE id = ?`, [
    uri,
    bytes,
    id,
  ]);
}

/**
 * Esquece o ficheiro de uma camada, para libertar espaço.
 *
 * A linha fica: o técnico pode voltar a descarregá-la, e uma camada que
 * desaparecesse da lista ao ser apagada obrigaria a sincronizar outra vez só
 * para a ver.
 */
export async function esquecerFicheiro(db: BaseLocal, id: string): Promise<void> {
  await db.runAsync(`UPDATE map_layers SET ficheiro_uri = NULL, bytes_locais = NULL WHERE id = ?`, [
    id,
  ]);
}

/** Quanto espaço os mapas ocupam neste telefone. */
export async function espacoOcupado(db: BaseLocal): Promise<number> {
  const linha = await db.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(bytes_locais) AS total FROM map_layers WHERE ficheiro_uri IS NOT NULL`,
    [],
  );
  return linha?.total ?? 0;
}
