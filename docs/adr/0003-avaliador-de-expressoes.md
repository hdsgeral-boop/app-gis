# ADR-0003 — Avaliador de expressões em AST, sem `eval`

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

`relevant`, `constraint` e `calculation` precisam de uma linguagem. Essa
linguagem corre em dois sítios: no telefone, enquanto o técnico preenche, e no
servidor, quando o registo chega. Os dois têm de concordar sempre — se não
concordarem, um registo válido no telefone é rejeitado no servidor, ou pior,
o contrário.

## Decisão

Uma linguagem de expressões em **AST**: cada expressão é um objecto
`{ op, args }`, com um conjunto fechado de operadores
(`packages/form-core/src/types/index.ts`). O avaliador é uma função pura,
determinista, e vive uma só vez no `form-core`.

Nada de `eval`, nada de `new Function()`, nada de strings interpretadas em
tempo de execução (restrição inegociável 7).

## Alternativas rejeitadas

**XPath, como o ODK/XLSForm.** É o padrão do sector e os autores de formulários
já o conhecem. Rejeitada por três razões: exige um interpretador de XPath em
JavaScript no telefone (peso e superfície de ataque), é difícil de validar
estaticamente (não conseguimos detectar ciclos com confiança), e as
implementações divergem — que é exactamente o problema que não podemos ter.

**JavaScript avaliado com `eval` ou `new Function()`.** Simples, rápido de
escrever, e é o que muitas ferramentas fazem. Rejeitada porque a definição do
formulário é conteúdo criado por um utilizador e guardado na base de dados:
avaliá-la como código é execução remota de código, no servidor e no telefone.
Um administrador comprometido passaria a ter uma consola em cada aparelho da
frota. Não há sandbox que compense isto.

**Um interpretador de uma linguagem em texto, escrito por nós** (com parser).
Rejeitada por custo: um parser é mais código para manter, mais mensagens de
erro para escrever, e não traz nada que a AST não traga. A AST é directamente
serializável, directamente validável, e o construtor de formulários consegue
editá-la visualmente sem parser nenhum.

## Consequências

**Ganhamos:** a mesma expressão dá o mesmo resultado nos dois lados, por
construção — é literalmente o mesmo código; ciclos e referências a campos
inexistentes detectam-se estaticamente ao publicar; nenhuma superfície de
execução de código.

**Pagamos:**

- A AST é verbosa de escrever à mão. `{"op":"==","args":["$f_tipo","industrial"]}`
  contra `${tipo} = 'industrial'`. Isto passa a ser um problema de UI: o
  construtor da F2 tem de tornar isto agradável, porque o formato cru não é.
- Cada operador novo é uma alteração ao formato, ao schema, ao avaliador e aos
  testes. Adicionar capacidade é deliberadamente mais lento do que numa
  linguagem interpretada. Aceitamos isso.
- A conversão de XPath do XLSForm para AST não cobre tudo, e não pode cobrir.
  Ver ADR-0002.
