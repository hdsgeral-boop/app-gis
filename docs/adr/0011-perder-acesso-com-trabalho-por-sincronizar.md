# ADR-0011 — Perder acesso a um formulário com trabalho por sincronizar

**Estado:** aceite · **Data:** 2026-09-06 · **Fecha:** PLANO.md F5.8

## Contexto

Um técnico recolhe trinta registos de um formulário durante uma semana no
Bengo, sem rede. Nesse intervalo, um administrador em Luanda tira-lhe a
atribuição desse formulário — porque o projecto passou a outra equipa, porque
alguém se enganou, porque o contrato mudou.

Quando o telefone volta a ter rede, o que acontece aos trinta registos?

As duas respostas óbvias estão as duas erradas:

- **Recusar a subida** apaga uma semana de trabalho de campo por causa de uma
  alteração administrativa feita a 200 km de distância, sobre a qual o técnico
  não soube nada e não podia ter feito nada.
- **Manter o acesso** até ele sincronizar transforma a revogação numa sugestão.
  Alguém a quem se tirou o acesso continua a receber registos novos enquanto
  não abrir a app.

## Decisão

**Separar a subida da descida. O que já foi recolhido sobe; o que ainda não
foi atribuído não desce.**

Concretamente:

1. **A subida é autorizada pela atribuição que existia quando o registo foi
   criado**, e não pela actual. O servidor aceita revisões de registos cujo
   `created_by` é o utilizador e cujo `form_id` ele teve atribuído — mesmo que
   já não tenha. Isto vale para os registos que já existem, e só para esses.
2. **A criação de registos novos exige a atribuição actual.** Um técnico sem
   atribuição não cria mais nada nesse formulário, e a app esconde-lhe o botão
   assim que sincronizar.
3. **A descida pára imediatamente.** O bucket desaparece das sync rules e o
   telefone deixa de receber registos e definições novas desse formulário.
4. **O formulário fica marcado como arquivado no telefone, não é apagado.** A
   definição tem de continuar lá para os registos por subir se poderem abrir e
   ler; apagá-la deixaria dados sem esquema.
5. **A app diz o que se passa.** «Este formulário deixou de lhe estar
   atribuído. Os N registos que faltam subir vão subir na mesma.» Um técnico
   que vê um formulário desaparecer sem explicação assume que perdeu o
   trabalho, e da próxima vez desconfia do sistema todo.

Se o servidor recusar mesmo assim — o formulário foi arquivado, a organização
mudou —, o item **estaciona** na fila com o motivo à vista, e não é apagado
(ver `apps/mobile/src/sinc/fila.ts`). A saída de um estacionamento é sempre
uma decisão humana.

## Alternativas rejeitadas

**Uma janela de tolerância — aceitar durante 30 dias depois da revogação.**
Rejeitada porque escolhe um número arbitrário e falha exactamente no caso que
interessa: o técnico que passou seis semanas fora. Uma regra que depende de
adivinhar quanto tempo alguém fica sem rede não é uma regra.

**Deixar o administrador decidir por atribuição.** Rejeitada por complexidade:
mais uma opção num ecrã que já tem muitas, para uma decisão que tem uma
resposta certa quase sempre. Se aparecer um caso real que precise do
contrário, volta a discutir-se.

**Aceitar a subida de qualquer registo, de qualquer formulário.** Rejeitada
porque abre a porta a escrever em formulários a que nunca se teve acesso. A
autorização é pelo histórico do utilizador, não pela ausência dela.

## Consequências

**Ganhamos:** nunca se perde trabalho de campo por causa de uma alteração
administrativa; a revogação tem efeito imediato no que interessa (o que desce);
o técnico percebe o que aconteceu.

**Pagamos:**

- O servidor precisa de saber que atribuições existiram, e não só quais
  existem. Hoje `form_assignments` é actualizada no sítio e a informação
  perde-se. **Falta implementar**: ou um histórico de atribuições, ou —
  mais simples — autorizar a subida quando o registo já existe e o
  `created_by` é o próprio. É esta segunda que está implementada, e cobre o
  caso normal; um registo criado por outra pessoa e editado por este técnico
  não sobe. Está registado no `PLANO.md`.
- Um técnico mal-intencionado a quem se tirou o acesso pode continuar a
  submeter revisões dos registos que criou. É aceitável: são registos dele, o
  histórico é append-only e a auditoria regista tudo.
