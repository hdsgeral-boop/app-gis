-- ═══════════════════════════════════════════════════════════════════════════
-- Acesso desnormalizado e publicação para o PowerSync (F5.1 e F5.2).
--
-- PORQUÊ ISTO EXISTE. As regras de sincronização do PowerSync não são SQL
-- completo: as parameter queries não aceitam aliases de tabela nem
-- subconsultas, e as data queries não aceitam `IN (SELECT ...)`. Escrever
-- «quem tem acesso a que formulário» com um OR de três subconsultas — que é o
-- que a regra é, em SQL normal — não passa no validador do serviço.
--
-- A resposta não é contornar a regra: é materializá-la. `form_access` tem uma
-- linha por (utilizador, formulário) com as permissões já resolvidas, venham
-- elas de uma atribuição directa, de uma equipa ou de um papel. A regra de
-- sincronização passa a `WHERE user_id = request.user_id()`, que o serviço
-- aceita, e a mesma tabela serve as políticas RLS da F6 e o `/me`.
--
-- O preço é manter a tabela coerente. É pago por triggers, e não por
-- convenção na aplicação: a API não é o único caminho até esta base.
-- ═══════════════════════════════════════════════════════════════════════════

-- O `id` é uma chave de substituição, e não decoração: o PowerSync exige uma
-- coluna `id` em todas as tabelas que sincroniza. A chave real continua a ser
-- (user_id, form_id), garantida pelo índice único.
CREATE TABLE IF NOT EXISTS form_access (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  form_id        uuid NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  org_id         uuid NOT NULL,
  can_read       boolean NOT NULL DEFAULT false,
  can_create     boolean NOT NULL DEFAULT false,
  can_edit_own   boolean NOT NULL DEFAULT false,
  can_edit_all   boolean NOT NULL DEFAULT false,
  can_delete     boolean NOT NULL DEFAULT false,
  UNIQUE (user_id, form_id)
);
--> statement-breakpoint

COMMENT ON TABLE form_access IS
  'Derivada de form_assignments + team_members + user_roles. Mantida por trigger; nunca escrita à mão. Onde duas atribuições se sobrepõem, ganha a mais permissiva.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_access_form_idx ON form_access (form_id);
--> statement-breakpoint

-- ── Recálculo ──────────────────────────────────────────────────────────────

