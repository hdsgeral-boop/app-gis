# Registos de decisão de arquitectura

Um ADR por decisão estrutural. Contexto, decisão, alternativas rejeitadas,
consequências — incluindo as más. Um ADR que só tem vantagens está a mentir.

Um ADR não se edita depois de aceite: substitui-se por outro que o supersede.

| #                                                          | Decisão                                                | Estado |
| ---------------------------------------------------------- | ------------------------------------------------------ | ------ |
| [0001](0001-armazenamento-hibrido.md)                      | Armazenamento híbrido: JSONB canónico + vistas tipadas | Aceite |
| [0002](0002-formato-da-definicao.md)                       | Formato próprio em JSON com importação XLSForm         | Aceite |
| [0003](0003-avaliador-de-expressoes.md)                    | Avaliador de expressões em AST, sem `eval`             | Aceite |
| [0004](0004-powersync.md)                                  | PowerSync para a sincronização                         | Aceite |
| [0005](0005-maplibre-e-pmtiles.md)                         | MapLibre + PMTiles para o mapa offline                 | Aceite |
| [0006](0006-keycloak.md)                                   | Keycloak como fornecedor de identidade                 | Aceite |
| [0007](0007-modelo-de-revisoes.md)                         | Registos com revisões append-only                      | Aceite |
| [0008](0008-estrategia-gnss.md)                            | Abstracção `LocationProvider` para o GNSS              | Aceite |
| [0009](0009-geometry-vs-geography.md)                      | `geometry(Point,4326)` e não `geography`               | Aceite |
| [0010](0010-multi-tenant-com-rls.md)                       | Multi-tenant numa base, isolado por RLS                | Aceite |
| [0011](0011-perder-acesso-com-trabalho-por-sincronizar.md) | Perder acesso com trabalho por sincronizar             | Aceite |
| [0012](0012-arquivo-de-revisoes.md)                        | Arquivo de revisões antigas                            | Aceite |
