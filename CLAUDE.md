# Consul Colect — contexto permanente

Lê isto no início de todas as sessões, antes do `PLANO.md` e do
`docs/FORM-SPEC.md`.

## O que isto é, numa frase

Uma plataforma onde **o formulário é dado e não código**: desenha-se no painel
web, o backend provisiona tudo sozinho, e a app móvel constrói os ecrãs a partir
de JSON sem nunca ter sido recompilada para esse formulário.

A especificação completa está em `ESPECIFICACAO.md`. Este ficheiro é o que não
cabe lá: como correr, como testar, e os erros a não repetir.

## Contexto humano que muda decisões técnicas

- **Equipa de 1 a 3 programadores, em Luanda.** Optimiza para pouca gente
  conseguir manter isto, não para elegância arquitectural. Uma abstracção a mais
  custa mais do que uma repetição a menos.
- **Utilizadores finais: técnicos de campo**, muitos sem hábito de smartphone,
  em zonas rurais com rede fraca e Android de gama baixa. Cada toque a mais e
  cada MB a mais custam dinheiro real, à empresa e ao técnico.
- **Perder um registo de campo é o pior defeito possível.** Vale mais duplicar
  do que perder. Quando estiveres em dúvida entre segurança dos dados e
  qualquer outra coisa, escolhe a segurança dos dados.
- **Fatias verticais que funcionam** valem mais do que camadas horizontais
  perfeitas. Uma fatia só está pronta quando se consegue correr e ver.

## Restrições inegociáveis

Copiadas literalmente do `ESPECIFICACAO.md` §8. Não as contornes; se alguma
estiver errada, discute-a antes de a violares.

1. **Nunca armazenar, pré-carregar ou cachear mosaicos do Google Maps para uso
   offline.** Os termos da Google Maps Platform proíbem-no. Offline é MapLibre
   com mosaicos próprios (PMTiles/MBTiles). O Google, se existir, é camada
   online opcional e isolada.
2. **A app escreve sempre primeiro no SQLite local.** Nenhum botão «Guardar»
   faz uma chamada HTTP.
3. **Todos os IDs são UUIDv7 gerados no cliente.**
4. **Nunca apagar nem sobrescrever uma revisão.** Só _soft delete_ com tombstone.
5. **Nenhum DDL por formulário publicado**, além das vistas da secção 3.
6. **Nenhum código específico de um formulário em qualquer parte do sistema.**
   Se aparecer um `if (form === 'local_consumo')`, o desenho falhou.
7. **Nada de `eval` na avaliação de expressões.**
8. **Todo o ponto guardado leva `accuracy_m`, `fix_type` e `source`.**
9. **Nenhum segredo no repositório**; nada de dados pessoais em logs.

Onde cada uma é aplicada, e não apenas escrita:

| #   | Aplicada por                                                                           |
| --- | -------------------------------------------------------------------------------------- |
| 1   | job `restricoes` no CI (`.github/workflows/ci.yml`)                                    |
| 2   | `apps/mobile/src/db/local.ts` é a fonte de verdade; a rede é sempre posterior          |
| 3   | Chave primária `uuid` em todas as tabelas; o cliente gera                              |
| 4   | Triggers `record_revisions_sem_update/delete` e `records_sem_delete` (migração `0001`) |
| 5   | Testes em `infra/db/test/invariantes.test.ts`                                          |
| 6   | job `restricoes` no CI                                                                 |
| 7   | `packages/form-core/test/sem-eval.test.ts` e job `restricoes`                          |
| 8   | Colunas `NOT NULL` + `CHECK` em `gps_fixes` (migração `0001`)                          |
| 9   | `.gitignore`, `redact` do pino em `app.module.ts`, job `restricoes`                    |

## Como correr

Precisas de Node 22+, pnpm 10+ e Docker.

```bash
pnpm install
cp .env.example .env          # ajusta o que for preciso
pnpm infra:up                 # Postgres+PostGIS, Keycloak, PowerSync, MinIO
pnpm db:migrate               # esquema
pnpm db:seed                  # organização, projecto e papéis de demonstração
pnpm dev                      # API (4000) + painel (3000)
```

App móvel (precisa de um _dev build_; o Expo Go não serve, por causa dos
módulos nativos do SQLite e do SecureStore):

