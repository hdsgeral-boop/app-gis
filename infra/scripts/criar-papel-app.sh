#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
# Cria a senha do papel com que a API corre em produção.
#
# PORQUE É QUE ISTO NÃO ESTÁ NUMA MIGRAÇÃO. A migração 0004 cria o papel
# `cvforms_app` SEM senha, de propósito: uma senha numa migração é uma senha no
# repositório (restrição inegociável 9). Em desenvolvimento entra-se nele por
# `SET ROLE`; em produção alguém tem de lhe dar uma senha, e é isto.
#
# CORRE UMA VEZ, depois das migrações e antes de a API arrancar.
#
#   APP_DB_PASSWORD='...' sh infra/scripts/criar-papel-app.sh
# ═══════════════════════════════════════════════════════════════════════════
set -e

: "${APP_DB_PASSWORD:?falta APP_DB_PASSWORD}"
APP_DB_USER="${APP_DB_USER:-cvforms_app}"
COMPOSE="${COMPOSE:-docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.producao}"

echo "a dar senha ao papel ${APP_DB_USER}…"

$COMPOSE exec -T postgres psql -U "${POSTGRES_USER:-cvforms}" -d "${POSTGRES_DB:-cvforms}" \
  -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_DB_USER}') THEN
    RAISE EXCEPTION 'o papel ${APP_DB_USER} não existe. Corre as migrações primeiro.';
  END IF;
END;
\$\$;

ALTER ROLE ${APP_DB_USER} LOGIN PASSWORD '${APP_DB_PASSWORD}';

-- Confirmação: se qualquer um destes for verdadeiro, o RLS deixa de valer e o
-- isolamento entre organizações desaparece sem erro nenhum (ADR-0010).
DO \$\$
DECLARE r record;
BEGIN
  SELECT rolsuper, rolbypassrls INTO r FROM pg_roles WHERE rolname = '${APP_DB_USER}';
  IF r.rolsuper OR r.rolbypassrls THEN
    RAISE EXCEPTION '${APP_DB_USER} é superutilizador ou tem BYPASSRLS. A API NÃO pode correr assim.';
  END IF;
END;
\$\$;
SQL

echo "pronto. A API já pode arrancar com esse papel."
