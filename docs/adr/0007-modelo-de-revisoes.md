# ADR-0007 — Registos com revisões append-only

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

Dois técnicos podem editar o mesmo registo offline. Um registo pode ser
corrigido meses depois. Um cadastro é um documento com valor legal e alguém vai
perguntar quem escreveu o quê e quando.

E há a regra que domina tudo: **perder um registo de campo é o pior defeito
possível.**

## Decisão

`records` guarda a identidade e o estado corrente. `record_revisions` é
**append-only**: cada edição acrescenta uma linha com `base_revision_id` a
apontar para aquela sobre a qual foi feita. Nunca há `UPDATE` nem `DELETE` numa
revisão. Apagar um registo é escrever `deleted_at` — um tombstone.

Isto é aplicado por **triggers no Postgres** (migração `0001_invariantes.sql`),
não por convenção na aplicação. A API não é o único caminho até esta base.

Conflito: duas revisões com o mesmo `base_revision_id` são **ambas guardadas** e
o registo fica `needs_review`. Nunca se escolhe automaticamente um vencedor.

## Alternativas rejeitadas

**Actualizar a linha no sítio, com `updated_at`.** Simples e barato. Rejeitada
porque perde o histórico e, com dois dispositivos offline, perde silenciosamente
o trabalho de um deles. Silenciosamente é a palavra que a torna inaceitável.

**Last-write-wins pelo relógio do dispositivo.** Rejeitada porque os relógios
dos telefones estão errados. Um telefone com a data adiantada ganharia sempre,
e o trabalho de quem tem o relógio certo desaparecia. Por isso é que
`client_created_at` é informativo e nunca ordena: a ordenação canónica é
`server_received_at` mais `revision_no`.

**CRDTs.** Resolvem conflitos automaticamente e sem perda. Rejeitada por duas
razões: complexidade a mais para três pessoas, e porque num cadastro a fusão
automática de dois valores contraditórios (duas leituras de contador
diferentes) produz um registo que ninguém verificou. Aqui, um humano decidir é
a resposta certa.

## Consequências

**Ganhamos:** nada se perde, nunca; histórico completo e auditável; conflitos
visíveis em vez de silenciosos.

**Pagamos:**

- A base cresce e não encolhe. Um registo editado vinte vezes tem vinte
  revisões, com o JSONB inteiro em cada uma. Vai ser preciso arquivar revisões
  antigas para armazenamento frio, e isso ainda não está desenhado — está no
  `PLANO.md`.
- `needs_review` cria **trabalho humano**. Se os conflitos forem frequentes, a
  fila cresce e alguém tem de a despachar. Se se tornar um problema real, a
  resposta é reduzir a probabilidade de conflito (âmbitos mais estreitos), não
  passar a resolver automaticamente.
- A chave estrangeira `records.current_revision_id` ↔ `record_revisions` é
  circular e teve de ser `DEFERRABLE INITIALLY DEFERRED`. Quem inserir fora de
  uma transacção vai bater nisso.
- Os testes têm de contornar os próprios triggers para limpar. Faz-se com
  `SET session_replication_role = replica`, que é local à sessão — nunca com
  `ALTER TABLE ... DISABLE TRIGGER`, que afecta toda a base.
