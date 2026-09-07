# Consul Colect — especificação do formato de definição de formulário

`spec_version: 1`

Este é o **contrato entre as três aplicações**: a API que valida e publica, o
painel que constrói, e a app móvel que renderiza. É o documento mais importante
do repositório. Alterá-lo obriga a alterar todas as três, e a subir a
`spec_version`.

A fonte da verdade executável é
`packages/form-core/src/schema/form-definition.schema.ts` (JSON Schema
2020-12). O ficheiro `form-definition.schema.json`, ao lado, é gerado a partir
dele para consumidores externos; o CI falha se dessincronizar. Este documento
explica o que o schema não consegue dizer: o porquê, e as regras semânticas que
só o validador da F1 verifica.

---

## 1. A regra que atravessa tudo

> **`id` é imutável e gerado pelo sistema. `name` é editável pelo humano.
> Os dados guardam-se sempre por `id`.**

Um registo é um objecto JSON cujas chaves são `id` de campos:

```json
{ "f_cod": "LC000123", "f_tipo": "industrial", "f_pot": 250 }
```

Renomear a pergunta «Código do local» para «Código de identificação» muda o
`label`. Mudar o `name` de `codigo` para `codigo_identificacao` muda o nome da
coluna nas vistas PostGIS e no XLSForm exportado. **Nenhuma das duas coisas toca
nos dados.**

É a diferença entre esta plataforma e o XLSForm, onde `name` é ao mesmo tempo o
identificador dos dados e o rótulo editável — e renomear perde o que já foi
recolhido. Ver ADR-0002.

Consequências práticas:

- Um `id` **nunca** é reutilizado, nem sequer depois de o campo ser apagado.
- Um `id` gerado é opaco e curto (`f_cod`, `g_cont`). Não tem de significar
  nada, porque nunca é lido por um humano em contexto de dados.
- Um `name` tem de ser único dentro do seu âmbito e tem de ser um identificador
  SQL seguro. O schema garante o segundo; o validador da F1 garante o primeiro.

---

## 2. Estrutura de topo

```json
{
  "spec_version": 1,
  "form_id": "0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d40",
  "version": 4,
  "published_at": "2026-09-05T10:00:00Z",
  "title": { "pt": "Local de Consumo" },
  "settings": {},
  "fields": [],
  "choice_lists": {}
}
```

| Campo          | Obrigatório | Notas                                                    |
| -------------- | ----------- | -------------------------------------------------------- |
| `spec_version` | sim         | Versão do **formato**, não do formulário. Hoje só `1`.   |
| `form_id`      | sim         | UUID do formulário. Estável entre versões.               |
| `version`      | sim         | Inteiro ≥ 1, crescente. Uma versão publicada é imutável. |
| `title`        | sim         | Rótulo multilingue. `pt` obrigatório.                    |
| `published_at` | não         | Ausente enquanto for rascunho.                           |
| `settings`     | não         | Ver §3.                                                  |
| `fields`       | sim         | Pelo menos um.                                           |
| `choice_lists` | não         | Listas de escolha internas, por chave.                   |

Propriedades desconhecidas são **recusadas** (`additionalProperties: false`),
no topo e em cada campo. É deliberado: uma propriedade mal escrita tem de dar
erro ao publicar, e não ser ignorada em silêncio até alguém dar por ela em
campo.

---

## 3. `settings`

```json
{
  "max_accuracy_m": 2.0,
  "allow_edit_after_submit": true,
  "geometry_field": "f_geo",
  "languages": ["pt", "en"],
  "default_language": "pt",
  "record_label": { "op": "coalesce", "args": ["$f_cod", "(sem código)"] }
}
```

| Chave                     | Significado                                                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `max_accuracy_m`          | Limiar de precisão, em metros, para os campos de geometria. Acima dele a app avisa e só grava com justificação escrita, que fica na revisão. Um campo pode ter o seu próprio limiar, que se sobrepõe a este. |
| `allow_edit_after_submit` | Se `false`, um registo `submetido` só volta a ser editável por quem tiver `can_edit_all`.                                                                                                                    |
| `geometry_field`          | `id` do campo `geopoint` que alimenta `records.geom`. Sem ele, o registo não aparece no mapa nem responde a consultas por bbox.                                                                              |
| `languages`               | Idiomas disponíveis. `pt` é sempre o primeiro.                                                                                                                                                               |
| `record_label`            | Expressão que produz o texto do registo nas listagens. Avaliada no âmbito raiz.                                                                                                                              |

