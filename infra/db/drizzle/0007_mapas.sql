-- ═══════════════════════════════════════════════════════════════════════════
-- Mapas offline: mosaicos PMTiles e camadas (F8, ADR-0005).
--
-- O QUE ISTO RESOLVE. Um técnico no Bengo, sem rede, tem de ver onde está e o
-- que já recolheu. A restrição inegociável 1 proíbe cachear mosaicos do Google
-- para uso offline — os termos da Google Maps Platform não o permitem — e por
-- isso o mapa offline é MapLibre com mosaicos próprios.
--
-- COMO CHEGAM AO TELEFONE, e é aqui que está a decisão:
--
--   1. **Pelo painel.** O administrador carrega um `.pmtiles` e diz a que
--      projecto pertence. A app descarrega-o sozinha quando houver Wi-Fi.
--   2. **À mão.** O técnico escolhe um ficheiro que já tenha no telefone. Um
--      mapa de uma província são centenas de MB, e obrigar toda a gente a
--      descarregá-los por rede móvel custa dinheiro a sério.
--
-- Os dois caminhos existem, e o telefone trata-os igual: o que interessa é o
-- ficheiro estar lá, não como lá chegou.
--
-- PORQUÊ PMTILES E NÃO MBTILES. O PMTiles é um ficheiro só, lê-se por
-- intervalos de bytes (HTTP range) e não precisa de servidor nem de SQLite. Um
-- MBTiles obriga a abrir uma base de dados por camada, e num Android de gama
-- baixa com a base do Consul Colect já aberta isso são dois motores de SQLite a
-- competir pela mesma memória. Ver ADR-0005.
--
-- O FICHEIRO NÃO PASSA PELA API. Sobe e desce directamente do armazenamento,
-- com URL assinado — a mesma decisão da F9.3, e pela mesma razão: 300 MB a
-- atravessar a API seguram a ligação durante minutos.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TYPE map_layer_kind AS ENUM (
  -- Mosaicos vectoriais ou de imagem, num ficheiro PMTiles.
  'pmtiles',
  -- Um estilo MapLibre (JSON) que aponta para mosaicos online. Só serve com
  -- rede, e é o que se usa no escritório.
  'estilo_online'
);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS map_layers (
  id            uuid PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  /**
   * NULL = a camada serve toda a organização. Com projecto, só quem tem
   * formulários desse projecto a recebe — um mapa do Uíge não tem que ocupar
   * 300 MB no telefone de quem trabalha em Luanda.
   */
  project_id    uuid REFERENCES projects (id) ON DELETE CASCADE,
  kind          map_layer_kind NOT NULL,
  name          text NOT NULL,
  description   text,
  /** Chave no armazenamento. NULL num `estilo_online`. */
  storage_key   text,
  /** URL do estilo MapLibre. NULL num `pmtiles`. */
  style_url     text,
  bytes         bigint,
  /** SHA-256 do ficheiro. É como a app sabe que já o tem. */
  sha256        text,
  /** `oeste,sul,este,norte` em WGS84, para se saber o que a camada cobre. */
  bounds        geometry(Polygon, 4326),
  min_zoom      smallint,
  max_zoom      smallint,
  /**
   * Camada que a app descarrega sozinha quando houver Wi-Fi. As outras ficam à
   * espera de alguém as escolher — um mapa de 300 MB não se impõe a ninguém.
   */
  auto_download boolean NOT NULL DEFAULT false,
  /** A que se mostra por baixo de tudo. Só uma por organização. */
  is_default    boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users (id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  archived_at   timestamptz,

  -- Um `pmtiles` sem ficheiro e um `estilo_online` sem URL são linhas que
  -- prometem um mapa e não o têm. A app mostraria uma camada que nunca carrega.
  CONSTRAINT map_layers_conteudo_ck CHECK (
    (kind = 'pmtiles' AND storage_key IS NOT NULL)
    OR (kind = 'estilo_online' AND style_url IS NOT NULL)
  ),
  CONSTRAINT map_layers_zoom_ck CHECK (
    min_zoom IS NULL OR max_zoom IS NULL OR min_zoom <= max_zoom
  )
);
--> statement-breakpoint

COMMENT ON TABLE map_layers IS
  'Camadas de mapa: mosaicos PMTiles para offline e estilos MapLibre para online. Nunca mosaicos do Google guardados (restrição inegociável 1).';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS map_layers_org_idx ON map_layers (org_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS map_layers_project_idx ON map_layers (project_id) WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS map_layers_bounds_idx ON map_layers USING GIST (bounds);
--> statement-breakpoint

-- Só uma camada por omissão por organização. Um índice parcial em vez de um
-- trigger: é o Postgres a garantir, e não a aplicação a lembrar-se.
CREATE UNIQUE INDEX IF NOT EXISTS map_layers_uma_por_omissao
  ON map_layers (org_id) WHERE is_default AND archived_at IS NULL;
--> statement-breakpoint

-- ── Acesso ─────────────────────────────────────────────────────────────────

ALTER TABLE map_layers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS cvf_org ON map_layers;
--> statement-breakpoint
CREATE POLICY cvf_org ON map_layers
  USING (org_id = cvf_org_actual())
  WITH CHECK (org_id = cvf_org_actual());
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON map_layers TO cvforms_app;
--> statement-breakpoint

-- ── Descida para o telefone ────────────────────────────────────────────────
--
-- As camadas vão pelo bucket da organização, que já existe. São poucas linhas
-- e mudam raramente; o que é grande é o ficheiro, e esse não passa aqui — o
-- telefone vai buscá-lo ao armazenamento com um URL assinado.
DROP PUBLICATION IF EXISTS powersync;
--> statement-breakpoint

CREATE PUBLICATION powersync FOR TABLE
  organizations, projects, users, forms, form_versions, form_access,
  form_access_scopes, records, record_revisions, attachments, map_layers;
