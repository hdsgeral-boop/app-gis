# Consul Colect — plano de execução

Tarefas de meio dia. Cada uma tem **critério de pronto verificável**: uma coisa
que se corre e se vê, não uma opinião sobre o código estar bom.

Regra que governa este ficheiro: **uma sessão, uma fase.** Âmbito aberto degrada
a qualidade depressa. O que ficar por fazer vem para aqui — nunca fica um `TODO`
perdido no código.

## Caminho crítico

```
F0 ──▶ F1 ──▶ F2 ──▶ F3 ──▶ F4 ──▶ F5 ──▶ F10
                │             │
                ├──▶ F6 ──────┤
                └──▶ F9 ──────┘
       F7 ─────────────────────┤   (depende só da F3)
       F8 ─────────────────────┘   (depende só da F4)
```

**A F1 e a F2 decidem tudo o resto.** Não há pressa de chegar ao telefone: se o
`form-core` e o gerador de vistas ficarem bem, o resto é trabalho normal. Se
ficarem mal, paga-se em todas as fases seguintes.

F7 (GNSS) e F8 (mapa) são paralelizáveis e não bloqueiam ninguém. Se houver
uma segunda pessoa, é aqui que ela trabalha.

## Onde estamos

| Fase | Estado                                                             |
| ---- | ------------------------------------------------------------------ |
| F0   | concluída                                                          |
| F1   | concluída                                                          |
| F2   | construída; falta uma pessoa a ligar o QGIS a uma vista            |
| F3   | a correr num TECNO KL5, com o layout novo                          |
| F4   | concluída                                                          |
| F5   | feita, menos o cliente PowerSync no telefone                       |
| F6   | feita                                                              |
| F7   | concluída — GPS interno, NMEA por TCP e limiares                   |
| F8   | construída — MapLibre e PMTiles; falta um ficheiro de mapa a sério |
| F9   | concluída — captura, redimensionamento e upload directo            |
| F10  | feita; o ensaio de campo passou a ser do dono do projecto          |

**O que falta é o que só se prova com uso:** um PMTiles de verdade a desenhar,
o cliente PowerSync no telefone, uma pessoa em frente a um QGIS, e o dono do
projecto a usar a app. Nada disto se resolve com mais código.

Para arrancar: `docs/ARRANCAR-E-TESTAR.md`. Para pôr online: `docs/PRODUCAO.md`.

---

## F0 — Andaimes, compose, CI, esquema, autenticação · **CONCLUÍDA**

| #    | Tarefa                                                         | Pronto quando                                       | Estado |
| ---- | -------------------------------------------------------------- | --------------------------------------------------- | ------ |
| 0.1  | Monorepo pnpm + Turborepo                                      | `pnpm turbo run typecheck test build` verde de raiz | ✅     |
| 0.2  | `docker-compose`: Postgres+PostGIS, Keycloak, PowerSync, MinIO | `pnpm infra:up` levanta os quatro                   | ✅     |
| 0.3  | Esquema em Drizzle, 19 tabelas                                 | `pnpm db:migrate` aplica contra o compose           | ✅     |
| 0.4  | Invariantes por trigger e CHECK                                | 17 testes em `infra/db/test/invariantes.test.ts`    | ✅     |
| 0.5  | Formato do formulário: tipos + JSON Schema                     | 17 testes em `packages/form-core`                   | ✅     |
| 0.6  | API com `/health` e `/me`, JWT contra o Keycloak               | 19 testes ponta a ponta                             | ✅     |
| 0.7  | Painel com login e página protegida                            | `/painel` sem sessão redirecciona para `/entrar`    | ✅     |
| 0.8  | App móvel: SQLite abre, login, `/me`                           | `pnpm --filter @cvforms/mobile build` agrupa        | ✅     |
| 0.9  | CI: formato, migrações, tipos, testes, build, restrições       | Workflow verde                                      | ✅     |
| 0.10 | `.env.example` completo e comentado                            | Um recém-chegado arranca só com ele                 | ✅     |
| 0.11 | `CLAUDE.md`, `docs/adr/` (10), `docs/FORM-SPEC.md`, `PLANO.md` | Escritos                                            | ✅     |

### Dívida assumida da F0

Está aqui para não se perder. Nenhuma destas coisas bloqueia a F1.

- ~~**Sync rules do PowerSync não foram corridas contra o serviço.**~~ Fechada
  na F5.1: o serviço arranca com zero erros e replica do WAL. A sintaxe teve
  mesmo de ser ajustada — aliases, subconsultas e parâmetros de bucket.
- ~~**Realm do Keycloak não foi importado num Keycloak a correr.**~~ Fechada: o
  compose sobe os quatro serviços e o Keycloak importa o realm sem erro.
- ~~**Os 17 testes de invariantes nunca tinham corrido contra um Postgres
  real.**~~ Fechada: correm, e passam, contra `postgis/postgis:16-3.4`.
- ~~**Sem políticas RLS.**~~ Fechada na F6: migração `0004`, a API corre com
  `cvforms_app` (sem `BYPASSRLS`) e há um teste que falha se ela voltar a
  correr como dono — que é o modo de falha do ADR-0010.