---

## 4. Rótulos multilingues

Todos os rótulos são objectos, mesmo quando só existe português:

```json
{ "pt": "Potência contratada (kVA)", "en": "Contracted power (kVA)" }
```

`pt` é **obrigatório**. Nunca uma string solta. Acrescentar um idioma mais tarde
não pode obrigar a converter formulários já publicados — e não obriga, porque a
forma já é a definitiva desde o primeiro dia.

---

## 5. Campos

### 5.1 Propriedades comuns

| Propriedade          | Tipo      | Notas                                                                                   |
| -------------------- | --------- | --------------------------------------------------------------------------------------- |
| `id`                 | string    | Obrigatório. `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`. Imutável.                                 |
| `name`               | string    | Obrigatório. Mesmo padrão. Editável.                                                    |
| `type`               | enum      | Obrigatório. Um dos 22 tipos abaixo.                                                    |
| `label`              | rótulo    | Visível ao utilizador.                                                                  |
| `hint`               | rótulo    | Texto de apoio por baixo do campo.                                                      |
| `required`           | boolean   | Só se aplica quando o campo é relevante.                                                |
| `readonly`           | boolean   | Um campo com `calculation` é sempre `readonly`.                                         |
| `relevant`           | expressão | O campo só existe, e só é validado, quando isto for verdadeiro.                         |
| `constraint`         | expressão | Restrição sobre o próprio valor. `$self` refere-se a este campo.                        |
| `constraint_message` | rótulo    | Mostrado quando a restrição falha. Escreve-o: a mensagem por omissão não ajuda ninguém. |
| `calculation`        | expressão | Valor derivado. Recalculado a cada alteração das suas dependências.                     |
| `searchable`         | boolean   | Marca o campo para índice GIN e para a pesquisa da app.                                 |
| `projected`          | boolean   | Se `false`, não aparece como coluna nas vistas. Por omissão, `true`.                    |
| `default`            | literal   | Valor inicial.                                                                          |
| `appearance`         | string    | Sugestão de apresentação para a app (ex.: `"horizontal"`). A app pode ignorá-la.        |

Sobre padrões restritivos em `id` e `name`: o `name` vai directamente para
identificadores SQL no gerador de vistas. Aceitar espaços, acentos ou aspas
aqui abriria a porta a injecção de SQL. O saneamento no gerador é a segunda
linha de defesa; **esta é a primeira**.

### 5.2 Os 22 tipos

Um exemplo por tipo. Todos passam pelo validador — estão em
`packages/form-core/test/fixtures/todos-os-tipos.json` e há um teste que falha
se algum tipo deixar de estar coberto.

#### `text`

```json
{
  "id": "f_cod",
  "type": "text",
  "name": "codigo",
  "label": { "pt": "Código do local" },
  "required": true,
  "searchable": true,
  "max_length": 120,
  "multiline": false,
  "constraint": { "op": "matches", "args": ["$self", "^LC[0-9]{6}$"] },
  "constraint_message": { "pt": "Formato esperado: LC000000" }
}
```

Valor: `string`. Coluna na vista: `text`.

#### `note`

```json
{
  "id": "f_aviso",
  "type": "note",
  "name": "aviso",
  "label": { "pt": "Confirma o número de série antes de continuar." }
}
```

Não guarda valor e não gera coluna. Serve para instruções no meio do formulário.

#### `integer`

```json
{
  "id": "f_n",
  "type": "integer",
  "name": "numero_postes",
  "label": { "pt": "Número de postes" },
  "min": 0,
  "max": 999
}
```

Valor: inteiro. Coluna: `integer`.

#### `decimal`