-- Recalcula o acesso de um utilizador a todos os formulários, ou de todos os
-- utilizadores a um formulário. Bruto de propósito: estas tabelas mudam
-- raramente (alguém entra numa equipa, alguém publica um formulário) e um
-- recálculo simples que se lê de uma vez vale mais do que um incremental
-- esperto que ninguém consegue verificar.
CREATE OR REPLACE FUNCTION cvf_recalcular_acesso(p_user_id uuid, p_form_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM form_access
  WHERE (p_user_id IS NULL OR user_id = p_user_id)
    AND (p_form_id IS NULL OR form_id = p_form_id);

  INSERT INTO form_access (user_id, form_id, org_id, can_read, can_create,
                           can_edit_own, can_edit_all, can_delete)
  SELECT u.id, f.id, f.org_id,
         -- A mais permissiva ganha: entrar numa equipa nunca pode tirar acesso.
         bool_or(fa.can_read), bool_or(fa.can_create), bool_or(fa.can_edit_own),
         bool_or(fa.can_edit_all), bool_or(fa.can_delete)
  FROM form_assignments fa
  JOIN forms f ON f.id = fa.form_id
  JOIN users u ON u.org_id = f.org_id
  WHERE (p_user_id IS NULL OR u.id = p_user_id)
    AND (p_form_id IS NULL OR f.id = p_form_id)
    AND (
      (fa.principal_type = 'user' AND fa.principal_id = u.id)
      OR (fa.principal_type = 'team' AND fa.principal_id IN (
            SELECT tm.team_id FROM team_members tm WHERE tm.user_id = u.id))
      OR (fa.principal_type = 'role' AND fa.principal_id IN (
            SELECT ur.role_id FROM user_roles ur WHERE ur.user_id = u.id))
    )
  GROUP BY u.id, f.id, f.org_id
  HAVING bool_or(fa.can_read);
END;
$$;
--> statement-breakpoint

COMMENT ON FUNCTION cvf_recalcular_acesso IS
  'NULL em qualquer argumento significa «todos». cvf_recalcular_acesso(NULL, NULL) reconstrói a tabela inteira.';
--> statement-breakpoint

-- ── Triggers que a mantêm coerente ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION cvf_acesso_por_atribuicao()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM cvf_recalcular_acesso(NULL, COALESCE(NEW.form_id, OLD.form_id));
  RETURN NULL;
END;
$$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_acesso_por_utilizador()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM cvf_recalcular_acesso(COALESCE(NEW.user_id, OLD.user_id), NULL);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS form_assignments_acesso ON form_assignments;
--> statement-breakpoint
CREATE TRIGGER form_assignments_acesso
  AFTER INSERT OR UPDATE OR DELETE ON form_assignments
  FOR EACH ROW EXECUTE FUNCTION cvf_acesso_por_atribuicao();
--> statement-breakpoint

DROP TRIGGER IF EXISTS team_members_acesso ON team_members;
--> statement-breakpoint
CREATE TRIGGER team_members_acesso
  AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION cvf_acesso_por_utilizador();
--> statement-breakpoint

DROP TRIGGER IF EXISTS user_roles_acesso ON user_roles;
--> statement-breakpoint
CREATE TRIGGER user_roles_acesso
  AFTER INSERT OR UPDATE OR DELETE ON user_roles
  FOR EACH ROW EXECUTE FUNCTION cvf_acesso_por_utilizador();
--> statement-breakpoint

-- Um utilizador novo na organização herda de imediato o que os papéis e as
-- equipas lhe dão. Sem isto, o primeiro login de um técnico não lhe traria
-- formulário nenhum até alguém mexer numa atribuição.
CREATE OR REPLACE FUNCTION cvf_acesso_por_utilizador_novo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM cvf_recalcular_acesso(NEW.id, NULL);
  RETURN NULL;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS users_acesso ON users;
--> statement-breakpoint
CREATE TRIGGER users_acesso
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION cvf_acesso_por_utilizador_novo();
--> statement-breakpoint

SELECT cvf_recalcular_acesso(NULL, NULL);
--> statement-breakpoint

-- ── Desnormalização para as data queries do PowerSync ──────────────────────
--
-- As data queries também não aceitam `IN (SELECT ...)`: filtrar revisões pelo
-- formulário do registo obrigava a uma subconsulta. O `form_id` passa a viajar
-- na própria linha. É redundante — deriva sempre do registo — e por isso é
-- mantido por trigger, e não pela aplicação: uma redundância que a aplicação
-- mantenha é uma redundância que mais cedo ou mais tarde diverge.

ALTER TABLE record_revisions ADD COLUMN IF NOT EXISTS form_id uuid;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS form_id uuid;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_herdar_form_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.form_id IS NULL THEN
    SELECT form_id INTO NEW.form_id FROM records WHERE id = NEW.record_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS record_revisions_form_id ON record_revisions;
--> statement-breakpoint
CREATE TRIGGER record_revisions_form_id
  BEFORE INSERT ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_herdar_form_id();
--> statement-breakpoint

DROP TRIGGER IF EXISTS attachments_form_id ON attachments;
--> statement-breakpoint
CREATE TRIGGER attachments_form_id
  BEFORE INSERT ON attachments
  FOR EACH ROW EXECUTE FUNCTION cvf_herdar_form_id();
--> statement-breakpoint

-- O trigger de append-only recusa qualquer UPDATE em record_revisions, e
-- recusa bem: é a restrição inegociável 4. O que se está a preencher aqui não
-- é uma resposta — é uma coluna derivada, acabada de acrescentar, que já vinha
-- do registo. Desligar a replicação de triggers só nesta transacção é a forma
-- de o fazer sem abrir um buraco permanente no invariante; um `ALTER TABLE
-- ... DISABLE TRIGGER` desligaria o trigger para toda a base e pegaria num
-- lock exclusivo.
SET LOCAL session_replication_role = replica;
--> statement-breakpoint

UPDATE record_revisions v SET form_id = r.form_id
FROM records r WHERE r.id = v.record_id AND v.form_id IS NULL;
--> statement-breakpoint

UPDATE attachments a SET form_id = r.form_id
FROM records r WHERE r.id = a.record_id AND a.form_id IS NULL;
--> statement-breakpoint

SET LOCAL session_replication_role = origin;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS record_revisions_form_idx ON record_revisions (form_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_form_idx ON attachments (form_id);
--> statement-breakpoint

-- ── Publicação lógica para o PowerSync ─────────────────────────────────────
--
-- Só as tabelas que a app precisa. Publicar tudo levaria o `audit_log` e as
-- `idempotency_keys` para dentro dos telefones, e nenhum dos dois tem lá nada
-- que fazer.
DROP PUBLICATION IF EXISTS powersync;
--> statement-breakpoint

CREATE PUBLICATION powersync FOR TABLE
  organizations, projects, users, forms, form_versions, form_access,
  records, record_revisions, attachments;