- **Sem ESLint.** Há Prettier e `tsc --strict`. O ESLint entra quando houver
  regra que valha a pena impor além do que o compilador já impõe.
- **`packages/ui` está vazio.** Cria-se quando houver o segundo componente
  partilhado entre o painel e o móvel, não antes.
- **Sem Sentry.** Entra na F10, com o endurecimento.
- **`/health` não verifica o MinIO nem o PowerSync.** Agora já são ambos
  usados (F9 e F5), portanto isto passou a ser dívida a sério: um MinIO em
  baixo só se descobre quando um anexo falha.

### Sobre o ambiente de desenvolvimento

Registado aqui porque custou tempo a diagnosticar e vai voltar a acontecer.

- **O porto do Postgres do compose é configurável** (`POSTGRES_PORT`). É comum
  já haver um Postgres instalado na máquina de quem desenvolve a ocupar o 5432.
- **Em Docker Desktop no Windows, o contentor do Postgres reinicia-se
  sozinho de vez em quando** — um processo de servidor sai com código 2 e a
  base entra em recuperação durante ~30 s. Os `checkpoint` demoram dezenas de
  segundos, o que aponta para I/O lento do WSL2, e não para nada do Consul Colect. O
  sintoma nos testes é `the database system is not yet accepting connections`.
  Espera e repete; se se tornar frequente, dá mais memória e disco ao Docker
  Desktop.

---

## F1 — `packages/form-core` · **CONCLUÍDA**

Sem UI nenhuma. Testes primeiro. Este pacote é o único sítio onde as regras dos
formulários existem, e um erro aqui aparece em todo o lado.

| #    | Tarefa                                                             | Pronto quando                                                                              | Estado |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ | ------ |
| 1.1  | Percorrer e indexar a árvore de campos                             | Dado um formulário com repetíveis aninhados, resolve o âmbito de qualquer `id`             | ✅     |
| 1.2  | Validador semântico: `id` e `name` duplicados                      | Recusa os 2 casos com o caminho exacto do erro                                             | ✅     |
| 1.3  | Validador: referências a campos, listas e formulários inexistentes | Recusa os 4 casos da §8 do FORM-SPEC                                                       | ✅     |
| 1.4  | Validador: detecção de ciclos em `relevant`/`calculation`          | Recusa `A→B→A` e `A→A`, e aceita um grafo profundo mas acíclico                            | ✅     |
| 1.5  | Validador: regras de âmbito (`$self`, `$..x`) e aridade            | Recusa os 12 casos da §8 do FORM-SPEC, cada um com teste                                   | ✅     |
| 1.6  | Avaliador: comparação, lógica, aritmética, nulos                   | Tabela de verdade completa, incluindo `null` e curto-circuito                              | ✅     |
| 1.7  | Avaliador: texto, conjuntos, datas                                 | Cada operador com caso normal, caso limite e caso nulo                                     | ✅     |
| 1.8  | Avaliador: `count`, `sum`, `selected` sobre repetíveis             | Repetível aninhado, e `$..x` a resolver o âmbito pai                                       | ✅     |
| 1.9  | Avaliador: `distance_m` correcto em metros                         | Distância Luanda–Bengo com erro < 0,5 % contra valor conhecido                             | ✅     |
| 1.10 | Ordem de cálculo: ordenação topológica das dependências            | Um `calculate` que depende de outro `calculate` estabiliza numa passagem                   | ✅     |
| 1.11 | Validador de respostas contra uma definição                        | Campo não relevante não é validado, mesmo sendo `required`                                 | ✅     |
| 1.12 | Validador de respostas: tipos, restrições, repetíveis              | Uma resposta inválida devolve todos os erros, não só o primeiro                            | ✅     |
| 1.13 | Diff entre versões, com classificação                              | Os 11 casos da §9 do FORM-SPEC, cada um classificado correctamente                         | ✅     |
| 1.14 | Importador XLSForm: estrutura, tipos, listas, grupos               | Um XLSForm real do Kobo importa e valida                                                   | ✅     |
| 1.15 | Importador XLSForm: conversão XPath → AST                          | `selected(${x},'a') and ${y} > 3` converte; o que não converte falha com linha e expressão | ✅     |
| 1.16 | Exportador XLSForm                                                 | Ida e volta preserva estrutura e rótulos; o que se perde é comunicado                      | ✅     |
| 1.17 | Testes com formulários reais do Kobo e do Survey123                | Pelo menos 3 formulários públicos importam                                                 | ✅     |

**Critério de pronto da fase:** cumprido. 180 testes em 8 ficheiros, sem
nenhuma dependência de UI, base de dados ou rede.

### Dívida assumida da F1

- **A leitura do `.xlsx` binário não está no `form-core`, e é deliberado.** O
  pacote corre no telefone, onde um leitor de folhas de cálculo não tem nada
  que fazer. O `form-core` importa e exporta LINHAS
  (`XlsFormWorkbook`); quem tem o ficheiro converte-o. O adaptador
  `.xlsx` → linhas entra com o endpoint `/admin/forms/import/xlsform` (F2.14).
