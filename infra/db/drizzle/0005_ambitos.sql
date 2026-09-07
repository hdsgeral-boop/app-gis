-- ═══════════════════════════════════════════════════════════════════════════
-- Âmbitos: um técnico do Bengo não vê registos do Uíge (F6.4).
--
-- A coluna `form_assignments.scope_filter` existia desde a migração 0000 e não
-- era lida por ninguém. Enquanto assim foi, atribuir um formulário a alguém
-- dava-lhe TODOS os registos desse formulário na organização — que é
-- exactamente o contrário do que a coluna prometia a quem a lia no esquema.
--
-- COMO FUNCIONA, e porquê assim:
--
-- 1. O âmbito de um registo é a resposta a UM campo, declarado no formulário
--    (`forms.scope_field_id`). É um `id` de campo, e não um nome de coluna nem
--    um `if` — a restrição inegociável 6 proíbe código específico de um
--    formulário, e isto tem de funcionar igual para «município», «distrito» ou
--    «linha de transporte».
--
-- 2. Essa resposta é desnormalizada para `records.scope_value` por trigger.
--    Sem isso, cada linha avaliada pela política teria de ir buscar a revisão
--    corrente e destapar o JSONB — dentro de uma política RLS, que corre uma
--    vez por linha. Com a coluna, é uma comparação de texto sobre um índice.
--
-- 3. A atribuição diz que valores é que a pessoa vê
--    (`scope_filter = {"valores": ["Bengo", "Dande"]}`), e isso é resolvido
--    para `form_access.scope_values` pelo mesmo recálculo que já resolve as
--    permissões. Onde duas atribuições se sobrepõem, ganha a mais permissiva:
--    uma atribuição sem filtro apaga o filtro das outras, porque é isso que
--    «mais permissiva» quer dizer.
--
-- 4. `form_access_scopes` tem uma linha por valor permitido. Existe pela mesma
--    razão que `form_access` existe: as parameter queries do PowerSync não
--    sabem percorrer um array. Sem esta tabela, o filtro valeria na API e no
--    RLS e **não valeria na descida para o telefone** — que é o caminho por
--    onde os registos chegam ao técnico, ou seja, o único que interessava.
--
-- FALHA FECHADA. Um registo cujo campo de âmbito esteja por responder tem
-- `scope_value` a NULL, e `NULL = ANY (...)` não é verdadeiro: quem tem filtro
-- não o vê. É deliberado — um registo sem âmbito conhecido não pode ser
-- atribuído a um âmbito — e quem o recolheu continua a vê-lo pela regra do
-- ADR-0011.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── O campo que define o âmbito ────────────────────────────────────────────

ALTER TABLE forms ADD COLUMN IF NOT EXISTS scope_field_id text;
--> statement-breakpoint

COMMENT ON COLUMN forms.scope_field_id IS
  'Id do campo cuja resposta define o âmbito de um registo. NULL = formulário sem âmbito. É um id de campo, nunca um nome de coluna.';
--> statement-breakpoint

ALTER TABLE records ADD COLUMN IF NOT EXISTS scope_value text;
--> statement-breakpoint

COMMENT ON COLUMN records.scope_value IS
  'Desnormalizado da revisão corrente por trigger. Existe para a política RLS não ter de destapar o JSONB uma vez por linha.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS records_form_scope_idx ON records (form_id, scope_value);
--> statement-breakpoint

-- O âmbito segue SEMPRE a revisão corrente, e não a última inserida: com um
-- conflito por resolver há duas revisões vivas, e a que conta é a que o
-- registo aponta.
CREATE OR REPLACE FUNCTION cvf_herdar_ambito()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_campo text;
BEGIN
  SELECT scope_field_id INTO v_campo FROM forms WHERE id = NEW.form_id;

  IF v_campo IS NULL OR NEW.current_revision_id IS NULL THEN
    NEW.scope_value := NULL;
    RETURN NEW;
  END IF;

  SELECT data ->> v_campo INTO NEW.scope_value
  FROM record_revisions WHERE id = NEW.current_revision_id;

  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS records_ambito ON records;
--> statement-breakpoint
CREATE TRIGGER records_ambito
  BEFORE INSERT OR UPDATE ON records
  FOR EACH ROW EXECUTE FUNCTION cvf_herdar_ambito();
--> statement-breakpoint

-- ── O que cada atribuição deixa ver ────────────────────────────────────────

-- Um `scope_filter` malformado não pode passar despercebido: sem esta
-- restrição, um `{"valores": "Bengo"}` (texto em vez de lista) daria um array
-- vazio no recálculo e a pessoa deixava de ver tudo, sem erro nenhum.
ALTER TABLE form_assignments DROP CONSTRAINT IF EXISTS form_assignments_scope_filter_ck;
--> statement-breakpoint
ALTER TABLE form_assignments ADD CONSTRAINT form_assignments_scope_filter_ck
  CHECK (scope_filter IS NULL OR jsonb_typeof(scope_filter -> 'valores') = 'array');
--> statement-breakpoint

ALTER TABLE form_access ADD COLUMN IF NOT EXISTS scope_values text[];
--> statement-breakpoint