```json
{
  "id": "f_pot",
  "type": "decimal",
  "name": "potencia",
  "label": { "pt": "Potência contratada (kVA)" },
  "min": 0,
  "max": 1000,
  "decimals": 2
}
```

Valor: número. Coluna: `numeric`. `decimals` é apresentação e arredondamento
na app; não é uma restrição de armazenamento.

#### `boolean`

```json
{ "id": "f_lig", "type": "boolean", "name": "ligado", "label": { "pt": "Está ligado à rede?" } }
```

Valor: `true` | `false`. Coluna: `boolean`.

#### `select_one`

```json
{
  "id": "f_tipo",
  "type": "select_one",
  "name": "tipo",
  "label": { "pt": "Tipo de instalação" },
  "choices_ref": "lista_tipos",
  "required": true,
  "allow_other": false
}
```

Valor: `string` (o `value` da opção). Coluna: `text`.
Com `allow_other: true`, um valor fora da lista é aceite e a app oferece um
campo de texto.

#### `select_multiple`

```json
{
  "id": "f_serv",
  "type": "select_multiple",
  "name": "servicos",
  "label": { "pt": "Serviços presentes" },
  "choices_ref": "lista_servicos",
  "min_selected": 1,
  "max_selected": 3
}
```

Valor: `string[]`. Colunas: `text[]` mais uma coluna `<name>_txt` com os valores
juntos por espaço, para compatibilidade com ODK/Kobo.

#### `date`, `time`, `datetime`

```json
{ "id": "f_data", "type": "date", "name": "data_visita", "label": { "pt": "Data da visita" } }
```

Valores: `"2026-09-05"`, `"14:30"`, `"2026-09-05T14:30:00Z"`.
Colunas: `date`, `time`, `timestamptz`. **Tudo em UTC.** A apresentação
converte para `Africa/Luanda`; o armazenamento nunca.

#### `geopoint`

```json
{
  "id": "f_geo",
  "type": "geopoint",
  "name": "localizacao",
  "label": { "pt": "Localização" },
  "required": true,
  "max_accuracy_m": 2
}
```

Valor:

```json
{
  "lat": -8.8383,
  "lon": 13.2344,
  "alt": 68.4,
  "accuracy_m": 0.018,
  "fix_type": "fixed",
  "source": "external_tcp",
  "collected_at": "2026-09-05T14:30:00Z"
}
```

`accuracy_m`, `fix_type` e `source` são **obrigatórios em todo o ponto
guardado** (restrição inegociável 8). `fix_type` ∈ `{single, dgps, float,
fixed, has_ppp, manual, unknown}`; `source` ∈ `{internal, external_bt,
external_tcp, manual}`.
Coluna: `geometry(Point,4326)`, mais `<name>_accuracy_m`, `<name>_fix_type` e
`<name>_source`.

#### `geotrace`, `geoshape`

Mesma estrutura de metadados, valor com array de vértices.
Colunas: `geometry(LineString,4326)` e `geometry(Polygon,4326)`.

#### `photo`

```json
{
  "id": "f_foto",
  "type": "photo",
  "name": "foto_contador",
  "label": { "pt": "Foto do contador" },
  "max_count": 3,
  "max_dimension_px": 1600
}
```

Valor: array de `id` de anexos. `max_dimension_px` é o lado maior depois de
redimensionar **no telefone**, antes de entrar na fila — a rede de campo é
cara e lenta, e enviar 12 MP não serve ninguém.

#### `audio`, `file`, `signature`

```json
{
  "id": "f_ass",
  "type": "signature",
  "name": "assinatura_cliente",
  "label": { "pt": "Assinatura do cliente" }
}
```

Valor: `id` de anexo. `audio` aceita `max_duration_s`; `file` aceita `accept`
com tipos MIME.

#### `barcode`

```json
{
  "id": "f_cb",
  "type": "barcode",
  "name": "codigo_barras",
  "label": { "pt": "Código de barras" },
  "formats": ["qr", "code128"]
}
```

Valor: `string`. Coluna: `text`.

#### `calculate`

```json
{
  "id": "f_total",
  "type": "calculate",
  "name": "total",
  "label": { "pt": "Total" },
  "calculation": { "op": "sum", "args": ["$g_cont", "f_leitura"] }
}
```