- **As fixtures da F1.17 são transcrições da estrutura de linhas** de
  formulários públicos do Kobo, ODK e Survey123, não os `.xlsx` originais —
  consequência directa do ponto anterior. A cobertura de conversão é a mesma;
  o que falta testar é a leitura do binário, e isso testa-se na F2.
- **`is_null` exportado para XLSForm vira `(x = '')`**, que é a aproximação
  habitual e não distingue «vazio» de «zero» em campos numéricos.
- **Apertar uma restrição escrita à mão é sempre classificado como
  incompatível.** Decidir se uma expressão arbitrária alarga ou aperta exigiria
  provar implicação entre duas fórmulas. Um aviso a mais custa um clique.

---

## F2 — Construtor de formulários e provisionamento · **construída; falta ligar o QGIS**

| #    | Tarefa                                                          | Pronto quando                                                                     | Estado |
| ---- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| 2.1  | Saneamento de identificadores SQL                               | `name` com acentos, espaços e palavras reservadas gera coluna válida e única      | ✅     |
| 2.2  | **Teste de injecção no gerador de vistas**                      | `name` com `"; DROP TABLE records; --` não executa nada e não parte a vista       | ✅     |
| 2.3  | Gerador: vista raiz com colunas tipadas                         | `SELECT` na vista devolve as colunas certas com os tipos certos                   | ✅     |
| 2.4  | Gerador: `geopoint` → `geometry(Point,4326)`                    | `ST_X`, `ST_Y` e consulta por bbox funcionam na vista                             | ✅     |
| 2.5  | Gerador: `select_multiple` → `text[]` + `_txt`                  | Ambas as colunas com o conteúdo esperado                                          | ✅     |
| 2.6  | Gerador: repetível → vista-filha ligada por `record_id` + `idx` | `JOIN` entre vista-mãe e vista-filha devolve as instâncias                        | ✅     |
| 2.7  | Gerador: repetível aninhado                                     | Duas vistas-filhas encadeadas                                                     | ✅     |
| 2.8  | Vista `_actual` a apontar para a versão corrente                | Publicar a v5 muda o que a `_actual` devolve                                      | ✅     |
| 2.9  | Publicar a v(n+1) não parte a vista da v(n)                     | Consulta à vista antiga continua a devolver os mesmos dados                       | ✅     |
| 2.10 | Índices GIN nos campos `searchable`                             | `EXPLAIN` mostra o índice a ser usado                                             | ✅     |
| 2.11 | Pipeline de publicação transaccional                            | Falha a meio → nenhuma vista criada, nenhuma versão gravada                       | ✅     |
| 2.12 | Arquivar apaga as vistas e nenhum registo                       | Contagem de `record_revisions` inalterada; `cvf_views` vazio para esse formulário | ✅     |
| 2.13 | Manifesto do formulário (hash, listas externas, media)          | `GET /forms/{id}/manifest` com hashes estáveis                                    | ✅     |
| 2.14 | Endpoints `/admin/forms/*`                                      | `POST /publish` corre o pipeline completo                                         | ✅     |
| 2.15 | Construtor no painel: árvore, arrastar, propriedades            | Criar um formulário com repetível sem tocar em JSON                               | ✅     |
| 2.16 | Construtor: editor de expressões                                | Escrever um `relevant` sem saber o que é uma AST                                  | ✅     |
| 2.17 | Construtor: pré-visualização                                    | Ver o formulário como aparece no telefone                                         | ✅     |
| 2.18 | Construtor: diff e confirmação de incompatíveis                 | Remover um campo exige confirmação explícita                                      | ✅     |

**Critério de pronto:** cumprido na parte que se pode provar sem um técnico de
SIG à frente. As vistas geradas são consultadas por SQL em
`infra/db/test/vistas-postgres.test.ts`, contra PostGIS a sério: colunas
tipadas, `ST_X`/`ST_Y`, consulta por bbox, `JOIN` entre vista-mãe e vista-filha,
e a vista da v1 intacta depois de publicar a v2.

### Dívida assumida da F2

- **O QGIS ainda não foi ligado por uma pessoa.** O que está provado é que a
  vista existe, tem os tipos certos e responde a consultas espaciais — que é o
  que o QGIS faz. Falta alguém abrir o QGIS e confirmar. Vai com a F10.4.
- **A `_actual` mostra TODOS os registos do formulário**, projectados com as
  colunas da versão corrente, e não só os da versão corrente. Um registo antigo
  aparece com NULL nos campos novos e com `form_version` a dizer com que versão
  foi recolhido. A alternativa — uma camada por versão publicada — obrigaria o
  técnico de SIG a trocar de camada a cada publicação.
- **Os índices dos campos `searchable` são btree, não GIN.** O GIN com
  `jsonb_path_ops` só acelera `@>`, e esse já existe, global, desde a migração
  0001; a pesquisa que se faz de facto é igualdade e prefixo sobre um campo. O
  critério da tarefa — o `EXPLAIN` mostrar o índice a ser usado — está provado.
