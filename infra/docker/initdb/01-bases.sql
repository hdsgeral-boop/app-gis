-- Corre uma só vez, quando o volume do Postgres é criado de raiz.
-- O Keycloak precisa da sua própria base; as extensões do Consul Colect são criadas
-- pela primeira migração, não aqui, para que o `pnpm db:migrate` seja a única
-- fonte da verdade do esquema.
CREATE DATABASE keycloak OWNER cvforms;
