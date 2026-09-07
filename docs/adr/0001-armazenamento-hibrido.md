# ADR-0001 — Armazenamento híbrido: JSONB canónico + vistas tipadas

**Estado:** aceite · **Data:** 2026-09-05

## Contexto

A plataforma tem de guardar respostas de formulários que ainda não existem,
desenhados por administradores, sem que ninguém toque no código. A pergunta é
onde é que essas respostas vivem fisicamente.

Quem consome os dados a jusante — QGIS, ArcGIS, Power BI, exportações — espera
tabelas com colunas tipadas. Quem os produz — a app móvel, através do PowerSync
— espera um esquema estável que não mude a cada formulário publicado.

Estes dois desejos puxam em direcções opostas.

## Decisão

**Verdade canónica em JSONB, projecções tipadas em vistas.**

1. Uma única tabela `record_revisions(data jsonb)` guarda as respostas de todos
   os formulários, de todos os projectos, de todas as organizações. O esquema
   físico nunca muda quando se publica um formulário. O esquema do SQLite no
   telefone também não. As sync rules do PowerSync são escritas uma vez.
2. Ao publicar uma versão, o backend gera uma `VIEW` em `cvf_views` que achata
   o JSONB em colunas tipadas, com `geometry(Point,4326)` real. O QGIS liga-se
   a estas vistas como se fossem tabelas.
3. Materializa-se uma vista só quando ela doer (~500k registos ou lentidão
   medida). É optimização, não desenho inicial.

## Alternativas rejeitadas

**DDL dinâmico — uma tabela física por versão de formulário.** É o que dá
colunas tipadas de graça e a ligação mais directa possível ao QGIS. Rejeitada
por acumulação: milhares de tabelas, DDL em produção sob carga, políticas de
RLS a multiplicar por tabela, cópias de segurança pesadas. O problema fatal não
é nenhum destes — é que **as sync rules do PowerSync teriam de ser regeneradas
e redistribuídas a cada formulário publicado**, o que faz do acto de publicar
uma operação de infraestrutura em vez de uma operação de conteúdo. É a diferença
entre uma plataforma e um gerador de aplicações.

**JSONB puro, sem vistas.** Esquema fixo, sincronização estável, versionamento
trivial — tudo o que queremos. Mas deixa por resolver o problema de quem
consome: cada consulta no QGIS passaria a ser SQL escrito à mão com
`data->>'f_cod'`, e ninguém no terreno vai fazer isso. Insuficiente sozinha, e
é por isso que a decisão é híbrida e não B.

## Consequências

**Ganhamos:** zero DDL no caminho crítico de publicar; sync rules imutáveis;
versionar um formulário é escrever uma linha; e mesmo assim tabelas reais e
tipadas para quem consome.

**Pagamos:**

- Uma consulta directa a `record_revisions` é ilegível. Quem for à base sem
  passar pelas vistas vai encontrar JSONB cru e chaves opacas (`f_cod`, e não
  `codigo`). Assume-se: as vistas são a interface pública.
- As vistas custam a manter. O gerador tem de lidar com nomes acentuados,
  palavras reservadas do SQL e colisões — e é o sítio mais provável de uma
  injecção de SQL entrar no sistema. É a peça mais delicada da F2, e é por isso
  que leva os testes mais pesados.
- O índice GIN em `data` é grande e fica caro de escrever. Escolhemos
  `jsonb_path_ops`, que é bastante mais pequeno mas só serve `@>`. Se um dia
  precisarmos de mais operadores, o custo aparece aqui.
- Perde-se a validação de tipos ao nível da coluna. Um número guardado como
  string não é o Postgres que o apanha: é o validador de respostas do
  `form-core`. Isto obriga esse validador a ser levado a sério — e é.