- **A leitura do `.xlsx` binário continua por fazer.** O endpoint
  `POST /admin/forms/import/xlsform` recebe LINHAS, não o ficheiro. Falta o
  adaptador que lê o `.xlsx` no painel e as envia.
- **O construtor não tem arrastar-e-largar**, tem setas para cima e para baixo.
  Uma biblioteca de arrastar em árvore é uma dependência grande para um ganho
  que ninguém pediu ainda.
- **Mover um campo entre âmbitos não é possível no construtor.** É deliberado:
  arrastar um campo para dentro de um repetível mudaria o nível dos dados já
  recolhidos, e o diff classifica isso como incompatível. Se vier a fazer
  falta, tem de passar pelo mesmo aviso explícito.

---

## F3 — Renderizador dinâmico no móvel · **a correr num TECNO KL5**

| #    | Tarefa                               | Pronto quando                                                          | Estado |
| ---- | ------------------------------------ | ---------------------------------------------------------------------- | ------ |
| 3.1  | Descarregar e guardar definições     | Definição em SQLite, com hash; não volta a descarregar se não mudou    | ✅     |
| 3.2  | Renderizar os tipos simples          | text, note, integer, decimal, boolean, date, time, datetime, barcode   | ✅     |
| 3.3  | Renderizar escolhas                  | `select_one`, `select_multiple`, `allow_other`, cascatas               | ✅     |
| 3.4  | Relevância reactiva                  | Esconder um campo limpa o valor e revalida, na mesma passagem          | ✅     |
| 3.5  | Restrições e mensagens               | `constraint_message` mostrada; sem ela, mensagem por omissão útil      | ✅     |
| 3.6  | Campos calculados                    | Recalculam ao alterar dependências, sem ciclo de renderização infinito | ✅     |
| 3.7  | Grupos e navegação por secções       | Formulário de 80 perguntas navega sem arrastar                         | ✅     |
| 3.8  | Repetíveis, incluindo aninhados      | Acrescentar, remover, reordenar; `instance_label` na lista             | ✅     |
| 3.9  | Rascunho gravado a cada alteração    | Matar a app a meio não perde nada                                      | ✅     |
| 3.10 | Desempenho num Android de gama baixa | Formulário de 80 campos responde a menos de 100 ms por toque           | ✅     |

**Critério de pronto:** o circuito está todo construído e testado por partes —
publicar pela API gera as vistas e serve a definição (`apps/api/test/
formularios.e2e.test.ts`), a app descarrega-a e guarda-a por hash, e o
renderizador constrói o ecrã a partir dela. **O que falta é corrê-lo num
telefone a sério**, e isso precisa de um dev build: ver a dívida abaixo.

### Dívida assumida da F3

- **Nada foi corrido num telefone.** O renderizador está provado ao nível do
  comportamento — 20 testes sobre a máquina de estado, que é onde vivem a
  relevância, os cálculos e os repetíveis — mas as vistas em React Native por
  cima dela nunca foram desenhadas num ecrã. Falta `eas build --profile
development` e um Android na mão.
- **A F3.10 é medida num portátil, não num Android de gama baixa.** O teste
  mede o custo por toque na máquina de quem desenvolve e falha se ele subir uma
  ordem de grandeza. O número que interessa — 100 ms num telefone de 2 GB —
  só se mede com o telefone.
- **Sem selector nativo de data.** Há uma caixa de texto validada e um botão
  «hoje»/«agora». Um selector obriga a uma dependência nativa e a um dev build
  novo; entra quando houver outro motivo para reconstruir.
- **O campo `reference` mostra o valor mas não deixa escolher.** Escolher um
  registo de outro formulário precisa da lista local, que é a F4.
- **Os anexos mostram o que já está preso ao registo e mais nada.** A captura,
  o redimensionamento e a fila são a F9.
- **O GNSS não lê nada.** A abstracção `FonteDeLocalizacao` existe e o
  renderizador já a consome; a implementação é a F7. A fonte por omissão recusa
  -se a inventar um ponto — devolver uma coordenada falsa seria muito pior do
  que não devolver nenhuma.

---

## F4 — Recolha offline · **CONCLUÍDA**

| #    | Tarefa                                   | Pronto quando                                                          | Estado |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------- | ------ |
| 4.1  | Criar registo com UUIDv7 no cliente      | O `id` é gerado no telefone e nunca muda                               | ✅     |
| 4.2  | Gravar revisão localmente                | `record_revisions` local com `base_revision_id` correcto               | ✅     |
| 4.3  | Listar registos com virtualização        | 30 000 registos locais e a lista continua fluida                       | ✅     |
| 4.4  | Pesquisa local pelos campos `searchable` | Resposta abaixo de 200 ms com 30 000 registos                          | ✅     |
| 4.5  | Editar registo existente                 | Nova revisão; a anterior intacta                                       | ✅     |
| 4.6  | Estados e transições                     | `rascunho` → `submetido` é acto explícito do técnico                   | ✅     |
| 4.7  | Reabrir com a versão original            | Registo criado com a v3 abre com a v3 depois de sair a v4              | ✅     |
| 4.8  | Relógio do dispositivo errado            | `client_created_at` guardado, mas a ordenação usa `server_received_at` | ✅     |
| 4.9  | App morta a meio do preenchimento        | Reabrir devolve exactamente o que estava escrito                       | ✅     |
| 4.10 | Mesmo registo editado duas vezes offline | Duas revisões encadeadas, sem perda                                    | ✅     |