Nunca editável. Recalculado sempre que uma dependência muda. Coluna com o tipo
que a expressão produz.

#### `group`

```json
{ "id": "g_id", "type": "group", "name": "identificacao",
  "label": { "pt": "Identificação" }, "collapsed": false,
  "fields": [ ... ] }
```

Agrupa visualmente. **Não cria nível nos dados**: os campos de dentro ficam no
mesmo âmbito e as suas colunas aparecem na mesma vista.

#### `repeat`

```json
{ "id": "g_cont", "type": "repeat", "name": "contadores",
  "label": { "pt": "Contadores" }, "min": 0, "max": 10,
  "instance_label": { "op": "coalesce", "args": ["$f_ns", "novo contador"] },
  "fields": [ ... ] }
```

Valor: array de objectos. **Cria nível nos dados** e gera uma **vista-filha**,
ligada por `record_id` + `idx`. Repetíveis podem ser aninhados.

Nada de achatar em colunas `_1`, `_2`, `_3`: com `max: 10` seriam dez colunas
por campo, quase todas vazias, e mudar o `max` alteraria o esquema da vista.

#### `reference`

```json
{
  "id": "f_pt",
  "type": "reference",
  "name": "posto_transformacao",
  "label": { "pt": "Posto de transformação" },
  "target_form_id": "0192f3a1-4c2b-7d31-9a55-0f7c1b2e3d42",
  "display_fields": ["f_cod", "f_nome"],
  "filter": { "op": "==", "args": ["$f_municipio", "$..f_municipio"] }
}
```

Valor: UUID do registo apontado. Aponta por `form_id`, nunca pela `key`, que é
editável. Coluna: `uuid`, com chave estrangeira lógica na vista.

---

## 6. Linguagem de expressões

Uma expressão é um objecto `{ "op": ..., "args": [...] }`. **AST, nunca texto
interpretado.** Não há `eval`, não há `new Function()`, não há strings avaliadas
em tempo de execução (restrição inegociável 7). O mesmo avaliador, do mesmo
pacote, corre no telefone e no servidor. Ver ADR-0003.

### 6.1 Referências

| Forma        | Significado                                                               |
| ------------ | ------------------------------------------------------------------------- |
| `"$self"`    | O valor do campo onde a expressão está declarada. Só em `constraint`.     |
| `"$f_cod"`   | O valor do campo com `id` `f_cod`. **Sempre por `id`, nunca por `name`.** |
| `"$..f_mun"` | O valor de `f_mun` no âmbito pai. Só faz sentido dentro de um `repeat`.   |

Uma string que não comece por `$` é um literal. Para um literal que comece
mesmo por `$`, escreve-o como `{"op":"concat","args":["$","texto"]}`.

### 6.2 Operadores

Os 36 operadores da versão 1. O conjunto é **fechado**: acrescentar um é uma
alteração ao formato.