COMMENT ON COLUMN form_access.scope_values IS
  'NULL = sem restrição de âmbito. Um array = só estes valores. Um array vazio = nenhum, que é o que sai de um filtro sem valores.';
--> statement-breakpoint

-- Uma linha por valor permitido, para as parameter queries do PowerSync, que
-- não sabem percorrer um array.
CREATE TABLE IF NOT EXISTS form_access_scopes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  form_id     uuid NOT NULL REFERENCES forms (id) ON DELETE CASCADE,
  org_id      uuid NOT NULL,
  scope_value text NOT NULL,
  UNIQUE (user_id, form_id, scope_value)
);
--> statement-breakpoint

COMMENT ON TABLE form_access_scopes IS
  'Derivada de form_access.scope_values, uma linha por valor. Mantida pelo mesmo recálculo; nunca escrita à mão.';
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS form_access_scopes_user_idx ON form_access_scopes (user_id);
--> statement-breakpoint

-- Junta os filtros de várias atribuições. Um filtro sem lista de valores dá
-- uma lista vazia — ou seja, não vê nada — em vez de dar tudo. É a diferença
-- entre falhar fechado e falhar aberto, e não há maneira de a esconder num
-- COALESCE.
CREATE OR REPLACE FUNCTION cvf_juntar_ambitos(p_filtros jsonb[])
RETURNS text[]
LANGUAGE sql IMMUTABLE
AS $$
  SELECT COALESCE(array_agg(DISTINCT v), ARRAY[]::text[])
  FROM unnest(p_filtros) AS f,
       LATERAL jsonb_array_elements_text(
         CASE WHEN jsonb_typeof(f -> 'valores') = 'array' THEN f -> 'valores' ELSE '[]'::jsonb END
       ) AS v;
$$;
--> statement-breakpoint

-- ── Recálculo, agora também com o âmbito ───────────────────────────────────