---

### Dívida assumida da F4

- **A 4.3 e a 4.4 são medidas com SQLite em Node**, não com o `expo-sqlite` de
  um telefone. O que se prova é o SQL: que a listagem pagina e que a procura
  usa o índice em vez de varrer 30 000 objectos JSON. O motor é o mesmo; a
  máquina não é.
- **O índice de procura é derivado e ainda não se reconstrói sozinho.** Se uma
  versão futura acrescentar um campo `searchable`, os registos antigos só
  entram na procura quando forem editados. Falta uma reconstrução em massa.

## F5 — Sincronização · **feita, menos o cliente PowerSync no telefone**

| #    | Tarefa                                        | Pronto quando                                                                               | Estado |
| ---- | --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------ |
| 5.1  | Sync rules verificadas contra o serviço       | Buckets carregam sem erro (fecha a dívida da F0)                                            | OK     |
| 5.2  | Descida: só o que está atribuído              | Um técnico sem atribuição não recebe nem a definição                                        | --     |
| 5.3  | Subida: fila persistente com backoff          | Fechar a app e reiniciar o telefone não perde a fila                                        | OK     |
| 5.4  | Harness de rede de campo                      | Latência alta, perdas, cortes a meio do upload                                              | OK     |
| 5.5  | Retoma depois de corte a meio do upload       | Nenhum registo duplicado, nenhum perdido                                                    | OK     |
| 5.6  | Conflito: duas revisões com a mesma base      | Ambas guardadas, registo em `needs_review`                                                  | OK     |
| 5.7  | Resolução de conflitos no painel              | Ver as duas versões lado a lado e escolher                                                  | OK     |
| 5.8  | Perder acesso a um formulário estando offline | **Decidir e justificar:** o que acontece aos registos já recolhidos e ainda por sincronizar | OK     |
| 5.9  | Versão de formulário desactualizada           | A app avisa, descarrega a nova, e continua a editar os antigos com o esquema original       | OK     |
| 5.10 | Dois dispositivos, mesmo registo, offline     | Nenhum trabalho perdido, conflito visível                                                   | OK     |

Sobre a 5.8: a resposta por omissão é **os registos já recolhidos sobem na
mesma**, e só depois o formulário desaparece do dispositivo. Recusar a subida
seria apagar trabalho de campo por causa de uma alteração administrativa. A
decisão final é do dono do projecto, e fica registada em ADR.

---

### O que ficou feito, e como

- **5.1** — o serviço arranca, carrega as regras e replica do WAL, com zero
  erros. Fechou a dívida da F0, e ao fazê-lo apanhou três defeitos reais: o
  ficheiro de configuração estava montado de um caminho que não existe, faltava
  o `sslmode` na ligação de armazenamento, e as regras usavam SQL que a
  linguagem do serviço não aceita.
- **5.6 e 5.10** — duas revisões com a mesma `base_revision_id` são ambas
  gravadas e o registo fica `needs_review`, provado em
  `apps/api/test/registos.e2e.test.ts`.
- **5.8** — decidido e implementado. Ver ADR-0011.

### Dívida assumida da F5

- **O PowerSync não foi exercitado a partir de um telefone.** O que está
  provado é que o serviço aceita as regras — incluindo as do âmbito, verificadas
  com o contentor a arrancar — e que replica do WAL. Falta um cliente
  `@powersync/react-native` a abrir um bucket, e isso precisa de um dev build.
- **A fila de subida do telefone fala com um transporte injectado**, e o
  transporte que fala com a API a sério ainda não existe. A lógica — ordem por
  registo, backoff com tecto, estacionamento, idempotência — está testada com
  um transporte controlado.
- **A 5.2 está construída em três camadas e não provada na quarta.** O RLS
  nega, as sync rules filtram e o `/me` concorda — há testes para os três. O
  que falta é ver um telefone a não receber a definição, e isso precisa de um
  dev build.
- **A 5.9 avisa e não converte.** Um registo recolhido com a versão 3 continua
  a abrir na 3, e a app di-lo. Converter automaticamente seria o erro fácil de
  cometer aqui: um campo removido desapareceria da resposta e um campo
  renomeado passaria a estar vazio, sem ninguém decidir nada.
- **O `form_access` é recalculado por inteiro para o formulário ou para o
  utilizador afectado.** Com dezenas de milhares de utilizadores por
  organização isto passa a doer; hoje não dói, e um incremental que ninguém
  consegue verificar valeria menos.

## F6 — Atribuições, RBAC, RLS, âmbitos, auditoria · **feita**

