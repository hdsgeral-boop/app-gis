# Ligar o QGIS ao Consul Colect

Para um técnico de SIG se ligar sozinho, sem pedir nada a um programador.

O que se liga não é a base de dados inteira: são as **vistas** que o Consul Colect
gera ao publicar cada formulário. São tabelas normais para o QGIS — colunas
tipadas, geometria a sério, índice espacial — e é essa a razão de existirem
(ADR-0001).

---

## O que precisas antes de começar

- QGIS 3.28 ou mais recente.
- Endereço, porto, nome da base e credenciais. **Pede um utilizador só de
  leitura** a quem administra a plataforma — não uses o utilizador da
  aplicação nem o dono das tabelas.
- Saber o `key` do projecto e do formulário. Vê-los no painel, em
  **Formulários** → a coluna «Chave».

---

## 1. Criar a ligação

`Camada` → `Adicionar camada` → `Adicionar camada PostGIS` → `Nova`.

| Campo         | Valor                                                   |
| ------------- | ------------------------------------------------------- |
| Nome          | Consul Colect — produção (ou o ambiente que fores usar) |
| Anfitrião     | o endereço do Postgres                                  |
| Porto         | 5432                                                    |
| Base de dados | `cvforms`                                               |
| Modo SSL      | **require** — nunca `disable` fora da tua máquina       |

Marca **«Guardar»** ao lado do utilizador e da senha só se o computador for
teu e tiver senha de sessão. Um QGIS com credenciais guardadas num portátil
partilhado é uma base de dados aberta a quem se sentar lá.

Marca também **«Listar apenas as tabelas com geometria»** — reduz a lista às
vistas que interessam.

---

## 2. Encontrar a camada certa

As vistas vivem no esquema `cvf_views` e chamam-se assim:

```
v_<projecto>_<formulario>_actual      ← é esta que queres, quase sempre
v_<projecto>_<formulario>_v1          ← só os registos recolhidos com a versão 1
v_<projecto>_<formulario>_v2          ← idem, versão 2
v_<projecto>_<formulario>_<repetivel>_actual
```

**Usa sempre a `_actual`.** Tem todos os registos do formulário, projectados
com as colunas da versão corrente, e uma coluna `form_version` a dizer com que
versão cada um foi recolhido. As vistas `_v1`, `_v2` existem para quando
precisares exactamente dos registos de uma versão — uma auditoria, uma
migração — e não para o trabalho do dia a dia.

Se publicares uma versão nova do formulário, a `_actual` passa a ter as colunas
novas **sem tu fazeres nada**. As camadas que já tens abertas continuam a
funcionar; os campos novos aparecem vazios nos registos antigos.

---

## 3. O que vais encontrar nas colunas

| Coluna                  | O que é                                                             |
| ----------------------- | ------------------------------------------------------------------- |
| `record_id`             | Identificador do registo. É por aqui que se junta às vistas-filhas. |
| `geom`                  | `geometry(Point,4326)`. É a coluna de geometria da camada.          |
| `status`                | `rascunho`, `submetido`, `validado`, `rejeitado`, `needs_review`.   |
| `form_version`          | Versão do formulário com que aquele registo foi recolhido.          |
| `<nome do campo>`       | Uma coluna por campo, com o `name` que o administrador lhe deu.     |
| `<geopoint>_accuracy_m` | Precisão do ponto, em metros.                                       |
| `<geopoint>_fix_type`   | `fixed`, `float`, `dgps`, `single`… A qualidade do fixo GNSS.       |
| `<geopoint>_source`     | `internal`, `external_bt`, `external_tcp`, `manual`.                |
| `<select_multiple>`     | `text[]`.                                                           |
| `<select_multiple>_txt` | O mesmo, junto por espaços, para compatibilidade com ODK/Kobo.      |
| `scope_value`           | O âmbito do registo, se o formulário tiver um (ex.: o município).   |

O **comentário de cada coluna** tem o `id` interno do campo. No QGIS vê-se em
`Propriedades da camada` → `Campos` → coluna `Comentário`. Serve para quando
alguém renomeia uma pergunta e tu precisas de saber que é a mesma.

**Não confies no `status` para saber o que é bom.** `needs_review` significa
que houve um conflito de sincronização ou que a validação falhou; esses
registos precisam de olhos humanos antes de entrarem num mapa que alguém vai
usar para decidir alguma coisa.

