-- ═══════════════════════════════════════════════════════════════════════════
-- Arquivo de revisões antigas (F10.8, dívida do ADR-0007).
--
-- LÊ ISTO ANTES DE MEXER. Esta migração toca no invariante mais importante do
-- sistema — a restrição inegociável 4, «nunca apagar nem sobrescrever uma
-- revisão» — e é preciso perceber exactamente o que muda e o que não muda.
--
-- O QUE NÃO MUDA: nenhuma revisão se perde, nenhuma se altera. O conteúdo de
-- uma revisão arquivada continua a existir, byte a byte, em
-- `record_revisions_frias`, e é lido pela vista `record_revisions_todas` como
-- se nunca tivesse saído.
--
-- O QUE MUDA: a linha deixa de ocupar espaço na tabela quente. E o trigger que
-- recusava TODOS os DELETE passa a recusar todos **menos um**: aquele em que
-- já existe uma cópia fria cujo SHA-256 do conteúdo bate certo com o original.
-- O trigger não acredita em ninguém — vai lá verificar, na mesma transacção.
--
-- Isto é MAIS apertado do que o que existia antes desta migração, e não menos:
-- até aqui, quem quisesse apagar uma revisão bastava-lhe pôr
-- `session_replication_role = replica` na sessão, que é o que a própria
-- migração 0003 faz para preencher colunas derivadas. Essa porta continua
-- aberta (é do Postgres, não nossa), mas o caminho normal passou a ser um que
-- verifica em vez de confiar.
--
-- NADA DISTO CORRE SOZINHO. Não há cron, não há trigger periódico, não há
-- chamada na API. `cvf_arquivar_revisoes` só faz alguma coisa se alguém a
-- chamar, e a decisão de a chamar é do dono do projecto — quando o disco doer,
-- e não antes. Ver ADR-0012.
--
-- O QUE NUNCA É ARQUIVADO, e porquê:
--   - a revisão corrente de um registo — é o que se mostra no ecrã;
--   - qualquer revisão de um registo em `needs_review` — está por decidir, e
--     decidir sem ver os dois ramos é decidir às cegas;
--   - revisões com anexos — o ficheiro no armazenamento aponta para elas, e
--     quebrar essa ligação deixa o ficheiro órfão;
--   - revisões com pontos GNSS — são a prova da qualidade da recolha e vivem
--     em `gps_fixes`, que aponta para elas;
--   - qualquer coisa mais recente do que o corte que quem chama indicar.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Onde as revisões antigas passam a viver ────────────────────────────────