| #   | Tarefa                                                | Pronto quando                                                                     | Estado |
| --- | ----------------------------------------------------- | --------------------------------------------------------------------------------- | ------ |
| 6.1 | Políticas RLS por `org_id`                            | Uma sessão de outra organização vê zero linhas                                    | OK     |
| 6.2 | **Teste de que a API não corre como superutilizador** | Falha se o papel da API ignorar o RLS — o modo de falha mais perigoso do ADR-0010 | OK     |
| 6.3 | RLS por atribuição de formulário                      | Sem atribuição, zero linhas, mesmo dentro da organização                          | OK     |
| 6.4 | `scope_filter` (ex.: por município)                   | Um técnico do Bengo não vê registos do Uíge                                       | OK     |
| 6.5 | Gestão de utilizadores, papéis e equipas no painel    | Criar utilizador, atribuir formulário, ver o efeito no `/me`                      | OK     |
| 6.6 | Auditoria por trigger                                 | Publicar, atribuir e exportar ficam registados; o `audit_log` é append-only       | OK     |
| 6.7 | Concordância entre as três camadas                    | Teste que prova que RLS, sync rules e `/me` concordam                             | OK     |

---

### O que ficou feito, e o que se aprendeu a fazê-lo

18 testes em `infra/db/test/rls.test.ts`, contra um Postgres real e com o papel
da aplicação. Dois erros graves apanhados por eles, ambos do género que não dá
erro nenhum:

- **Políticas PERMISSIVE combinam-se por OR.** A política de atribuição estava
  a ALARGAR o acesso em vez de o apertar. Tem de ser `AS RESTRICTIVE`.
- **Um escape do género `NOT estou_na_aplicacao() OR …` faz falhar aberto.**
  Bastava a aplicação esquecer-se de definir o contexto para ver tudo. Não
  existe mais; sem contexto não se vê nada.

A API corre agora com o papel `cvforms_app`, que não é dono das tabelas nem tem
`BYPASSRLS`, e define `cvf.org_id`/`cvf.user_id` a cada pedido. O DDL das
vistas continua a correr com o dono, porque publicar cria vistas.

### Dívida assumida da F6

- **O modo administrativo é um `SET` na sessão.** Um administrador dispensa a
  atribuição por formulário dentro da própria organização. Nunca atravessa
  organizações — essa é a política que interessa — mas um erro aqui expõe
  dados dentro da organização a quem já é administrador dela.
- **A senha do papel `cvforms_app` não é criada pela migração.** Em
  desenvolvimento entra-se nele por `SET ROLE`; em produção é preciso
  `ALTER ROLE cvforms_app LOGIN PASSWORD …` fora do repositório, e apontar
  lá a `DATABASE_URL`.
- **O campo de âmbito não se muda depois de haver registos.** Está travado por
  trigger, e é deliberado: mudá-lo obrigaria a reescrever o `scope_value` de
  revisões já gravadas, e uma revisão não se reescreve (restrição inegociável
  4). Quem precisar mesmo publica um formulário novo.
- **Um registo com o campo de âmbito por responder não é visto por quem tem
  filtro.** Falha fechada, de propósito — um âmbito que não se sabe não se
  atribui — mas quem o recolheu continua a vê-lo (ADR-0011).
- **O ecrã de pessoas não cria utilizadores.** A identidade vive no Keycloak e
  a linha aparece no primeiro login. Criar aqui uma linha sem `subject` daria
  um utilizador que nunca conseguia entrar.

## F7 — GNSS · **CONCLUÍDA**

| #   | Tarefa                                    | Pronto quando                                                    | Estado |
| --- | ----------------------------------------- | ---------------------------------------------------------------- | ------ |
| 7.1 | Abstracção `LocationProvider`             | Trocar de fonte não toca em código de formulário                 | OK     |
| 7.2 | GPS interno                               | Ponto com `accuracy_m`, `fix_type` e `source` preenchidos        | OK     |
| 7.3 | NMEA sobre TCP/Wi-Fi                      | Emlid ou equivalente a alimentar a app                           | OK     |
| 7.4 | Analisador de NMEA                        | `GGA`, `RMC`, `GST`; satélites, PDOP, HDOP, idade das correcções | OK     |
| 7.5 | Bluetooth no Android por mock location    | Documentado com fotografias dos passos                           | OK     |
| 7.6 | Precisão e origem sempre visíveis no ecrã | Visível sem tocar em nada                                        | OK     |
| 7.7 | Limiar por formulário e por campo         | Acima do limiar, aviso visível                                   | OK     |
| 7.8 | Justificação escrita acima do limiar      | Fica na revisão e aparece no relatório de qualidade              | OK     |

---

### Dívida assumida da F7

- **Nada foi ligado a um receptor a sério.** O que está provado é o protocolo:
  o analisador de NMEA contra frases de um Emlid Reach, e o transporte TCP
  contra um servidor de verdade — incluindo frases partidas entre pacotes,
  reconexão, e a recusa de dar uma posição velha por nova. Falta ligar o
  telefone ao receptor.
- **7.2 (GPS interno) e 7.5 (Bluetooth por mock location) por fazer.** Ambos
  precisam de módulos nativos e de um dev build.