CREATE OR REPLACE FUNCTION cvf_recalcular_acesso(p_user_id uuid, p_form_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM form_access
  WHERE (p_user_id IS NULL OR user_id = p_user_id)
    AND (p_form_id IS NULL OR form_id = p_form_id);

  INSERT INTO form_access (user_id, form_id, org_id, can_read, can_create,
                           can_edit_own, can_edit_all, can_delete, scope_values)
  SELECT u.id, f.id, f.org_id,
         -- A mais permissiva ganha: entrar numa equipa nunca pode tirar acesso.
         bool_or(fa.can_read), bool_or(fa.can_create), bool_or(fa.can_edit_own),
         bool_or(fa.can_edit_all), bool_or(fa.can_delete),
         -- E o mesmo para o âmbito: uma atribuição sem filtro é mais
         -- permissiva do que qualquer filtro, e apaga-os a todos.
         CASE WHEN bool_or(fa.scope_filter IS NULL) THEN NULL
              ELSE cvf_juntar_ambitos(array_agg(fa.scope_filter))
         END
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

  DELETE FROM form_access_scopes
  WHERE (p_user_id IS NULL OR user_id = p_user_id)
    AND (p_form_id IS NULL OR form_id = p_form_id);

  INSERT INTO form_access_scopes (user_id, form_id, org_id, scope_value)
  SELECT a.user_id, a.form_id, a.org_id, v
  FROM form_access a, LATERAL unnest(a.scope_values) AS v
  WHERE a.scope_values IS NOT NULL
    AND (p_user_id IS NULL OR a.user_id = p_user_id)
    AND (p_form_id IS NULL OR a.form_id = p_form_id);
END;
$$;
--> statement-breakpoint

SELECT cvf_recalcular_acesso(NULL, NULL);
--> statement-breakpoint

-- ── A política ─────────────────────────────────────────────────────────────

-- Substitui a `cvf_atribuicao` de `records`: passa a decidir por registo e não
-- só por formulário. Continua RESTRICTIVE, pelo motivo que está na 0004 — uma
-- política permissiva escrita para apertar o acesso ALARGA-o.
CREATE OR REPLACE FUNCTION cvf_pode_ver_registo(
  p_form_id uuid, p_scope_value text, p_created_by uuid
)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT cvf_pode_chegar_ao_formulario(p_form_id)
    AND (
      cvf_utilizador_actual() IS NULL
      OR cvf_e_administracao()
      -- Quem recolheu vê o que recolheu, aconteça o que acontecer à atribuição
      -- (ADR-0011). Sem isto, mudar o âmbito de alguém escondia-lhe trabalho
      -- que ainda estava por sincronizar.
      OR p_created_by = cvf_utilizador_actual()
      OR EXISTS (
        SELECT 1 FROM form_access
        WHERE user_id = cvf_utilizador_actual()
          AND form_id = p_form_id
          AND (scope_values IS NULL OR p_scope_value = ANY (scope_values))
      )
    );
$$;
--> statement-breakpoint

REVOKE EXECUTE ON FUNCTION cvf_pode_ver_registo(uuid, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION cvf_pode_ver_registo(uuid, text, uuid) TO cvforms_app;
--> statement-breakpoint

DROP POLICY IF EXISTS cvf_atribuicao ON records;
--> statement-breakpoint
CREATE POLICY cvf_atribuicao ON records
  AS RESTRICTIVE
  USING (cvf_pode_ver_registo(form_id, scope_value, created_by))
  WITH CHECK (cvf_pode_ver_registo(form_id, scope_value, created_by));
--> statement-breakpoint

-- ── O âmbito na revisão e no anexo ────────────────────────────────────────
--
-- A descida do PowerSync precisa de filtrar por âmbito, e uma data query tem
-- de cobrir TODOS os parâmetros do seu bucket. Sem estas colunas, o bucket dos
-- registos podia ser filtrado por âmbito e o das revisões não — e as revisões
-- são onde as respostas estão. O filtro valeria para a lista e não para os
-- dados, que é o mesmo que não valer.
--
-- O âmbito de uma revisão sai dos SEUS PRÓPRIOS dados, e não do registo. É
-- intrínseco e imutável, e por isso não obriga a tocar numa revisão já
-- gravada — a restrição inegociável 4 fica de pé, sem excepção nenhuma.
--
-- O invariante que isto tem de garantir é um só: **se o registo desce, a
-- revisão corrente desce com ele.** É verdade por construção, porque
-- `records.scope_value` é copiado da revisão corrente. Revisões antigas de
-- outro âmbito não descem, e não fazem falta para mostrar o estado actual.

ALTER TABLE record_revisions ADD COLUMN IF NOT EXISTS scope_value text;
--> statement-breakpoint
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS scope_value text;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS record_revisions_form_scope_idx
  ON record_revisions (form_id, scope_value);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS attachments_form_scope_idx
  ON attachments (form_id, scope_value);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION cvf_ambito_da_revisao()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_campo text;
BEGIN
  -- Os triggers BEFORE disparam por ordem alfabética do nome, e este corre
  -- antes do que preenche o `form_id`. Daí ir buscá-lo ao registo.
  SELECT f.scope_field_id INTO v_campo
  FROM forms f
  WHERE f.id = COALESCE(NEW.form_id, (SELECT form_id FROM records WHERE id = NEW.record_id));

  IF v_campo IS NOT NULL THEN
    NEW.scope_value := NEW.data ->> v_campo;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS record_revisions_ambito ON record_revisions;
--> statement-breakpoint
CREATE TRIGGER record_revisions_ambito
  BEFORE INSERT ON record_revisions
  FOR EACH ROW EXECUTE FUNCTION cvf_ambito_da_revisao();
--> statement-breakpoint

-- O anexo herda o âmbito da revisão que o gerou; sem revisão, o do registo.
CREATE OR REPLACE FUNCTION cvf_ambito_do_anexo()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.revision_id IS NOT NULL THEN
    SELECT scope_value INTO NEW.scope_value FROM record_revisions WHERE id = NEW.revision_id;
  ELSE
    SELECT scope_value INTO NEW.scope_value FROM records WHERE id = NEW.record_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS attachments_ambito ON attachments;
--> statement-breakpoint
CREATE TRIGGER attachments_ambito
  BEFORE INSERT ON attachments
  FOR EACH ROW EXECUTE FUNCTION cvf_ambito_do_anexo();
--> statement-breakpoint

-- ── O campo de âmbito declara-se antes de haver registos ──────────────────
--
-- Mudá-lo depois obrigaria a reescrever o `scope_value` de revisões já
-- gravadas, e uma revisão não se reescreve (restrição inegociável 4). A
-- alternativa — abrir uma excepção no trigger de append-only «só para colunas
-- derivadas» — custa mais do que vale: quem precisar mesmo de mudar o âmbito
-- de um formulário com registos publica um formulário novo.
CREATE OR REPLACE FUNCTION cvf_ambito_nao_muda_com_registos()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.scope_field_id IS DISTINCT FROM OLD.scope_field_id
     AND EXISTS (SELECT 1 FROM records WHERE form_id = NEW.id) THEN
    RAISE EXCEPTION
      'o campo de âmbito de um formulário com registos não se altera: o âmbito das revisões já gravadas não pode ser recalculado sem as reescrever'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS forms_ambito_estavel ON forms;
--> statement-breakpoint
CREATE TRIGGER forms_ambito_estavel
  BEFORE UPDATE ON forms
  FOR EACH ROW EXECUTE FUNCTION cvf_ambito_nao_muda_com_registos();
--> statement-breakpoint

-- ── Grants e replicação ────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON form_access_scopes TO cvforms_app;
--> statement-breakpoint

ALTER TABLE form_access_scopes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
DROP POLICY IF EXISTS cvf_org ON form_access_scopes;
--> statement-breakpoint
CREATE POLICY cvf_org ON form_access_scopes
  USING (org_id = cvf_org_actual())
  WITH CHECK (org_id = cvf_org_actual());
--> statement-breakpoint

DROP PUBLICATION IF EXISTS powersync;
--> statement-breakpoint

CREATE PUBLICATION powersync FOR TABLE
  organizations, projects, users, forms, form_versions, form_access,
  form_access_scopes, records, record_revisions, attachments;