---

## 4. Filtrar pela qualidade do ponto

O filtro que vale a pena guardar, em `Propriedades da camada` → `Fonte` →
`Consulta`:

```sql
localizacao_accuracy_m <= 2 AND localizacao_fix_type IN ('fixed', 'float')
```

Troca `localizacao` pelo `name` do teu campo de geometria. Isto deixa de fora
os pontos recolhidos com GPS de telemóvel sem correcções, que num cadastro de
rede não servem para posicionar equipamento.

Para ver **o que ficou de fora e porquê**, o painel tem o relatório de
qualidade em `Formulários` → o formulário → `Qualidade`: lista os pontos acima
do limiar com a justificação que o técnico escreveu.

---

## 5. Repetíveis: juntar a vista-filha

Um formulário com um repetível gera uma vista por nível. Para ver os contadores
de cada local de consumo:

```sql
SELECT m.codigo, m.geom, f.idx, f.numero_serie
FROM cvf_views.v_piloto_local_consumo_actual m
JOIN cvf_views.v_piloto_local_consumo_contadores_actual f
  ON f.record_id = m.record_id
```

`idx` começa em **zero** e é a posição da instância dentro do registo. Num
repetível dentro de outro repetível há uma coluna de índice por nível
(`contadores_idx`, e depois `idx`).

No QGIS, `Camada` → `Adicionar camada` → `Adicionar camada PostGIS` →
`Consulta SQL`, e escolhe `geom` como coluna de geometria e `record_id` como
identificador único.

---

## 6. Exportar sem QGIS

Quando é só para entregar um ficheiro a alguém, o painel exporta directamente:

```
GET /admin/exports/{form_id}?format=csv       CSV com BOM, para o Excel
GET /admin/exports/{form_id}?format=geojson   GeoJSON, abre em qualquer SIG
GET /admin/exports/{form_id}?format=csv&bbox=13.0,-9.0,13.5,-8.5
```

Os cabeçalhos são os rótulos das perguntas, e não os identificadores internos.

**Anexos:** o painel não devolve um ZIP — um formulário com um ano de trabalho
tem gigabytes de fotografias, e passá-las pela API para as embrulhar deitava-a
abaixo. O que sai é um manifesto e um guião que os vai buscar directamente ao
armazenamento:

```
GET /admin/exports/{form_id}/anexos?format=sh   > descarregar.sh
sh descarregar.sh
```

Fica uma pasta `anexos/<record_id>/<pergunta>.jpg` ao lado do CSV, e é pelo
`record_id` que se ligam. O `format=csv` dá o mesmo manifesto para arquivo,
sem os URLs — que são assinados, expiram, e não têm nada que fazer num
ficheiro guardado.

**GeoPackage:** não há endpoint. Sai do GeoJSON com o `ogr2ogr`, que vem com o
QGIS:

```bash
ogr2ogr -f GPKG local_consumo.gpkg local_consumo.geojson
```

Duas linhas, e evita ter no servidor uma dependência de GDAL que só serve para
isto.

---

## 7. Quando não aparece nada

Por ordem do mais provável:

1. **A camada aparece vazia.** O formulário ainda não tem registos submetidos,
   ou o utilizador da ligação não tem acesso a esse formulário. O isolamento
   por organização e por atribuição é aplicado pelo Postgres (RLS), não pela
   aplicação — um utilizador sem acesso vê zero linhas, sem erro nenhum.
2. **Vês uns registos e não outros.** A tua atribuição tem um **filtro de
   âmbito** (ex.: só um município). Um registo cujo campo de âmbito esteja por
   responder também não aparece: sem âmbito conhecido, não se atribui a âmbito
   nenhum. Quem administra vê e muda isso em Formulários → Atribuições.
3. **A vista não aparece na lista.** Ou o formulário nunca foi publicado, ou
   foi arquivado — arquivar apaga as vistas e não apaga nenhum registo.
4. **Uma coluna que existia desapareceu.** Alguém removeu o campo numa versão
   nova. Os dados continuam lá: usa a vista `_v<n>` da versão em que o campo
   existia.
5. **Uma coluna mudou de nome.** Alguém renomeou a pergunta. O `id` no
   comentário da coluna é o mesmo — os dados não se mexeram.