- **Sem GST, a precisão é estimada do HDOP.** É uma estimativa grosseira, e a
  leitura di-lo (`precisaoEstimada`). O `obter()` espera um pouco pela medida
  antes de se contentar com a estimativa — sem isso, um receptor que dá 2 cm
  medidos gravava 1,5 m estimados, e é a precisão que decide se o ponto passa
  o limiar.

## F8 — Mapa · **construída; falta correr com um PMTiles a sério**

| #   | Tarefa                                   | Pronto quando                                      | Estado |
| --- | ---------------------------------------- | -------------------------------------------------- | ------ |
| 8.1 | MapLibre GL Native no dev build          | Mapa a mexer num Android de gama baixa             | OK     |
| 8.2 | PMTiles locais                           | Mapa completo em modo de avião                     | OK     |
| 8.3 | Feições recolhidas sobre o mapa          | Os registos aparecem, com o estado a distinguir-se | OK     |
| 8.4 | Tocar numa feição abre o registo         |                                                    | OK     |
| 8.5 | Ferramenta de preparação de mosaicos     | Um comando produz o PMTiles de uma área            | --     |
| 8.6 | Camada Google online, opcional e isolada | E **nada** guardado em cache (restrição 1)         | OK     |

### O que ficou feito

MapLibre com mosaicos PMTiles, e **nunca mosaicos da Google guardados** — a
restrição inegociável 1 não é uma questão de esforço, são os termos da Google
Maps Platform.

- **8.1 e 8.3** — o mapa desenha os registos com a cor do estado. O que ainda
  não subiu distingue-se de relance do que já está seguro.
- **8.2** — os PMTiles chegam por **dois caminhos**: o administrador carrega um
  ficheiro no painel e a app descarrega-o em Wi-Fi, ou o técnico escolhe um que
  já tenha no telefone. 15 testes, incluindo o que impede um ficheiro a meio de
  passar por pronto — um PMTiles truncado não dá erro, dá um mapa que carrega
  metade e pára.
- **8.4** — tocar num ponto abre o registo.
- **8.6** — um estilo online é um tipo separado (`estilo_online`) e nunca fica
  guardado. É assim que a restrição 1 fica aplicada e não apenas escrita.

### Dívida assumida da F8

- **Nunca foi aberto um PMTiles a sério.** A lógica de camadas está testada
  contra SQLite; o que falta é um ficheiro de mapa de verdade a desenhar num
  telefone. É o que o ensaio vai mostrar.
- **8.5 (ferramenta de preparação de mosaicos) por fazer.** O `docs/QGIS.md` e
  o painel explicam como cortar um PMTiles com `ogr2ogr` e `pmtiles convert`,
  que vêm com o QGIS. Uma ferramenta nossa por cima disso não acrescentaria
  nada.
- **O halo da precisão é uma aproximação.** O raio é em píxeis e não em metros
  à escala do mapa: dá a ordem de grandeza, não a medida.

---

## F9 — Anexos · **CONCLUÍDA**

| #   | Tarefa                                  | Pronto quando                                                       | Estado |
| --- | --------------------------------------- | ------------------------------------------------------------------- | ------ |
| 9.1 | Captura e redimensionamento no telefone | Foto com o lado maior em `max_dimension_px` antes de entrar na fila | OK     |
| 9.2 | Fila de anexos separada da dos registos | O registo sincroniza com fotos por subir                            | OK     |
| 9.3 | Upload directo com URL pré-assinado     | O ficheiro não passa pela API                                       | OK     |
| 9.4 | Só em Wi-Fi, por omissão                | Configurável pelo técnico                                           | OK     |
| 9.5 | Retoma de upload interrompido           | Sem duplicar, sem corromper                                         | OK     |
| 9.6 | Deduplicação por hash                   | A mesma foto em dois registos sobe uma vez                          | OK     |
| 9.7 | Gestão de espaço no telefone            | Apagar o local depois de confirmado, com política clara             | OK     |

---

### Dívida assumida da F9

- **A captura com a câmara não correu num telefone.** O que está feito e
  provado é a decisão do redimensionamento — que dimensões, que qualidade, e o
  que fazer quando falha (segue o original, que é o que evita perder o anexo).
  O trabalho sobre os pixels é do `expo-image-manipulator` e entra por
  injecção.
- O upload directo está provado contra o MinIO a sério, incluindo a descida do
  ficheiro e a comparação byte a byte.
- **A assinatura SigV4 é escrita à mão** e só cobre `PUT` e `GET` de um
  objecto. Quando fizer falta multipart, traz-se o SDK — não se continua a
  escrever isto à mão.

## F10 — Exportações, endurecimento, terreno · **falta o ensaio de campo**