CREATE TABLE IF NOT EXISTS record_revisions_frias (
  id                       uuid PRIMARY KEY,
  record_id                uuid NOT NULL,
  form_id                  uuid,
  revision_no              integer NOT NULL,
  form_version_id          uuid NOT NULL,
  data                     jsonb NOT NULL,
  author_id                uuid,
  device_id                text,
  base_revision_id         uuid,
  client_created_at        timestamptz,
  server_received_at       timestamptz NOT NULL,
  accuracy_override_reason text,
  scope_value              text,
  /**
   * SHA-256 do `data::text`. É o que o trigger verifica antes de deixar sair a
   * linha quente: sem isto, «arquivar» seria uma promessa e não uma garantia.
   */
  conteudo_sha256          text NOT NULL,
  arquivada_em             timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

COMMENT ON TABLE record_revisions_frias IS
  'Revisões antigas, movidas por cvf_arquivar_revisoes. O conteúdo é idêntico ao original e é verificado por hash antes de a linha quente sair. Ler por record_revisions_todas.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS record_revisions_frias_record_idx
  ON record_revisions_frias (record_id, revision_no);
--> statement-breakpoint

-- Sem chaves estrangeiras de propósito: uma tabela de arquivo que dependa das
-- tabelas quentes não se pode mover para outro tablespace nem exportar
-- sozinha, que é exactamente para o que existe.

-- O hash é escrito num sítio só. Duas expressões iguais em dois sítios
-- divergem, e quando divergirem o trigger passa a recusar arquivos legítimos
-- sem ninguém perceber porquê.
CREATE OR REPLACE FUNCTION cvf_hash_da_revisao(p_data jsonb)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$
  SELECT encode(sha256(convert_to(p_data::text, 'UTF8')), 'hex');
$$;
--> statement-breakpoint

-- ── Ler o histórico sem saber onde ele está ────────────────────────────────

CREATE OR REPLACE VIEW record_revisions_todas AS
  SELECT id, record_id, form_id, revision_no, form_version_id, data, author_id,
         device_id, base_revision_id, client_created_at, server_received_at,
         accuracy_override_reason, scope_value, false AS arquivada
  FROM record_revisions
  UNION ALL
  SELECT id, record_id, form_id, revision_no, form_version_id, data, author_id,
         device_id, base_revision_id, client_created_at, server_received_at,
         accuracy_override_reason, scope_value, true AS arquivada
  FROM record_revisions_frias;
--> statement-breakpoint

COMMENT ON VIEW record_revisions_todas IS
  'Histórico completo, quente e frio. É por aqui que o painel lê as revisões de um registo — arquivar não pode fazer desaparecer histórico de um ecrã.';
--> statement-breakpoint

-- ── O trigger passa a verificar em vez de recusar sempre ───────────────────

CREATE OR REPLACE FUNCTION cvf_revisao_so_sai_arquivada()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_hash_frio text;
BEGIN
  SELECT conteudo_sha256 INTO v_hash_frio
  FROM record_revisions_frias WHERE id = OLD.id;

  IF v_hash_frio IS NULL THEN
    RAISE EXCEPTION
      'record_revisions é append-only: a revisão % não tem cópia arquivada. Usa cvf_arquivar_revisoes.',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- A cópia existe, mas existe IGUAL? Uma cópia truncada ou alterada é pior do
  -- que não haver cópia nenhuma: dá a sensação de que os dados estão salvos.
  IF v_hash_frio IS DISTINCT FROM cvf_hash_da_revisao(OLD.data) THEN
    RAISE EXCEPTION
      'a cópia arquivada da revisão % não confere com o original; nada foi apagado',
      OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN OLD;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS record_revisions_sem_delete ON record_revisions;
--> statement-breakpoint
CREATE TRIGGER record_revisions_sem_delete
  BEFORE DELETE ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_revisao_so_sai_arquivada();
--> statement-breakpoint

-- O UPDATE continua a ser recusado sempre. Não há nenhum caso legítimo de
-- alterar uma revisão gravada, e por isso não há excepção nenhuma para abrir.

-- ── A cadeia de `base_revision_id` deixa de ser uma chave estrangeira ──────
--
-- ISTO FOI APANHADO POR UM TESTE, e vale a pena perceber porquê antes de o
-- desfazer. `record_revisions.base_revision_id` referenciava a própria tabela
-- (migração 0001). Com essa chave estrangeira, arquivar é IMPOSSÍVEL de
-- princípio: a revisão corrente nunca é arquivada, aponta para a anterior, e
-- essa passa a não poder sair — e a seguinte à dessa também não, por diante
-- até ao início. O arquivo arquivaria sempre zero linhas.
--
-- O que a chave garantia era que `base_revision_id` aponta para uma revisão
-- que existe. Isso continua a ser verdade e continua a ser garantido: só que
-- «existe» passou a querer dizer «está na tabela quente OU no arquivo», e uma
-- chave estrangeira não sabe exprimir isso. Passa a ser um trigger, que
-- verifica a mesma coisa no momento em que interessa — quando a revisão é
-- inserida.
--
-- A diferença prática: uma linha de arquivo que alguém apague à mão deixa de
-- ser detectada. É o preço, e está aqui escrito.

ALTER TABLE record_revisions DROP CONSTRAINT IF EXISTS record_revisions_base_fk;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_base_da_revisao_existe()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.base_revision_id IS NULL THEN RETURN NEW; END IF;

  IF NOT EXISTS (SELECT 1 FROM record_revisions WHERE id = NEW.base_revision_id)
     AND NOT EXISTS (SELECT 1 FROM record_revisions_frias WHERE id = NEW.base_revision_id) THEN
    RAISE EXCEPTION
      'base_revision_id % não corresponde a nenhuma revisão, nem quente nem arquivada',
      NEW.base_revision_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS record_revisions_base_existe ON record_revisions;
--> statement-breakpoint
CREATE TRIGGER record_revisions_base_existe
  BEFORE INSERT ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_base_da_revisao_existe();
--> statement-breakpoint

-- ── Arquivar ───────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION cvf_arquivar_revisoes(
  p_form_id uuid,
  p_antes_de timestamptz,
  p_limite integer DEFAULT 1000
)
RETURNS TABLE (arquivadas bigint, registos_tocados bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids uuid[];
BEGIN
  IF p_antes_de IS NULL THEN
    RAISE EXCEPTION 'cvf_arquivar_revisoes precisa de uma data de corte explícita';
  END IF;
  -- Um corte no futuro arquivaria trabalho acabado de chegar. Preferir
  -- rebentar a fazer isso em silêncio.
  IF p_antes_de > now() - interval '30 days' THEN
    RAISE EXCEPTION
      'a data de corte tem de estar a mais de 30 dias: % é demasiado recente', p_antes_de;
  END IF;

  SELECT array_agg(v.id) INTO v_ids
  FROM (
    SELECT v.id
    FROM record_revisions v
    JOIN records r ON r.id = v.record_id
    WHERE v.server_received_at < p_antes_de
      AND (p_form_id IS NULL OR r.form_id = p_form_id)
      -- É o que se mostra no ecrã.
      AND v.id IS DISTINCT FROM r.current_revision_id
      -- Está por decidir; decidir sem ver os dois ramos é decidir às cegas.
      AND r.status <> 'needs_review'
      -- O ficheiro no armazenamento aponta para esta revisão.
      AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.revision_id = v.id)
      -- A prova da qualidade da recolha aponta para esta revisão.
      AND NOT EXISTS (SELECT 1 FROM gps_fixes g WHERE g.revision_id = v.id)
      -- Uma revisão base de outra MAIS RECENTE do que o corte fica: quem
      -- olhar para a tabela quente tem de conseguir seguir a cadeia da
      -- revisão corrente para trás pelo menos até ao corte.
      AND NOT EXISTS (
        SELECT 1 FROM record_revisions f
        WHERE f.base_revision_id = v.id AND f.server_received_at >= p_antes_de
      )
    ORDER BY v.server_received_at
    LIMIT GREATEST(p_limite, 0)
  ) v;

  IF v_ids IS NULL THEN
    RETURN QUERY SELECT 0::bigint, 0::bigint;
    RETURN;
  END IF;

  -- Copiar primeiro. Se isto falhar, não se apagou nada.
  INSERT INTO record_revisions_frias (
    id, record_id, form_id, revision_no, form_version_id, data, author_id,
    device_id, base_revision_id, client_created_at, server_received_at,
    accuracy_override_reason, scope_value, conteudo_sha256
  )
  SELECT v.id, v.record_id, v.form_id, v.revision_no, v.form_version_id, v.data,
         v.author_id, v.device_id, v.base_revision_id, v.client_created_at,
         v.server_received_at, v.accuracy_override_reason, v.scope_value,
         cvf_hash_da_revisao(v.data)
  FROM record_revisions v
  WHERE v.id = ANY (v_ids)
  ON CONFLICT (id) DO NOTHING;

  -- E só depois apagar. O trigger confere a cópia linha a linha; se alguma não
  -- conferir, a transacção inteira cai e nada se perde.
  DELETE FROM record_revisions WHERE id = ANY (v_ids);

  RETURN QUERY
    SELECT cardinality(v_ids)::bigint,
           (SELECT count(DISTINCT record_id) FROM record_revisions_frias WHERE id = ANY (v_ids));
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION cvf_arquivar_revisoes IS
  'Move revisões antigas para record_revisions_frias, com verificação por hash. Não corre sozinha: alguém tem de a chamar. Ver ADR-0012.';
--> statement-breakpoint

-- ── Quanto é que isto pouparia ─────────────────────────────────────────────
--
-- Para se poder decidir com um número em vez de com uma intuição. Não arquiva
-- nada; só conta.
CREATE OR REPLACE FUNCTION cvf_arquivo_possivel(p_antes_de timestamptz)
RETURNS TABLE (revisoes bigint, bytes bigint)
LANGUAGE sql STABLE
AS $$
  SELECT count(*)::bigint,
         COALESCE(sum(pg_column_size(v.data)), 0)::bigint
  FROM record_revisions v
  JOIN records r ON r.id = v.record_id
  WHERE v.server_received_at < p_antes_de
    AND v.id IS DISTINCT FROM r.current_revision_id
    AND r.status <> 'needs_review'
    AND NOT EXISTS (SELECT 1 FROM attachments a WHERE a.revision_id = v.id)
    AND NOT EXISTS (SELECT 1 FROM gps_fixes g WHERE g.revision_id = v.id);
$$;
--> statement-breakpoint

-- ── Acesso ─────────────────────────────────────────────────────────────────

ALTER TABLE record_revisions_frias ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS cvf_org ON record_revisions_frias;
--> statement-breakpoint
CREATE POLICY cvf_org ON record_revisions_frias
  USING (record_id IN (SELECT id FROM records WHERE org_id = cvf_org_actual()))
  WITH CHECK (record_id IN (SELECT id FROM records WHERE org_id = cvf_org_actual()));
--> statement-breakpoint

GRANT SELECT ON record_revisions_frias TO cvforms_app;
--> statement-breakpoint
GRANT SELECT ON record_revisions_todas TO cvforms_app;
--> statement-breakpoint

-- Arquivar é uma operação de manutenção, e corre com o dono das tabelas. O
-- papel da aplicação lê o arquivo e não o escreve: nenhum pedido HTTP deve
-- poder tirar uma revisão da tabela quente.
REVOKE EXECUTE ON FUNCTION cvf_arquivar_revisoes(uuid, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cvf_arquivo_possivel(timestamptz) TO cvforms_app;