```bash
# Criar o dev build (a primeira vez demora 20-40 min)
node node_modules/expo/bin/cli prebuild --platform android --clean
cd apps/mobile/android && ./gradlew assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Depois, o Metro. Com o telefone por cabo:
adb reverse tcp:8081 tcp:8081 && adb reverse tcp:4000 tcp:4000
node node_modules/expo/bin/cli start --dev-client
```

Com `adb reverse`, o `.env` da app usa `localhost` e não `10.0.2.2`.

Serviços em desenvolvimento:

| Serviço   | Endereço              | Credenciais                      |
| --------- | --------------------- | -------------------------------- |
| API       | http://localhost:4000 | —                                |
| Painel    | http://localhost:3000 | pelo Keycloak                    |
| Keycloak  | http://localhost:8080 | `admin` / `admin`                |
| PowerSync | http://localhost:8090 | —                                |
| MinIO     | http://localhost:9001 | `cvforms` / `cvforms-dev-secret` |

Utilizadores de demonstração: `admin.demo` / `demo` e `tecnico.demo` / `demo`.

Do emulador do Android, o teu computador é `10.0.2.2`, não `localhost`.

## Como testar

```bash
pnpm turbo run typecheck test build     # tudo
pnpm --filter @cvforms/form-core test   # só o form-core
pnpm --filter @cvforms/db test          # invariantes, contra um Postgres real
pnpm --filter @cvforms/api test         # autenticação ponta a ponta
```

Os testes do `@cvforms/db` e do `@cvforms/api` precisam de `DATABASE_URL`
apontada a um Postgres **com PostGIS**. Sem ela, são saltados em vez de
falharem — quem só mexe no `form-core` não precisa de Docker a correr.

**Nunca digas que algo está pronto sem correres os testes.** Se não correste,
diz que não correste.

## Convenções

- **Português** em nomes de domínio, comentários, mensagens de erro visíveis e
  mensagens de commit. Inglês nas palavras que já são termos técnicos
  (`record`, `bucket`, `hash`) e em tudo o que atravessa a fronteira com uma
  biblioteca.
- **Nomes de tabelas e colunas em inglês** (`record_revisions`, `created_at`):
  atravessam SQL, Drizzle, PowerSync e ferramentas GIS, e traduzi-los criaria
  fricção em todas essas fronteiras.
- Um commit por fatia vertical. A mensagem explica **porquê**, não o quê — o
  diff já diz o quê.
- Comentários explicam decisões e alternativas rejeitadas, não sintaxe.
- Nada de mocks nem dados falsos em código de produção, nem temporariamente.
  Dados de teste vivem em seeds (`infra/db/src/seed.ts`) e em fixtures.
- O que ficar por fazer vai para o `PLANO.md`. Nada de `TODO` perdido no código.

## Erros a não repetir

Cada linha aqui custou tempo. Acrescenta uma sempre que um erro se repetir.

- **O `emitDecoratorMetadata` do esbuild não existe.** O Vitest transforma com
  esbuild, que ignora o `emitDecoratorMetadata`, e a injecção de dependências
  do Nest chega aos construtores vazia — com erros que não têm nada que ver com
  o código em teste. `apps/api/vitest.config.ts` usa `unplugin-swc` por isso.
- **`disableHierarchicalLookup` parte o Metro num monorepo pnpm.** É o conselho
  que anda por aí para npm/yarn. Com o pnpm, as dependências transitivas vivem
  dentro do `.pnpm` e é a procura hierárquica que as encontra.
- **Não corras `typecheck` e `build` da mesma package em paralelo.** O
  `next build` reescreve o `next-env.d.ts` enquanto o `tsc` o lê. O
  `turbo.json` já força a ordem.
- **Nos testes, `SET session_replication_role = replica`, nunca
  `ALTER TABLE ... DISABLE TRIGGER`.** O segundo desliga os triggers para toda
  a base e pega num lock exclusivo: dois ficheiros de teste a correr ao mesmo
  tempo passam a falhar um pelo outro.
- **O JSON Schema tem `type: object` ao lado de `unevaluatedProperties`.** Sem
  isso o Ajv em modo estrito recusa-se a compilar, com uma mensagem que não
  ajuda nada.