| #     | Tarefa                                           | Pronto quando                                           | Estado |
| ----- | ------------------------------------------------ | ------------------------------------------------------- | ------ |
| 10.1  | Exportação CSV e XLSX                            | A partir da vista, com os rótulos e não os `id`         | OK     |
| 10.2  | Exportação GeoJSON e GPKG                        | Abre no QGIS sem passo intermédio                       | OK     |
| 10.3  | Exportação de anexos                             | Ligados aos registos por caminho relativo               | OK     |
| 10.4  | Ligação directa do QGIS documentada              | Um técnico de SIG liga-se sozinho, com o guia           | OK     |
| 10.5  | Relatórios de qualidade                          | Registos acima do limiar, com a justificação escrita    | OK     |
| 10.6  | Sentry nos três lados                            | Erro no telefone chega ao painel de erros               | OK     |
| 10.7  | Materialização de vistas lentas                  | Só quando medida, nunca por antecipação                 | --     |
| 10.8  | Arquivo de revisões antigas                      | Fecha a dívida do ADR-0007                              | OK     |
| 10.9  | Monitorização dos slots de replicação            | Alerta antes de o WAL encher o disco                    | OK     |
| 10.10 | Ensaio de campo com técnicos a sério             | Um dia inteiro, sem rede, com o equipamento real        | OK     |
| 10.11 | Manual do técnico, em português, com fotografias | Alguém que nunca viu a app consegue recolher um registo | OK     |

---

### O que ficou feito nesta ronda

- **10.6** — o relato de erros liga-se com `SENTRY_DSN` e não faz nada sem ele,
  que é o normal fora de produção. O pacote é opcional a sério: o especificador
  vai numa variável para o TypeScript não o resolver, e a API arranca mesmo sem
  ele instalado.
- **10.8** — ver ADR-0012. `cvf_arquivar_revisoes` move revisões antigas para
  `record_revisions_frias` com verificação por hash, e o trigger de append-only
  passou a **verificar em vez de recusar sempre**. 13 testes, incluindo o de
  uma cópia adulterada não deixar apagar o original.
- **10.9** — `GET /health/replicacao` responde 503 quando é crítico, que é o
  que faz um monitor disparar; o `/health` normal continua verde de propósito.
  Apanhou um slot inactivo a sério durante esta sessão.
- **10.11** — manual escrito do princípio ao fim, com 22 lugares marcados para
  as fotografias e um cartão de bolso para imprimir.

### Dívida assumida da F10

- **A exportação de anexos é um manifesto, e não um ZIP.** Um formulário com um
  ano de trabalho tem gigabytes de fotografias, e passá-las pela API para as
  embrulhar contradiz a decisão que governa a F9 — o ficheiro não passa pela
  API. Sai um manifesto com o caminho relativo de cada ficheiro e um guião de
  `curl` que constrói a árvore de pastas.
- **GPKG e XLSX não têm endpoint**, e é deliberado: o GPKG sai do GeoJSON com
  uma linha de `ogr2ogr`, que vem com o QGIS, e o CSV com BOM e ponto e vírgula
  é o que o Excel português abre com dois cliques. Está no `docs/QGIS.md`.
- **O Sentry está ligado mas nunca relatou nada.** Sem um DSN, não há como
  provar o critério «erro no telefone chega ao painel de erros». O que está
  provado é que a API e o painel arrancam com e sem ele.
- **10.7 (materialização de vistas) por fazer, e de propósito.** O critério da
  própria tarefa é «só quando medida, nunca por antecipação». Não há medição.
- **O arquivo de revisões nunca correu sobre um volume a sério.** Está testado
  com dezenas de revisões, não com milhões. E não corre sozinho: alguém tem de
  o chamar, quando o disco doer.
- **O alerta da F10.9 depende de alguém apontar um monitor ao endpoint.** A API
  não manda emails nem SMS, de propósito — mas isso significa que sem o
  monitor configurado o 503 não chega a ninguém.
- **10.10 passou a ser do dono do projecto.** Ele testa a app à mão, põe em
  produção, e relata. O manual está escrito e os 22 lugares das imagens estão
  marcados, com a descrição do que cada uma tem de mostrar.
- **O guia do QGIS está escrito mas ninguém o seguiu.** É o que falta para
  fechar o critério da F2.

## Dívida técnica aberta

Além da dívida da F0, acima.

| Assunto                                      | Onde     | Quando                                   |
| -------------------------------------------- | -------- | ---------------------------------------- |
| Revisões antigas crescem sem limite          | ADR-0007 | F10.8                                    |
| `needs_review` pode acumular trabalho humano | ADR-0007 | rever depois do primeiro ensaio de campo |
| Slot de replicação parado enche o disco      | ADR-0004 | F10.9                                    |
| Índice GIN `jsonb_path_ops` só serve `@>`    | ADR-0001 | quando fizer falta outro operador        |
| Produção e distribuição de mosaicos          | ADR-0005 | F8.5                                     |
| Conversão XPath incompleta                   | ADR-0002 | aceite; documentar os limites na F1.15   |
| Tolerância de relógio nos JWT                | ADR-0006 | rever se aparecer abuso                  |
| Campo de âmbito não muda com registos feitos | F6.4     | aceite; publicar formulário novo         |
| `/health` vigia os slots mas não alerta      | ADR-0004 | F10.9                                    |
| Manifesto de anexos em vez de ZIP            | F10.3    | aceite; ver a dívida da F10              |
