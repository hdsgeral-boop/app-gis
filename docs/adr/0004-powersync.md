# ADR-0004 — PowerSync para a sincronização

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

A app tem de funcionar dias inteiros sem rede e sincronizar quando houver.
Precisamos de SQLite no telefone, Postgres no servidor, sincronização
bidireccional, fila de upload que sobrevive ao fecho da app e ao reinício do
telefone, e resolução de conflitos que nunca perca trabalho de campo.

## Decisão

**PowerSync (Open Edition, auto-hospedado.)** Os buckets derivam dos claims do
JWT e das `form_assignments`; as sync rules vivem em
`infra/powersync/sync-rules.yaml` e são escritas uma vez.

## Alternativas rejeitadas

**Sincronização escrita por nós, sobre a API REST.** É o caminho aparentemente
mais simples e o que dá mais controlo. Rejeitada porque a parte difícil da
sincronização não é transferir dados: é a retoma depois de um corte a meio do
upload, a ordenação causal, a detecção de conflitos, e a fila que sobrevive ao
sistema operativo a matar a app. São meses de trabalho para uma equipa de três
pessoas, e cada defeito custa registos de campo perdidos.

**ElectricSQL.** Modelo próximo e tecnicamente atraente. Rejeitada por
maturidade e por o modelo de escrita ter mudado mais do que gostaríamos para
uma base sobre a qual vamos construir anos de trabalho.

**WatermelonDB.** Boa camada local, mas a sincronização é um protocolo que
temos de implementar dos dois lados — cai no primeiro problema.

**CouchDB/PouchDB.** Sincronização resolvida e provada. Rejeitada porque
obrigaria a abandonar o Postgres e o PostGIS, e com eles as vistas tipadas do
ADR-0001 e toda a ligação ao QGIS. Custo demasiado alto.

## Consequências

**Ganhamos:** a parte mais difícil do sistema é resolvida por quem a resolve a
sério; as sync rules são declarativas e legíveis; auto-hospedado, sem
dependência de um serviço externo para o funcionamento.

**Pagamos:**

- Mais um serviço para operar, monitorizar e actualizar. Para uma equipa de
  três pessoas, isso conta.
- O PowerSync exige `wal_level=logical` e slots de replicação. Um slot parado
  faz o WAL crescer até encher o disco — é uma forma de tirar a base do ar que
  não existiria sem ele, e tem de estar na monitorização desde o primeiro dia.
- As sync rules são uma segunda expressão das regras de acesso, a par do RLS e
  do `/me`. Três sítios que têm de concordar. Mitigamos com testes que provam
  a concordância (F6), mas o risco de divergência existe.
- A Open Edition não tem tudo o que a versão paga tem. Se um dia precisarmos de
  algo que só lá está, a decisão volta à mesa.