- **A tolerância de relógio dos JWT é deliberada** (`JWT_CLOCK_TOLERANCE_S`).
  Se escreveres um teste de token expirado, expira-o para lá da tolerância,
  senão o teste falha por uma razão que não é a que julgas.
- **O `sql.json()` do `postgres` não atravessa fronteiras de pacote.** O driver
  reconhece o embrulho por `instanceof`; quando a API e o `@cvforms/db` carregam
  cópias diferentes do módulo, o `instanceof` falha e o embrulho segue como
  objecto vulgar. O erro que sai — `ERR_INVALID_ARG_TYPE` vindo de
  `Buffer.byteLength` — não aponta para nada. Em código de biblioteca, JSON vai
  como texto com `::jsonb` explícito.
- **O `turbo` só corre as packages do directório onde está.** Correr
  `pnpm turbo run test` de dentro de `apps/mobile` testa só o móvel, diz
  «Packages in scope: @cvforms/mobile» numa linha fácil de não ler, e sai a
  zero. Corre sempre da raiz.
- **`useRef<T>()` sem argumento não compila no React 19.** Passa
  `useRef<T | undefined>(undefined)`.
- **O `expo-sqlite` não aceita `undefined` nos parâmetros.** A interface
  `BaseLocal` declara-os obrigatórios de propósito; passa `[]` quando não há.
- **JSON como parâmetro é `${texto}::text::jsonb`, nunca `${texto}::jsonb`.**
  Com `::jsonb`, o Postgres descreve o parâmetro como `jsonb`, o driver
  re-serializa a string que já era JSON, e o que fica gravado é uma string JSON
  dentro de um `jsonb`. Não dá erro nenhum: o `jsonb_typeof` passa a `string` e
  **todas as colunas das vistas ficam a NULL**. Só aparece com `prepare: true`,
  o que faz com que passe nos testes e falhe em produção.
- **Um `Date` como parâmetro dentro de um fragmento de SQL perde o tipo** e sai
  `ERR_INVALID_ARG_TYPE`. Passa `${d.toISOString()}::timestamptz`.
- **Políticas RLS PERMISSIVE combinam-se por OR.** Uma política pensada para
  apertar o acesso, escrita como PERMISSIVE, ALARGA-o. Se a política é uma
  condição que tem de valer sempre, é `AS RESTRICTIVE`. Não há aviso.
- **Nunca escrevas um escape do género `NOT é_a_aplicação() OR …` numa
  política.** Falha aberto: basta a aplicação esquecer-se de pôr o contexto na
  sessão para passar a ver tudo. Sem contexto, zero linhas.
- **O Drizzle não se constrói sobre uma ligação reservada do `postgres`** sem
  lhe passar as `options` do pool — sai
  `Cannot read properties of undefined (reading 'parsers')`. É o que o
  `apps/api/src/db/contexto.ts` faz, e é por isso que o faz.
- **No SQLite, `EXISTS` correlacionado não é `IN (SELECT …)`.** Com `EXISTS`, o
  planeador conduz a consulta pela tabela grande e faz uma sondagem por linha;
  com `IN`, arranca do índice. Foram 153 ms contra 27 ms em 30 000 registos.
  Há um `EXPLAIN QUERY PLAN` no teste para isto não regredir.
- **Paginação sem desempate é não determinista.** `ORDER BY updated_at DESC`
  com carimbos iguais deixa a ordem ao planeador: entre duas páginas, uma linha
  pode repetir-se e outra desaparecer. O `id` vai sempre no fim do `ORDER BY` e
  dentro do índice.
- **Cuidado com crases dentro de _template literals_ de TypeScript.** Um
  comentário SQL com uma palavra entre crases fecha o literal, e o erro que sai
  aponta para uma linha muito depois.
- **O `docker compose up` sem `POSTGRES_PORT` põe o Postgres de volta no 5432**
  — onde costuma estar outro Postgres instalado na máquina. A ligação pega, e o
  erro que sai é `role "cvforms" does not exist`, que parece um problema de
  permissões e é um problema de porto. Levanta sempre com
  `POSTGRES_PORT=5433 docker compose ... up -d`.
- **Os checksums do NMEA calculam-se, não se inventam.** Uma frase com checksum
  errado é IGNORADA pelo analisador, em silêncio — o teste passa a provar o
  contrário do que diz. Há duas linhas de Python no histórico para os calcular.
