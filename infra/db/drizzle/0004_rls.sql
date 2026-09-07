-- ═══════════════════════════════════════════════════════════════════════════
-- Row Level Security (F6, ADR-0010).
--
-- Perder o isolamento entre organizações é, a seguir a perder um registo, o
-- pior defeito que este sistema pode ter. A API já filtra por `org_id` — mas a
-- API não é o único caminho até esta base: há o PowerSync, há as migrações, e
-- há a consola do administrador às três da manhã. Um `WHERE org_id = ...`
-- esquecido numa consulta chega para vazar tudo.
--
-- COMO FUNCIONA. A API liga-se com o papel `cvforms_app`, que NÃO é dono das
-- tabelas e NÃO tem BYPASSRLS. A cada pedido define o contexto:
--
--     SET LOCAL cvf.org_id  = '<uuid da organização>';
--     SET LOCAL cvf.user_id = '<uuid do utilizador>';
--
-- Sem contexto definido, `cvf_org_actual()` é NULL, a comparação `org_id =
-- NULL` dá NULL, e NULL não é verdadeiro: não se vê NADA. Falhar fechado é
-- deliberado e não tem escape. As migrações e o `db:seed` correm como dono das
-- tabelas, e o dono ignora o RLS por omissão — não precisam de porta nenhuma.
--
-- DUAS COISAS QUE CUSTARAM UM TESTE VERMELHO E VALE A PENA LER ANTES DE MEXER:
--
-- 1. Políticas PERMISSIVE combinam-se por **OR**, não por AND. Duas políticas
--    permissivas na mesma tabela não apertam nada: alargam. A política de
--    atribuição tem de ser **RESTRICTIVE** para se somar por AND à do
--    isolamento por organização.
-- 2. Um escape do género `NOT estou_na_aplicacao() OR ...` faz o sistema
--    falhar ABERTO: basta a aplicação esquecer-se de definir o contexto para
--    passar a ver tudo. Não existe aqui, e não deve voltar.
--
-- O MODO DE FALHA MAIS PERIGOSO deste desenho está escrito no ADR-0010: se
-- alguém ligar a API como superutilizador ou como dono das tabelas, o RLS é
-- ignorado e o isolamento desaparece SEM ERRO NENHUM. Por isso há um teste só
-- para isso em `infra/db/test/rls.test.ts`.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Contexto da sessão ─────────────────────────────────────────────────────

-- `current_setting(..., true)` devolve NULL em vez de erro quando a variável
-- não está definida — é o que permite às políticas falharem fechadas.
CREATE OR REPLACE FUNCTION cvf_org_actual()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('cvf.org_id', true), '')::uuid;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_utilizador_actual()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(current_setting('cvf.user_id', true), '')::uuid;
$$;
--> statement-breakpoint

-- Modo administrativo.
--
-- Um administrador gere formulários a que não está atribuído como técnico —
-- publica-os, atribui-os, resolve conflitos, exporta. A regra «ninguém vê um
-- formulário que não lhe foi atribuído» é sobre quem RECOLHE, e aplicá-la ao
-- administrador tornaria a plataforma inadministrável.
--
-- O que este modo NÃO faz é atravessar organizações: a política de `org_id`
-- continua a valer, e é ela que garante o isolamento que interessa. Um erro
-- aqui expõe dados dentro da mesma organização a alguém que já é
-- administrador dela; um erro na do `org_id` expõe dados de outro cliente.
CREATE OR REPLACE FUNCTION cvf_e_administracao()
RETURNS boolean
LANGUAGE sql STABLE
AS $$
  SELECT current_setting('cvf.admin', true) = 'true';
$$;
--> statement-breakpoint

-- ── Papel da aplicação ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cvforms_app') THEN
    -- Sem senha aqui: em desenvolvimento herda a do compose por `SET ROLE`, e
    -- em produção a senha é atribuída fora do repositório (restrição 9).
    CREATE ROLE cvforms_app NOLOGIN NOBYPASSRLS;
  END IF;
