# ADR-0012 — Arquivo de revisões antigas

**Estado:** aceite · **Data:** 2026-09-06 · **Fecha a dívida do** ADR-0007

## Contexto

O ADR-0007 escolheu revisões append-only e assumiu a conta: «a base cresce e
não encolhe. Um registo editado vinte vezes tem vinte revisões, com o JSONB
inteiro em cada uma.»

Com números de campo: um formulário de cadastro com 40 campos dá um `data` de
2 a 4 kB. Trinta técnicos, trinta registos por dia, com uma média de três
revisões cada — são ~3 500 revisões por dia, ~10 MB por dia, ~3,5 GB por ano
só de revisões, sem contar índices. Num plano de alojamento com 40 GB isso
importa, e importa mais depressa do que parece porque o WAL e os backups
crescem com ele.

A restrição inegociável 4 diz: **nunca apagar nem sobrescrever uma revisão**.
Qualquer solução tem de conviver com isso, não de a contornar.

## Decisão

Uma revisão antiga pode **mudar de tabela**, e só isso. O conteúdo continua a
existir, byte a byte, em `record_revisions_frias`. A vista
`record_revisions_todas` junta as duas, e quem lê histórico lê por lá — do
ponto de vista de um ecrã, nada mudou.

O que muda é o trigger de `DELETE` em `record_revisions`. Até aqui recusava
sempre; passa a recusar **excepto** quando já existe uma cópia fria cujo
SHA-256 do `data` bate certo com o original. O trigger não acredita em ninguém:
verifica, na mesma transacção, linha a linha. Se uma só não conferir, a
transacção inteira cai e nada se perde.

`cvf_arquivar_revisoes(form_id, antes_de, limite)` copia, verifica e só depois
apaga. **Nunca arquiva**:

| Não arquiva                              | Porquê                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| a revisão corrente                       | é o que se mostra no ecrã                                     |
| revisões de um registo `needs_review`    | está por decidir; decidir sem ver os ramos é decidir às cegas |
| revisões com anexos                      | o ficheiro no armazenamento aponta para elas                  |
| revisões com pontos GNSS                 | `gps_fixes` é a prova da qualidade da recolha                 |
| base de uma revisão ainda não arquivável | a cadeia de `base_revision_id` tem de se poder seguir         |
| qualquer coisa com menos de 30 dias      | a função recusa uma data de corte recente                     |

**Nada disto corre sozinho.** Não há cron, não há trigger periódico, não há
rota na API. O papel da aplicação (`cvforms_app`) tem `SELECT` no arquivo e
**não** tem `EXECUTE` na função de arquivar: nenhum pedido HTTP consegue tirar
uma revisão da tabela quente. Arquivar é uma operação de manutenção, corre com
o dono das tabelas, e a decisão de a correr é do dono do projecto.

`cvf_arquivo_possivel(antes_de)` conta quantas revisões e quantos bytes daria
para arquivar, sem arquivar nada — para a decisão ser tomada com um número.

## Alternativas rejeitadas

**Não fazer nada.** Foi o que se fez até aqui, e continua a ser a resposta
certa enquanto o disco não doer. Rejeitada agora porque a alternativa a ter o
mecanismo pronto é escrevê-lo à pressa no dia em que o disco encher — que é
exactamente o dia em que não se quer estar a escrever SQL que apaga coisas.

**Particionar `record_revisions` por data e destacar partições.** É a resposta
de manual, não mexe em trigger nenhum e é a que menos risco tem sobre os dados.
Rejeitada por duas razões: converter uma tabela existente em particionada
obriga a recriá-la, e a publicação lógica do PowerSync sobre uma tabela
particionada precisa de `publish_via_partition_root` e de um comportamento que
não consigo verificar sem um telefone e semanas de replicação a sério. Fica
como a evolução natural desta decisão se o volume crescer uma ordem de
grandeza — e nessa altura o arquivo já cá está para esvaziar a tabela antes da
conversão.

**Comprimir o `data` em vez de o mover.** O `jsonb` já é comprimido pelo TOAST
acima de 2 kB, que é precisamente o tamanho destes registos. Ganho quase nulo.

**Apagar mesmo as revisões antigas.** Rejeitada sem discussão: é a restrição 4,
e é a razão pela qual esta plataforma se pode chamar um cadastro.

## Consequências

**Ganhamos:** uma forma verificada de a base encolher, e um trigger que
verifica em vez de confiar — o que existia antes recusava tudo, mas quem
quisesse contornar bastava-lhe `SET session_replication_role = replica`, que é
o que a própria migração 0003 faz.

**Pagamos:**

- **O invariante deixou de ser «uma revisão nunca sai desta tabela» e passou a
  ser «uma revisão nunca sai sem estar segura noutro sítio».** É mais fraco de
  enunciar e igualmente forte na prática, mas é preciso ler o trigger para o
  perceber — daí este ADR.
- `record_revisions_frias` não tem chaves estrangeiras, de propósito, para se
  poder mover para outro tablespace ou exportar sozinha. Isso significa que
  nada impede uma linha fria de sobreviver ao registo dela. É deliberado: numa
  tabela de arquivo, sobreviver é a função.
- As revisões arquivadas **saem dos buckets do PowerSync**: um telefone que
  sincronize de novo não recebe histórico arquivado. Como só se arquiva o que
  não é a revisão corrente, o que o técnico vê no telefone não muda.
- Quem consultar `record_revisions` directamente em SQL — um relatório, uma
  consulta ad-hoc — passa a ver menos linhas do que espera. A vista
  `record_revisions_todas` existe para isso, e é preciso lembrar-se dela.
