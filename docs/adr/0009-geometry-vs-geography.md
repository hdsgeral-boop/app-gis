# ADR-0009 — `geometry(Point,4326)` e não `geography`

**Estado:** aceite · **Data:** 2026-09-05
**Nota:** altera o que o `ESPECIFICACAO.md` §7 dizia (`geography(Point,4326)`).

## Contexto

A especificação escrevia `geom geography(Point,4326)`. O `geography` do PostGIS
calcula distâncias e áreas no elipsóide, o que dá resultados correctos em
metros sem reprojectar. Parece a escolha óbvia para dados de Angola, longe de
qualquer zona UTM cómoda.

## Decisão

`records.geom` é **`geometry(Point,4326)`**, com índice GiST. As vistas geradas
projectam `geometry(Point,4326)`.

Distâncias em metros fazem-se com `ST_DistanceSphere`, ou reprojectando para
UTM 33S (EPSG:32733) quando a precisão o exigir.

## Alternativas rejeitadas

**`geography(Point,4326)`, como estava na especificação.** Rejeitada por causa
de quem consome os dados, que é a razão de as vistas existirem:

- O QGIS e o ArcGIS trabalham com `geometry`. Com `geography`, cada camada
  exige `geom::geometry` — ou seja, cada vista teria de fazer o cast na mesma,
  e ficávamos com o custo sem o benefício.
- Muitos operadores espaciais só existem para `geometry`. O `&&` com
  `ST_MakeEnvelope`, que é o que uma consulta por bbox faz (e é o que o QGIS
  faz ao arrastar o mapa), é o caso mais comum.
- O índice GiST em `geography` é mais lento a construir e maior.

O ganho do `geography` — distâncias correctas sem pensar — não compensa,
porque as consultas que fazemos são esmagadoramente por proximidade visual e
por bbox, não por distância métrica exacta.

## Consequências

**Ganhamos:** ligação directa do QGIS e do ArcGIS às vistas, sem cast; o
conjunto completo de operadores espaciais; índices mais baratos.

**Pagamos:**

- Quem escrever `ST_Distance(a, b)` sobre estas colunas obtém **graus**, não
  metros, e o número parece plausível. É um erro fácil e silencioso. Fica
  registado aqui e no `CLAUDE.md`: para metros, `ST_DistanceSphere` ou
  reprojectar.
- O operador `distance_m` da linguagem de expressões tem de fazer esta conta
  correctamente uma vez, no `form-core`, para que ninguém tenha de a repetir.
- `ST_Area` sobre `geoshape` em 4326 dá graus quadrados, que não significam
  nada. Qualquer cálculo de área terá de reprojectar para EPSG:32733.