- **A `GST` chega depois da `GGA`, e é ela que traz a precisão medida.** Quem
  devolver a primeira leitura que aparecer entrega a precisão ESTIMADA do HDOP:
  um receptor RTK que dá 2 cm medidos passa a gravar 1,5 m estimados, e é a
  precisão que decide se o ponto passa o limiar do formulário.
- **Num `BEFORE INSERT`, os triggers disparam por ordem alfabética do nome.**
  Um trigger que dependa de uma coluna preenchida por outro tem de a ir buscar
  sozinho — `record_revisions_ambito` corre antes de `record_revisions_form_id`
  e não pode contar com o `form_id`.
- **O teste de desempenho do `form-core` falha sob carga paralela.** «Cada
  toque custa menos de 100 ms» mede-se contra o relógio, e com sete pacotes a
  correr ao mesmo tempo numa máquina de desenvolvimento não é o código que
  está lento. Corre `pnpm turbo run test --concurrency=2` quando quiseres um
  veredicto, e não tires conclusões de uma falha isolada nesse teste.
- **Nunca guardar mosaicos do Google para offline.** Não é uma questão de
  esforço — são os termos da Google Maps Platform. O mapa offline é MapLibre
  com PMTiles próprios; um estilo online é um TIPO SEPARADO (`estilo_online`)
  precisamente para o que é online ficar online.
- **Um PMTiles truncado não dá erro.** Dá um mapa que carrega metade e pára, e
  quem está no terreno conclui que a área não tem mapa. Uma camada só conta
  como pronta quando o tamanho local bate certo com o esperado.
- **Sincronizar as camadas NÃO pode tocar no `ficheiro_uri`.** A lista do
  servidor diz o que existe, não o que este telefone já tem. Reescrevê-lo
  obrigaria a descarregar 300 MB a cada sincronização, e um técnico com dados
  móveis pagava isso do bolso.
- **O `S3_PUBLIC_ENDPOINT` não é decoração.** A assinatura SigV4 inclui o
  `host`: em produção a API fala com o MinIO por `http://minio:9000`, mas quem
  usa o URL é o telefone. Assinar com o nome interno dá um
  `SignatureDoesNotMatch` que não aponta para nada.
- **Num Dockerfile de monorepo, o `COPY` do código desfaz as ligações do
  workspace.** O `pnpm install` prepara-as, o `COPY` por cima apaga-as, e o
  `tsc` passa a não encontrar os tipos do `form-core`. Corre
  `pnpm install --frozen-lockfile --offline` depois do `COPY`.
- **Usa `pnpm deploy` e não um segundo `pnpm install --prod`.** O segundo volta
  a ir à rede e, numa ligação que deixa cair transferências, é onde a imagem
  falha. O `deploy` monta a pasta a partir do que já está instalado — e a
  imagem passou de 1,35 GB para 314 MB.
