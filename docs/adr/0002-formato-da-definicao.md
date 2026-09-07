# ADR-0002 — Formato próprio em JSON, com importação e exportação XLSForm

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

Precisamos de um formato para descrever formulários. O XLSForm é o padrão de
facto do sector (ODK, KoboToolbox, Survey123) e há organizações com centenas
de formulários já escritos nele.

## Decisão

Formato próprio em JSON (`docs/FORM-SPEC.md`), com importação e exportação
XLSForm. A regra que o distingue:

> **`id` é imutável e gerado pelo sistema; `name` é editável pelo humano.**
> Os dados guardam-se sempre por `id`.

## Alternativas rejeitadas

**Adoptar o XLSForm como formato interno.** Traria compatibilidade total de
graça. Rejeitada por causa de uma característica central do XLSForm: a coluna
`name` é simultaneamente o identificador dos dados e o nome que o humano edita.
Renomear uma pergunta perde os dados já recolhidos, ou obriga a uma migração
manual. É o problema que o Kobo trata mal, e é precisamente o que não queremos
repetir — num cadastro que vai durar anos, os nomes das perguntas vão mudar.

O XLSForm arrasta ainda a linguagem de expressões do XPath, que discutimos no
ADR-0003 e que também não queremos.

**Inventar um formato sem ponte para o XLSForm.** Rejeitada porque fecharia a
porta a formulários existentes no primeiro dia, e porque obrigaria os
administradores a reaprender tudo. A ponte é o que nos deixa ter as duas coisas.

## Consequências

**Ganhamos:** renomear uma pergunta nunca perde dados; o formato pode ter
tipos que o XLSForm não tem (`reference` para registos de outro formulário);
os rótulos são multilingues por construção, e não por convenção de colunas.

**Pagamos:**

- A conversão XLSForm é uma tradução com perdas nos dois sentidos. Ao importar,
  temos de **gerar** `id` (o XLSForm não os tem) e converter expressões XPath
  para AST. Ao exportar, perdem-se as construções que o XLSForm não exprime. É
  preciso ser honesto com o utilizador sobre o que se perdeu — e não fingir que
  a conversão é perfeita.
- Nem todo o XPath do ODK é convertível. Vai haver formulários que não importam
  na íntegra, e a mensagem de erro tem de dizer exactamente que linha e que
  expressão falharam.
- Temos de manter o nosso próprio validador, editor e documentação. É trabalho
  que teríamos de graça se adoptássemos o padrão.
- O JSON Schema é a fonte da verdade e vive em TypeScript
  (`packages/form-core/src/schema/form-definition.schema.ts`) — as três
  aplicações importam-no directamente, sem `import attributes` nem resolução
  por runtime. O `.json` é gerado e o CI falha se dessincronizar.
