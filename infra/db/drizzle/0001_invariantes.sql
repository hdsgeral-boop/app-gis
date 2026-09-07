-- ═══════════════════════════════════════════════════════════════════════════
-- Invariantes do Consul Colect, aplicados pela base de dados.
--
-- Tudo o que está aqui podia estar na aplicação. Está aqui de propósito: a
-- API não é o único caminho até esta base (há o PowerSync, há migrações, há
-- a consola do administrador em pânico às três da manhã). Um invariante que
-- só existe em TypeScript é um invariante que se vai perder.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Índices que o Drizzle não exprime ──────────────────────────────────────

-- Consulta espacial: bbox no /records, e o QGIS a arrastar o mapa.
CREATE INDEX IF NOT EXISTS records_geom_gist ON records USING gist (geom);
--> statement-breakpoint

-- Pesquisa dentro das respostas sem tabela por formulário (ESPECIFICACAO §7).
-- jsonb_path_ops é ~3x mais pequeno que o GIN por omissão e serve @> , que é
-- o operador que as vistas e a pesquisa usam.
CREATE INDEX IF NOT EXISTS record_revisions_data_gin
  ON record_revisions USING gin (data jsonb_path_ops);
--> statement-breakpoint

-- Só uma revisão corrente por registo, e a listagem por formulário sem
-- varrer os apagados.
CREATE INDEX IF NOT EXISTS records_form_vivos_idx
  ON records (form_id, updated_at DESC) WHERE deleted_at IS NULL;
--> statement-breakpoint

-- ── Chaves adiadas que o Drizzle não consegue declarar ─────────────────────

-- records.current_revision_id ↔ record_revisions.record_id é circular:
-- a revisão precisa do registo e o registo aponta para a revisão. Adiável.
ALTER TABLE records
  ADD CONSTRAINT records_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES record_revisions(id)
  DEFERRABLE INITIALLY DEFERRED;
--> statement-breakpoint

ALTER TABLE record_revisions
  ADD CONSTRAINT record_revisions_base_fk
  FOREIGN KEY (base_revision_id) REFERENCES record_revisions(id);
--> statement-breakpoint

-- ── Restrição inegociável 8: todo o ponto leva precisão, tipo e origem ─────
-- As colunas já são NOT NULL. Isto impede o outro lado do buraco: valores
-- sentinela absurdos que passariam pelo NOT NULL.

ALTER TABLE gps_fixes
  ADD CONSTRAINT gps_fixes_precisao_plausivel
  CHECK (accuracy_m >= 0 AND accuracy_m < 100000);
--> statement-breakpoint

ALTER TABLE gps_fixes
  ADD CONSTRAINT gps_fixes_coordenadas_plausiveis
  CHECK (lat BETWEEN -90 AND 90 AND lon BETWEEN -180 AND 180);
--> statement-breakpoint

-- ── Restrição inegociável 4: nunca apagar nem sobrescrever uma revisão ─────

CREATE OR REPLACE FUNCTION cvf_revisao_e_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'record_revisions é append-only: % em % foi recusado. Cria uma revisão nova.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER record_revisions_sem_update
  BEFORE UPDATE ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_revisao_e_append_only();
--> statement-breakpoint

CREATE TRIGGER record_revisions_sem_delete
  BEFORE DELETE ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_revisao_e_append_only();
--> statement-breakpoint

-- O mesmo para o registo de auditoria.
CREATE TRIGGER audit_log_sem_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION cvf_revisao_e_append_only();
--> statement-breakpoint

CREATE TRIGGER audit_log_sem_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION cvf_revisao_e_append_only();
--> statement-breakpoint

-- Nunca há DELETE num registo: só soft delete com tombstone.
CREATE OR REPLACE FUNCTION cvf_registo_nao_se_apaga()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'records não se apaga: usa UPDATE records SET deleted_at = now().'
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint

CREATE TRIGGER records_sem_delete
  BEFORE DELETE ON records
  FOR EACH ROW EXECUTE FUNCTION cvf_registo_nao_se_apaga();
--> statement-breakpoint

-- ── Uma versão publicada é imutável (ESPECIFICACAO §4) ────────────────────
-- Rascunho (published_at IS NULL) pode mudar à vontade. Publicada, não.

CREATE OR REPLACE FUNCTION cvf_versao_publicada_e_imutavel()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.published_at IS NOT NULL THEN
    IF NEW.definition IS DISTINCT FROM OLD.definition
       OR NEW.hash IS DISTINCT FROM OLD.hash
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.form_id IS DISTINCT FROM OLD.form_id
       OR NEW.published_at IS DISTINCT FROM OLD.published_at THEN
      RAISE EXCEPTION
        'a versão %/% já foi publicada e é imutável. Publica a versão seguinte.',
        OLD.form_id, OLD.version
        USING ERRCODE = 'restrict_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER form_versions_imutavel
  BEFORE UPDATE ON form_versions
  FOR EACH ROW EXECUTE FUNCTION cvf_versao_publicada_e_imutavel();
--> statement-breakpoint

CREATE TRIGGER form_versions_sem_delete_publicada
  BEFORE DELETE ON form_versions
  FOR EACH ROW
  WHEN (OLD.published_at IS NOT NULL)
  EXECUTE FUNCTION cvf_revisao_e_append_only();
--> statement-breakpoint

-- ── updated_at mantido pela base, não pela aplicação ──────────────────────

CREATE OR REPLACE FUNCTION cvf_toca_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint

CREATE TRIGGER records_updated_at
  BEFORE UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION cvf_toca_updated_at();
--> statement-breakpoint

-- ── Esquema das vistas geradas ────────────────────────────────────────────
-- As projecções tipadas da §3 vivem fora do `public`, para que ninguém as
-- confunda com tabelas do sistema e para que o QGIS as veja agrupadas.

CREATE SCHEMA IF NOT EXISTS cvf_views;
--> statement-breakpoint

COMMENT ON SCHEMA cvf_views IS
  'Vistas tipadas geradas ao publicar uma versão de formulário. Descartáveis: podem ser recriadas a partir de form_versions. Nunca guardar aqui nada que não seja regenerável.';