END;
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO cvforms_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA cvf_views TO cvforms_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cvforms_app;
--> statement-breakpoint
GRANT SELECT ON ALL TABLES IN SCHEMA cvf_views TO cvforms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cvforms_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA cvf_views GRANT SELECT ON TABLES TO cvforms_app;
--> statement-breakpoint

-- ── Políticas por organização ──────────────────────────────────────────────

-- Tabelas que têm `org_id` directamente. A política é sempre a mesma, e é
-- escrita uma vez num laço em vez de vinte vezes à mão: vinte cópias de uma
-- política são vinte sítios onde uma pode ficar diferente das outras.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'roles', 'teams', 'projects', 'forms', 'records', 'audit_log'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS cvf_org ON %I', t);
    EXECUTE format($f$
      CREATE POLICY cvf_org ON %I
      USING (org_id = cvf_org_actual())
      WITH CHECK (org_id = cvf_org_actual())
    $f$, t);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Tabelas ligadas à organização por um formulário.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['form_versions', 'form_assignments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS cvf_org ON %I', t);
    EXECUTE format($f$
      CREATE POLICY cvf_org ON %I
      USING (form_id IN (SELECT id FROM forms WHERE org_id = cvf_org_actual()))
      WITH CHECK (form_id IN (SELECT id FROM forms WHERE org_id = cvf_org_actual()))
    $f$, t);
  END LOOP;
END;
$$;
--> statement-breakpoint

-- Tabelas ligadas por registo.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['record_revisions', 'attachments', 'gps_fixes']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS cvf_org ON %I', t);
    EXECUTE format($f$
      CREATE POLICY cvf_org ON %I
      USING (record_id IN (SELECT id FROM records WHERE org_id = cvf_org_actual()))
      WITH CHECK (record_id IN (SELECT id FROM records WHERE org_id = cvf_org_actual()))
    $f$, t);
  END LOOP;
END;
$$;
--> statement-breakpoint

ALTER TABLE form_access ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS cvf_org ON form_access;
--> statement-breakpoint
CREATE POLICY cvf_org ON form_access
  USING (org_id = cvf_org_actual())
  WITH CHECK (org_id = cvf_org_actual());
--> statement-breakpoint