| Operador                             | Aridade | Significado                                          | Exemplo                                                               |
| ------------------------------------ | ------- | ---------------------------------------------------- | --------------------------------------------------------------------- |
| `==`                                 | 2       | igualdade                                            | `{"op":"==","args":["$f_tipo","industrial"]}`                         |
| `!=`                                 | 2       | desigualdade                                         | `{"op":"!=","args":["$f_estado","anulado"]}`                          |
| `<` `<=` `>` `>=`                    | 2       | comparação numérica ou de datas                      | `{"op":">","args":["$f_pot",100]}`                                    |
| `between`                            | 3       | `args[0]` entre `args[1]` e `args[2]`, inclusive     | `{"op":"between","args":["$self",0,1000]}`                            |
| `and` `or`                           | 2+      | conjunção e disjunção                                | `{"op":"and","args":[{…},{…}]}`                                       |
| `not`                                | 1       | negação                                              | `{"op":"not","args":[{"op":"is_null","args":["$f_cod"]}]}`            |
| `+` `-` `*` `/`                      | 2+      | aritmética; `/` por zero devolve `null`              | `{"op":"*","args":["$f_qtd","$f_preco"]}`                             |
| `round`                              | 1–2     | arredonda a `args[1]` casas (0 por omissão)          | `{"op":"round","args":["$f_media",2]}`                                |
| `matches`                            | 2       | expressão regular sobre `args[0]`                    | `{"op":"matches","args":["$self","^LC[0-9]{6}$"]}`                    |
| `starts_with` `ends_with` `contains` | 2       | texto                                                | `{"op":"contains","args":["$f_obs","avaria"]}`                        |
| `length`                             | 1       | comprimento do texto ou do array                     | `{"op":"length","args":["$f_cod"]}`                                   |
| `concat`                             | 2+      | junta textos, ignorando `null`                       | `{"op":"concat","args":["$f_rua"," ","$f_num"]}`                      |
| `upper` `lower` `trim`               | 1       | texto                                                | `{"op":"upper","args":["$f_cod"]}`                                    |
| `in`                                 | 2       | `args[0]` pertence à lista `args[1]`                 | `{"op":"in","args":["$f_tipo",["a","b"]]}`                            |
| `selected`                           | 2       | `args[1]` está seleccionado num `select_multiple`    | `{"op":"selected","args":["$f_serv","agua"]}`                         |
| `count`                              | 1       | número de instâncias de um repetível                 | `{"op":"count","args":["$g_cont"]}`                                   |
| `count_selected`                     | 1       | número de opções escolhidas                          | `{"op":"count_selected","args":["$f_serv"]}`                          |
| `sum`                                | 2       | soma um campo em todas as instâncias de um repetível | `{"op":"sum","args":["$g_cont","f_leitura"]}`                         |
| `is_null`                            | 1       | verdadeiro se vazio, `null` ou string vazia          | `{"op":"is_null","args":["$f_pot"]}`                                  |
| `coalesce`                           | 2+      | primeiro argumento não nulo                          | `{"op":"coalesce","args":["$f_cod","(sem código)"]}`                  |
| `today`                              | 0       | data de hoje, em UTC                                 | `{"op":"today","args":[]}`                                            |
| `now`                                | 0       | instante actual, em UTC                              | `{"op":"now","args":[]}`                                              |
| `date_diff_days`                     | 2       | dias inteiros entre duas datas                       | `{"op":"date_diff_days","args":["$f_data",{"op":"today","args":[]}]}` |
| `distance_m`                         | 2       | distância em **metros** entre dois `geopoint`        | `{"op":"distance_m","args":["$f_geo","$f_ref"]}`                      |
| `if`                                 | 3       | condicional                                          | `{"op":"if","args":[{…},"sim","não"]}`                                |

**`today` e `now` não são deterministas.** São a única excepção, e existem
porque um formulário sem data corrente é inútil. Nunca os uses num
`constraint` cujo resultado tenha de ser reproduzível: um registo validado ontem
pode deixar de o ser hoje. O validador da F1 avisa quando isso acontecer.

### 6.3 Semântica de nulos

- Um campo não relevante é `null` e **não é validado**, mesmo que seja
  `required`.
- Comparações com `null` dão `null`, não `false`. `null` num contexto booleano
  conta como `false`.
- `and` e `or` fazem curto-circuito.

---

## 7. Listas de escolha

```json
{
  "choice_lists": {
    "lista_tipos": [
      { "value": "domestico", "label": { "pt": "Doméstico" } },
      { "value": "industrial", "label": { "pt": "Industrial" } },
      {
        "value": "outro",
        "label": { "pt": "Outro" },
        "relevant": { "op": "==", "args": ["$f_avancado", true] }
      }
    ]
  }
}
```

`value` é o que fica guardado e nunca deve mudar depois de haver dados. `label`
é o que se vê e pode mudar à vontade — a mesma separação de `id` e `name`.

`relevant` numa opção dá cascatas: a opção só aparece quando a expressão for
verdadeira.

Listas externas grandes (municípios, comunas) não vão na definição: vão no
manifesto do formulário, com hash próprio, para poderem ser actualizadas sem
publicar uma versão nova.

---

## 8. O que o schema não verifica

