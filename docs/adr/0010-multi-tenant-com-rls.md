# ADR-0010 — Multi-tenant numa base, isolado por RLS

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

A plataforma serve várias organizações. Cada uma tem de ver exclusivamente os
seus dados. Perder esse isolamento é, a seguir a perder um registo, o pior
defeito que este sistema pode ter.

## Decisão

Uma base de dados, uma coluna `org_id` nas tabelas de topo, e **Row Level
Security no Postgres** — não apenas filtros na aplicação.

O isolamento é aplicado em três camadas independentes:

1. **RLS no Postgres** — a última linha, e a que vale mesmo.
2. **Sync rules do PowerSync** — buckets derivados do `org_id` do JWT e das
   `form_assignments`.
3. **API** — `/me` e as consultas filtram por `org_id` e por atribuição.

Três camadas porque um erro numa não pode ser suficiente para vazar dados de
uma organização para outra.

_As políticas RLS são escritas na F6. A migração `0001` prepara o terreno; o
`ESPECIFICACAO.md` §7 e o `PLANO.md` mandam._

## Alternativas rejeitadas

**Um schema por organização.** Isolamento mais forte e mais fácil de explicar.
Rejeitada porque multiplica as migrações por organização — e com o ADR-0001
já temos vistas geradas por formulário. Schemas por organização vezes vistas
por formulário é uma explosão que ninguém consegue operar com três pessoas.

**Uma base de dados por organização.** Isolamento máximo. Rejeitada pelo custo
de operação: cada organização passaria a exigir a sua instância de PowerSync,
os seus slots de replicação, as suas cópias de segurança. Torna cada cliente
novo um projecto de infraestrutura.

**Filtrar só na aplicação.** Rejeitada porque a API não é o único caminho até
esta base: o PowerSync escreve directamente, as migrações correm, e há a
consola do administrador. Um `WHERE org_id = ...` esquecido numa consulta seria
suficiente para vazar tudo.

## Consequências

**Ganhamos:** uma migração para todos os clientes; um serviço de sincronização;
custo de operação que não cresce por cliente; e um isolamento que não depende
de nenhum programador se lembrar de filtrar.

**Pagamos:**

- O RLS tem custo de desempenho, e um erro numa política é difícil de
  diagnosticar: os dados simplesmente não aparecem, sem erro nenhum.
- A API tem de correr com um papel de base de dados sujeito a RLS e definir o
  contexto da sessão a cada pedido. Se alguém ligar como superutilizador, o RLS
  é ignorado e o isolamento desaparece sem aviso — é o modo de falha mais
  perigoso deste desenho, e tem de ter teste próprio na F6.
- O `pnpm db:seed` e as migrações precisam de contornar o RLS, o que significa
  duas credenciais distintas com privilégios distintos.
- Um cliente que exija a base dentro da sua própria infraestrutura obriga a uma
  instalação separada. É suportável — mas deixa de ser multi-tenant para esse
  cliente.
