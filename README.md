# Consul Colect

Plataforma de formulários e recolha de dados georreferenciados.

**O formulário é dado, não código.** Desenha-se no painel web, o backend
provisiona tudo sozinho, e a app móvel constrói os ecrãs a partir de JSON sem
nunca ter sido recompilada para esse formulário.

```
Administrador desenha o formulário no painel
        ↓
Backend valida, versiona e provisiona (vistas PostGIS, manifesto, índices)
        ↓
App móvel descarrega a definição em JSON e constrói os ecrãs sozinha
        ↓
Técnico recolhe offline; sincroniza quando há rede
        ↓
Dados em PostGIS, API, exportações e QGIS/ArcGIS/Power BI
```

## Arrancar

Precisas de Node 22+, pnpm 10+ e Docker.

```bash
pnpm install
cp .env.example .env
pnpm infra:up      # Postgres+PostGIS, Keycloak, PowerSync, MinIO
pnpm db:migrate
pnpm db:seed
pnpm dev           # API em :4000, painel em :3000
```

Entra em http://localhost:3000 com `admin.demo` / `demo`.

## Estrutura

```
apps/api            NestJS + Fastify
apps/admin          Next.js — painel e construtor de formulários
apps/mobile         React Native + Expo (dev build; o Expo Go não serve)
packages/form-core  definição, validador, avaliador, diff, XLSForm — PARTILHADO
packages/ui         componentes partilhados (vazio até fazer falta)
infra/db            esquema Drizzle, migrações, seed
infra/docker        docker-compose, realm do Keycloak
infra/powersync     configuração e sync rules
```

## Documentação

| Documento                                | O que é                                                           |
| ---------------------------------------- | ----------------------------------------------------------------- |
| [`ESPECIFICACAO.md`](ESPECIFICACAO.md)   | A especificação. Manda em tudo.                                   |
| [`CLAUDE.md`](CLAUDE.md)                 | Como correr, como testar, convenções, erros a não repetir.        |
| [`docs/FORM-SPEC.md`](docs/FORM-SPEC.md) | O contrato entre as três aplicações. O documento mais importante. |
| [`docs/adr/`](docs/adr/0000-indice.md)   | Uma decisão estrutural por ficheiro, com os custos assumidos.     |
| [`PLANO.md`](PLANO.md)                   | F0 a F10, em tarefas de meio dia.                                 |

## Testes

```bash
pnpm turbo run typecheck test build
```

Os testes de base de dados precisam de `DATABASE_URL` apontada a um Postgres
**com PostGIS**. Sem ela são saltados, não falham.

## Estado

F0 concluída: andaimes, compose, esquema com invariantes por trigger,
autenticação ponta a ponta nas três aplicações, CI. A seguir é a F1
(`packages/form-core`). Ver [`PLANO.md`](PLANO.md).