- **O Windows tem um limite de 260 caracteres e o `ninja` não o contorna.** O
  layout normal do pnpm (`node_modules/.pnpm/<nome>@<versão>_<hash>/…`)
  acrescenta ~90 caracteres a tudo, e a compilação nativa do Android passa o
  limite com um `Filename longer than 260 characters`. Activar o
  `LongPathsEnabled` no registo NÃO chega — o ninja não usa o prefixo `\?\`.
  É por isso que o `.npmrc` da raiz tem `node-linker=hoisted`.
- **Depois de mudar o `node-linker`, é preciso `expo prebuild --clean`.** O
  `settings.gradle` gerado guarda os caminhos absolutos que existiam na
  altura; sem regenerar, o Gradle continua a apontar para o `.pnpm` antigo e
  o erro repete-se com as tarefas todas `UP-TO-DATE`.
- **Nunca apagues `node_modules/.pnpm` à mão.** Mesmo com o linker plano, o
  pnpm continua a usá-lo como armazém; apagar deixa o `node_modules` cheio de
  ligações partidas e o erro que sai é `MODULE_NOT_FOUND` sem dizer de quê.
  Se for mesmo preciso, apaga também os `node_modules` de cada package e corre
  `pnpm install`.
- **Com o linker plano, `pnpm exec` de dentro de `apps/mobile` não encontra o
  `expo`.** Os binários ficam na raiz. Corre
  `node node_modules/expo/bin/cli <comando>` a partir da raiz.
- **Duas instâncias do Gradle na mesma pasta corrompem o build.** O erro é
  `Unable to delete directory … kotlin-classes`. Se interrompeste um build,
  corre `./gradlew --stop` antes de recomeçar.
- **A API não lê o `.env` sozinha.** O `pnpm dev` carrega-o pelo turbo; a
  correr o `main.ts` à mão é preciso `set -a; . ./.env; set +a` antes, senão
  falha com «Ambiente inválido» e uma lista de variáveis em falta.
- **O que corre ANTES do build não pode importar o barrel do `@cvforms/db`.**
  O `index.ts` reexporta o gerador de vistas, que importa o `form-core`
  compilado. O `migrate.ts` corre com `tsx` num clone limpo, onde `dist/` ainda
  não existe, e falha com
  `Cannot find module '…/@cvforms/form-core/dist/index.js'` — um erro que fala
  de módulos e não diz nada sobre migrações. Na máquina de quem desenvolve
  nunca acontece, porque o `dist/` já lá está de compilações anteriores. Importa
  de `./cliente.js`.
- **`NODE_ENV=development` no ambiente parte o `next build`.** O `.env` de
  desenvolvimento tem-no, e basta um `set -a; . ./.env` antes de compilar. O
  Next compila o React em modo de desenvolvimento, os dois runtimes misturam-se,
  e o erro que sai é
  «<Html> should not be imported outside of pages/_document» — que não tem
  nada que ver. Compila com `NODE_ENV=production`.
- **O Postgres do CI é levantado à mão e não como `service`.** Um serviço do
  runner não aceita argumentos de arranque, e este precisa de
  `wal_level=logical`: sem isso o teste do vigia da F10.9 não consegue criar um
  slot, e passaríamos a testar contra uma base configurada de outra maneira.
- **Nunca faças `throw` ao carregar um módulo que o `next build` toca.** O Next
  apanha a excepção enquanto pré-desenha as páginas de erro, cai na página do
  encaminhador antigo, e o que sai é
  «<Html> should not be imported outside of pages/_document» — que não tem nada
  que ver com o problema. Distinguir a compilação pelo `NEXT_PHASE` não serve:
  o Next não o define nos processos que pré-desenham.
- **Corre o `expo prebuild` de dentro de `apps/mobile`, nunca da raiz.** Sem
  `app.json`, o Expo trata a pasta onde está como se fosse a app: inventa os
  valores por omissão, escreve dependências no `package.json` e cria uma pasta
  `android/`. Foi assim que o `pnpm install --frozen-lockfile` do CI passou a
  falhar, e a mensagem — «specifiers in the lockfile don't match» — aponta para
  o lockfile, que estava certo.
- **Uma subconsulta dentro de uma política RLS aplica o RLS da tabela que lê.**
  É o que faz `record_revisions` herdar o filtro de `records` sem ter política
  própria. Uma função `SECURITY DEFINER` no meio quebra essa cadeia — às vezes
  é o que se quer, e às vezes é um buraco.

## Arquitectura em três frases

1. As respostas de todos os formulários vivem numa só tabela JSONB
   (`record_revisions`); o esquema físico nunca muda quando se publica um
   formulário. Ver ADR-0001.
2. As colunas tipadas que o QGIS e o Power BI consomem são **vistas** geradas
   ao publicar, em `cvf_views`. Criar e apagar vistas é barato e reversível.
3. `packages/form-core` é o único sítio onde as regras dos formulários existem,
   e corre igual no servidor e no telefone. Se uma regra for implementada duas
   vezes, vai divergir.

## Estado

Todas as fases estão construídas. A app corre num TECNO KL5 (Android 14) a
partir de um _dev build_ local, com o layout inspirado no KoboCollect e tema
claro/escuro a seguir o sistema. Falta o que só se prova com uso: um PMTiles a
sério no mapa, o cliente PowerSync no telefone, uma pessoa em frente a um QGIS,
e o ensaio de campo — que passou a ser do dono do projecto.

- Arrancar e testar em local: `docs/ARRANCAR-E-TESTAR.md`
- Pôr online: `docs/PRODUCAO.md`
- Manual do técnico: `docs/MANUAL-DO-TECNICO.md`

**Não passes para a fase seguinte sem o dono do projecto dizer.**