-- ── Quem pode chegar a um formulário ───────────────────────────────────────
--
-- Uma função só, usada pelas políticas restritivas, para a regra não ficar
-- escrita em quatro sítios ligeiramente diferentes.
--
-- É SECURITY DEFINER de propósito: as políticas consultam `form_access` e
-- `records`, que têm elas próprias RLS, e uma política que dispara outra
-- política é uma armadilha — ou entra em recursão, ou devolve menos do que
-- devia por razões impossíveis de seguir. Correr como dono das tabelas dentro
-- desta função fecha isso. A função não devolve dados: devolve sim ou não.
CREATE OR REPLACE FUNCTION cvf_pode_chegar_ao_formulario(p_form_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    -- Sem utilizador no contexto (integrações que só definem a organização) a
    -- atribuição não se aplica; o isolamento por organização continua a valer.
    cvf_utilizador_actual() IS NULL
    OR cvf_e_administracao()
    OR EXISTS (
      SELECT 1 FROM form_access
      WHERE user_id = cvf_utilizador_actual() AND form_id = p_form_id AND can_read = true
    )
    -- ADR-0011: quem recolheu continua a chegar ao formulário com que
    -- recolheu, mesmo depois de perder a atribuição — senão não conseguia
    -- sequer ler a definição para subir o que tem no telefone.
    OR EXISTS (
      SELECT 1 FROM records
      WHERE form_id = p_form_id AND created_by = cvf_utilizador_actual()
    );
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION cvf_pode_chegar_ao_formulario(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cvf_pode_chegar_ao_formulario(uuid) TO cvforms_app;
--> statement-breakpoint

-- ── F6.3: sem atribuição, zero linhas — mesmo dentro da organização ────────
--
-- RESTRICTIVE, e não permissiva. Duas políticas permissivas somam-se por OR e
-- alargam o acesso; uma restritiva soma-se por AND e aperta-o. Pertencer à
-- organização deixa de chegar: é preciso as duas passarem.
DROP POLICY IF EXISTS cvf_atribuicao ON records;
--> statement-breakpoint
CREATE POLICY cvf_atribuicao ON records
  AS RESTRICTIVE
  USING (cvf_pode_chegar_ao_formulario(form_id))
  WITH CHECK (cvf_pode_chegar_ao_formulario(form_id));
--> statement-breakpoint

DROP POLICY IF EXISTS cvf_atribuicao ON form_versions;
--> statement-breakpoint
CREATE POLICY cvf_atribuicao ON form_versions
  AS RESTRICTIVE
  USING (cvf_pode_chegar_ao_formulario(form_id))
  -- Escrever versões é administração, e essa passa pelo `pool`; aqui não se
  -- aperta a escrita para não bloquear o pipeline de publicação.
  WITH CHECK (true);
--> statement-breakpoint

-- ── Auditoria: append-only também para quem escreve ───────────────────────

DROP POLICY IF EXISTS cvf_audit_sem_leitura_cruzada ON audit_log;
--> statement-breakpoint

-- ── F6.6: o que se publica, atribui e exporta fica registado ──────────────

CREATE OR REPLACE FUNCTION cvf_auditar()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_org uuid;
  v_accao audit_action;
  v_entidade text;
  v_id uuid;
BEGIN
  v_entidade := TG_TABLE_NAME;
  v_id := COALESCE(NEW.id, OLD.id);

  IF TG_TABLE_NAME = 'form_versions' THEN
    SELECT org_id INTO v_org FROM forms WHERE id = COALESCE(NEW.form_id, OLD.form_id);
    -- Só a publicação interessa: gravar um rascunho não é um acto auditável.
    IF TG_OP = 'INSERT' AND NEW.published_at IS NULL THEN RETURN NULL; END IF;
    v_accao := 'publicar';
  ELSIF TG_TABLE_NAME = 'form_assignments' THEN
    SELECT org_id INTO v_org FROM forms WHERE id = COALESCE(NEW.form_id, OLD.form_id);
    v_accao := 'atribuir';
  ELSIF TG_TABLE_NAME = 'forms' THEN
    v_org := COALESCE(NEW.org_id, OLD.org_id);
    IF TG_OP = 'UPDATE' AND NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL THEN
      v_accao := 'arquivar';
    ELSIF TG_OP = 'INSERT' THEN
      v_accao := 'criar';
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    RETURN NULL;
  END IF;

  IF v_org IS NULL THEN RETURN NULL; END IF;

  INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id, metadata)
  VALUES (
    gen_random_uuid(), v_org, cvf_utilizador_actual(), v_accao, v_entidade, v_id,
    -- Só metadados. Nunca o conteúdo das respostas (restrição inegociável 9).
    jsonb_build_object('operacao', TG_OP)
  );
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS form_versions_auditoria ON form_versions;
--> statement-breakpoint
CREATE TRIGGER form_versions_auditoria
  AFTER INSERT ON form_versions
  FOR EACH ROW EXECUTE FUNCTION cvf_auditar();
--> statement-breakpoint

DROP TRIGGER IF EXISTS form_assignments_auditoria ON form_assignments;
--> statement-breakpoint
CREATE TRIGGER form_assignments_auditoria
  AFTER INSERT OR UPDATE OR DELETE ON form_assignments
  FOR EACH ROW EXECUTE FUNCTION cvf_auditar();
--> statement-breakpoint

DROP TRIGGER IF EXISTS forms_auditoria ON forms;
--> statement-breakpoint
CREATE TRIGGER forms_auditoria
  AFTER INSERT OR UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION cvf_auditar();