O JSON Schema garante a **forma**. Estas regras são semânticas e cabem ao
validador do `form-core` (F1). Uma definição que falhe qualquer uma delas é
recusada ao publicar:

1. **`id` duplicados**, em qualquer nível da árvore.
2. **`name` duplicados dentro do mesmo âmbito.** Âmbitos diferentes podem
   repetir, porque geram vistas diferentes.
3. **Ciclos** em `relevant` e `calculation`. `A` depende de `B` que depende de
   `A` é um formulário que nunca estabiliza.
4. **Referências a campos inexistentes** em qualquer expressão.
5. **`choices_ref` para uma lista que não existe.**
6. **`target_form_id` para um formulário que não existe**, ou que está noutra
   organização.
7. **`geometry_field` que não aponta para um `geopoint`.**
8. **`$self` fora de um `constraint`.**
9. **`$..x` fora de um `repeat`.**
10. **Aridade errada** de um operador.
11. **`sum` e `count` sobre algo que não é um repetível.**
12. **`calculation` num campo que não é `calculate` e não é `readonly`** — um
    campo calculado que o utilizador possa editar produz dados contraditórios.

---

## 9. Versões e diff

Uma versão publicada é **imutável**, garantido por trigger no Postgres. Editar
cria a versão seguinte.

Ao publicar, o backend calcula o diff contra a versão anterior e classifica-o:

**Compatível** — os registos existentes continuam a ler-se sem ambiguidade:

- acrescentar um campo;
- acrescentar uma opção a uma lista;
- alterar `label`, `hint`, `appearance`, `constraint_message`;
- alterar `name` (muda a coluna da vista, não os dados);
- tornar um campo obrigatório **menos** restritivo;
- alargar uma restrição.

**Incompatível** — exige confirmação explícita do administrador:

- remover um campo;
- alterar o `type` de um campo;
- remover uma opção de uma lista que já tem dados;
- apertar uma restrição de forma que invalide registos existentes;
- alterar `geometry_field`.

**Publicar nunca reescreve registos existentes.** Um registo criado com a versão
3 continua a ler-se e a editar-se com a versão 3, mesmo depois de a 4 sair.
Migrar dados antigos é uma operação separada, explícita, pré-visualizável e
reversível.

---

## 10. Ponte com o XLSForm

A importação e a exportação existem para que formulários do Kobo, do ODK e do
Survey123 entrem no primeiro dia. A conversão tem **perdas nos dois sentidos**,
e a ferramenta diz sempre o que se perdeu.

| XLSForm                       | Consul Colect                                            |
| ----------------------------- | -------------------------------------------------------- |
| coluna `name`                 | `name` — e um `id` **gerado**, porque o XLSForm não tem  |
| coluna `type`                 | `type`, com correspondência directa na maioria dos casos |
| `label::Português (pt)`       | `label.pt`                                               |
| `relevant` (XPath)            | `relevant` (AST), quando convertível                     |
| `constraint` (XPath)          | `constraint` (AST), quando convertível                   |
| `calculation` (XPath)         | `calculation` (AST), quando convertível                  |
| `choices`                     | `choice_lists`                                           |
| `begin group` / `end group`   | `group`                                                  |
| `begin repeat` / `end repeat` | `repeat`                                                 |

Limites conhecidos, e assumidos:

- **Nem todo o XPath converte.** `indexed-repeat`, `pulldata`, funções de
  instância externa e a maior parte da aritmética de datas não têm equivalente.
  O importador falha nessas linhas com a linha e a expressão exactas, em vez de
  as descartar em silêncio.
- **`reference` não tem equivalente** e não sobrevive à exportação.
- **Reimportar um formulário exportado gera `id` novos.** Não faças isso a um
  formulário que já tem dados: é a única forma de perder a ligação entre a
  definição e as respostas, e é por isso que fica escrito aqui.

---

## 11. Exemplo completo

O exemplo de referência é
`packages/form-core/test/fixtures/local-consumo.json`, e há um teste que falha
se ele deixar de validar. Uma definição com um campo de cada tipo está em
`todos-os-tipos.json`, ao lado.
