# Consul Colect — Especificação técnica

## 1. O que estamos a construir

Uma **plataforma** de recolha de dados de campo, não uma aplicação de um
projecto. O primeiro cliente interno é o cadastro de redes eléctricas
AT/MT/BT, mas a plataforma tem de servir cadastro de imobilizado, redes de
água, inspecções, inquéritos e o que vier a seguir — sem tocar no código.

O ciclo completo:

```
Administrador desenha o formulário no painel web
        ↓
Backend valida, versiona e provisiona tudo o que esse formulário precisa
(armazenamento, API, vistas de consulta, regras de sincronização, permissões)
        ↓
App móvel descarrega a definição em JSON e constrói os ecrãs sozinha
        ↓
Técnico recolhe offline; sincroniza quando há rede
        ↓
Dados disponíveis em PostGIS, API, exportações e QGIS/ArcGIS/Power BI
```

Referências de comparação: KoboToolbox, ODK Central, ArcGIS Survey123.
Não copiamos nenhum — mas se algo aqui for pior do que qualquer um deles sem
uma boa razão, está errado.

**A app móvel nunca conhece nenhum formulário em tempo de compilação.**
Publicar um formulário novo nunca implica publicar uma versão nova da app.
Se em algum momento for preciso alterar código móvel para suportar um
formulário novo, o desenho falhou.

## 2. Conceitos do domínio

```
Organização
 └── Projecto          (contexto de trabalho: "Piloto Bengo", "Cadastro Águas")
      └── Formulário   (identidade estável, ex.: "Local de Consumo")
           └── Versão do formulário   (definição imutável depois de publicada)
                └── Registo           (uma resposta)
                     └── Revisão      (cada edição do registo)
```

- **Utilizador** pertence a uma organização, tem um **papel**, e recebe
  **atribuições** explícitas: que projectos vê, que formulários pode abrir e
  o que pode fazer com cada um.
- **Ninguém vê um formulário que não lhe foi atribuído.** A app não descarrega
  sequer a definição.

## 3. DECISÃO CENTRAL — como se guardam as respostas

Esta é a decisão mais importante do sistema. Está tomada. Lê o raciocínio
antes de a questionares.

**Opção A — DDL dinâmico:** o backend cria uma tabela física por versão de
formulário. Dá colunas tipadas e ligação directa do QGIS. Mas gera milhares de
tabelas, DDL em produção sob carga, RLS a multiplicar por tabela, cópias de
segurança pesadas, e — o problema fatal — as regras de sincronização do
PowerSync teriam de ser regeneradas e redistribuídas a cada formulário
publicado. **Rejeitada.**

**Opção B — JSONB puro:** uma só tabela `record_revisions(data jsonb)`.
Esquema fixo, sincronização estável, versionamento trivial. Mas consultar,
exportar e ligar ferramentas GIS fica tudo por fazer. **Insuficiente sozinha.**

**Opção C — HÍBRIDA. É esta que implementamos.**

1. **Verdade canónica em JSONB.** Uma única tabela de revisões guarda todas as
   respostas de todos os formulários. O esquema físico da base nunca muda
   quando se publica um formulário. O esquema do SQLite no telefone também não.
   As sync rules do PowerSync são escritas uma vez e nunca mais.
2. **Projecção tipada por vista.** Ao publicar uma versão, o backend gera
   automaticamente uma **VIEW** no PostGIS que achata o JSONB em colunas
   tipadas, com `geometry(Point,4326)` real:
   `v_<projecto>_<formulario>_v<n>`, mais uma `v_<projecto>_<formulario>_actual`
   que aponta sempre para a versão corrente.
   Criar e apagar vistas é barato e reversível. O QGIS, o ArcGIS e o Power BI
   ligam-se a estas vistas como se fossem tabelas.
3. **Materialização só quando dói.** Se uma vista passar dos ~500k registos ou
   ficar lenta, converte-se em MATERIALIZED VIEW com refresh incremental. É
   optimização, não desenho inicial.

Ganha-se o melhor dos dois: zero DDL no caminho crítico, e mesmo assim tabelas
reais e tipadas para quem consome os dados.

## 4. Formato da definição de formulário

Formato próprio em JSON, com **importação e exportação XLSForm** (o padrão do
Kobo/ODK/Survey123 — não reinventes o que já é padrão da indústria; permite
trazer formulários existentes no primeiro dia).

Exemplo mínimo, que serve de contrato:

```json
{
  "form_id": "0192f3a1-...",
  "version": 4,
  "published_at": "2026-09-05T10:00:00Z",
  "title": { "pt": "Local de Consumo" },
  "settings": {
    "max_accuracy_m": 2.0,
    "allow_edit_after_submit": true,
    "geometry_field": "f_geo"
  },
  "fields": [
    {
      "id": "f_cod",
      "type": "text",
      "name": "codigo",
      "label": { "pt": "Código do local" },
      "required": true,
      "constraint": { "op": "matches", "args": ["$self", "^LC[0-9]{6}$"] },
      "constraint_message": { "pt": "Formato esperado: LC000000" }
    },

    {
      "id": "f_tipo",
      "type": "select_one",
      "name": "tipo",
      "label": { "pt": "Tipo de instalação" },
      "choices_ref": "lista_tipos",
      "required": true
    },

    {
      "id": "f_pot",
      "type": "decimal",
      "name": "potencia",
      "label": { "pt": "Potência contratada (kVA)" },
      "relevant": { "op": "==", "args": ["$f_tipo", "industrial"] },
      "constraint": { "op": "between", "args": ["$self", 0, 1000] }
    },

    {
      "id": "f_geo",
      "type": "geopoint",
      "name": "localizacao",
      "label": { "pt": "Localização" },
      "required": true
    },

    {
      "id": "g_cont",
      "type": "repeat",
      "name": "contadores",
      "label": { "pt": "Contadores" },
      "max": 10,
      "fields": [
        { "id": "f_ns", "type": "text", "name": "numero_serie", "required": true },
        { "id": "f_foto", "type": "photo", "name": "foto_contador" }
      ]
    }
  ],
  "choice_lists": {
    "lista_tipos": [
      { "value": "domestico", "label": { "pt": "Doméstico" } },
      { "value": "industrial", "label": { "pt": "Industrial" } }
    ]
  }
}
```

Regras do formato:

- **`id` é imutável e gerado pelo sistema; `name` é editável pelo humano.**
  Os dados guardam-se sempre por `id`. Renomear uma pergunta nunca perde dados.
  Esta é a regra que o Kobo trata mal e que não queremos repetir.
- Tipos suportados: `text, note, integer, decimal, boolean, select_one,
select_multiple, date, time, datetime, geopoint, geotrace, geoshape, photo,
audio, file, signature, barcode, calculate, group, repeat, reference`.
  `reference` aponta para um registo de outro formulário (ex.: o local de
  consumo pertence a um PT já cadastrado).
- `relevant`, `constraint` e `calculation` usam uma **linguagem de expressões
  em AST, pura e determinista**. Nada de `eval`, nada de `Function()`, nada de
  strings interpretadas em tempo de execução. O mesmo avaliador, do mesmo
  pacote partilhado, corre no telefone e no servidor.
- Rótulos são sempre objectos multilingues, mesmo que só exista `pt`.
- A definição publicada é **imutável**. Editar cria a versão seguinte.

## 5. O que o backend provisiona ao publicar uma versão

Pipeline transaccional. Ou corre tudo, ou não corre nada.

1. Validar a definição (esquema, ciclos em `relevant`/`calculation`,
   referências a listas e a outros formulários, `id` duplicados).
2. Calcular o **diff** contra a versão anterior e classificá-lo:
   compatível / incompatível. Campo removido ou tipo alterado é incompatível
   e exige confirmação explícita do administrador.
3. Gravar `form_versions` como imutável.
4. Gerar/actualizar as vistas PostGIS tipadas da secção 3.
5. Registar índices GIN nos campos marcados como pesquisáveis.
6. Actualizar o manifesto do formulário (hash da definição, listas de escolha
   externas, media) para a app saber o que descarregar.
7. Invalidar caches e marcar os dispositivos com a versão desactualizada.

**Publicar nunca reescreve registos existentes.** Migrar dados antigos para um
esquema novo é uma operação separada, explícita, pré-visualizável e reversível.

## 6. Contrato de API

Autenticação OIDC (Keycloak). Todos os endpoints aceitam `If-None-Match`/ETag.
Todas as escritas aceitam `Idempotency-Key`.

**Sessão**

```
POST   /auth/token              login (password grant + device flow)
POST   /auth/refresh
POST   /auth/logout
GET    /me                      perfil, papel, projectos e permissões efectivas
```

**Formulários (lado do cliente)**

```
GET    /forms?updated_since=            só os atribuídos ao utilizador
GET    /forms/{id}                      metadados + versão corrente + hash
GET    /forms/{id}/versions/{v}         definição completa em JSON
GET    /forms/{id}/manifest             listas externas e media, com hashes
```

**Registos**

```
POST   /records                         criar (id UUIDv7 vem do cliente)
GET    /records?form_id=&updated_since=&bbox=&status=
GET    /records/{id}
PATCH  /records/{id}                    nova revisão; If-Match: revisão base
DELETE /records/{id}                    soft delete
GET    /records/{id}/revisions          histórico completo
POST   /records/{id}/restore
```

**Anexos**

```
POST   /attachments/presign             devolve URL de upload directo
POST   /attachments/{id}/complete
```

**Administração**

```
POST   /admin/forms                     criar formulário
POST   /admin/forms/{id}/versions       guardar rascunho
POST   /admin/forms/{id}/publish        corre o pipeline da secção 5
POST   /admin/forms/{id}/versions/{v}/diff
DELETE /admin/forms/{id}                arquivar (nunca apaga registos)
POST   /admin/forms/{id}/assignments    atribuir acesso
GET    /admin/forms/{id}/assignments
POST   /admin/forms/import/xlsform
GET    /admin/forms/{id}/export?format=xlsform|json
GET    /admin/exports?form_id=&format=csv|geojson|gpkg|shp|xlsx
CRUD   /admin/users, /admin/roles, /admin/teams, /admin/projects
```

A sincronização em massa **não** passa por estes endpoints: passa pelo
PowerSync. A API REST serve o painel, integrações e clientes terceiros.

## 7. Modelo de dados

```
organizations
users                 espelho do Keycloak
roles, permissions
teams, team_members
projects

forms                 (id, project_id, key, title, current_version, archived_at)
form_versions         (id, form_id, version, definition jsonb, hash,
                       published_at, published_by, IMUTÁVEL)
form_assignments      (form_id, principal_type ∈ {user,role,team}, principal_id,
                       can_read, can_create, can_edit_own, can_edit_all,
                       can_delete, scope_filter jsonb)

records               (id UUIDv7, form_id, form_version_id, project_id,
                       current_revision_id, geom geography(Point,4326),
                       status ∈ {rascunho,submetido,validado,rejeitado,needs_review},
                       created_by, deleted_at)
record_revisions      (id, record_id, revision_no, data jsonb, author_id,
                       device_id, base_revision_id, client_created_at,
                       server_received_at, APPEND-ONLY)

attachments           (id, record_id, revision_id, field_id, tipo, hash, bytes,
                       upload_state, storage_key)
gps_fixes             (record_id, revision_id, lat, lon, alt, accuracy_m,
                       fix_type, satellites, pdop, hdop, source,
                       receiver_model, collected_at, corrections_age_s)
audit_log             APPEND-ONLY, garantido por trigger
sync_state            por dispositivo
```

- `fix_type ∈ {single,dgps,float,fixed,has_ppp,manual,unknown}`
- `source ∈ {internal,external_bt,external_tcp,manual}`
- GiST em `records.geom`; GIN em `record_revisions.data`.
- **RLS no Postgres**, por organização e por atribuição — nunca só na aplicação.

## 8. Restrições inegociáveis

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

## 9. Stack decidida

Não reabras estas decisões sem me perguntares.

```
apps/mobile       React Native + Expo (dev build; Expo Go não serve)
apps/admin        Next.js App Router — painel e construtor de formulários
apps/api          NestJS + Fastify
packages/form-core  definição, validador, avaliador de expressões, diff,
                    importador XLSForm — PARTILHADO entre os três
packages/ui
infra/            docker-compose, migrações, sync rules, geradores de vistas
```

- PostgreSQL 16 + PostGIS 3.4, migrações Drizzle Kit
- PowerSync (Open Edition, auto-hospedado) — SQLite ↔ Postgres, bidireccional,
  fila de upload persistente, buckets por atribuição
- Keycloak; JWT com `sub`, `org_id`, `role`, `form_scopes[]`
- MapLibre GL Native + PMTiles offline
- MinIO / Cloudflare R2 para anexos
- Railway (Postgres, PowerSync, API) + Vercel (admin)
- Sentry; Vitest, Playwright, Maestro

`packages/form-core` é o coração. Se a mesma regra for implementada duas vezes,
uma no servidor e outra no telefone, vai divergir. Está lá uma vez só.

## 10. Sincronização

- **Descida:** sync rules do PowerSync derivam buckets dos claims do JWT e das
  `form_assignments`. Um técnico recebe as definições dos formulários que lhe
  foram atribuídos e os registos do seu âmbito. Mais nada.
- **Subida:** fila persistente com backoff, sobrevive a fecho da app e reinício
  do telefone.
- **Conflitos:** duas revisões com a mesma `base_revision_id` são ambas
  guardadas e o registo fica `needs_review`. Nunca se perde trabalho de campo
  em silêncio.
- **Anexos:** fila separada, prioridade baixa, Wi-Fi por omissão. O registo
  sincroniza mesmo com fotos por subir.
- **Versão de formulário desactualizada:** a app avisa, descarrega a nova, e
  continua a permitir editar registos antigos com o esquema original.

## 11. GNSS

Abstracção `LocationProvider` com implementações intermutáveis: GPS interno,
receptor externo por NMEA sobre TCP/Wi-Fi, receptor externo por Bluetooth
(Android, via mock location provider). Em iOS o Bluetooth exige MFi — assumir
TCP como via principal.

Limiar de precisão por formulário (`max_accuracy_m`). Acima do limiar a app
avisa de forma visível e só grava com justificação escrita, que fica na revisão.
A precisão actual e a origem do fixo estão sempre visíveis no ecrã de recolha.

## 12. Fases

- **F0** Andaimes, compose, CI, esquema base, autenticação ponta a ponta.
- **F1** `packages/form-core`: formato, validador, avaliador de expressões,
  diff de versões, importador/exportador XLSForm. Sem UI. Com testes.
- **F2** Construtor de formulários no painel + publicação + pipeline de
  provisionamento (vistas PostGIS, manifesto, índices).
- **F3** Renderizador dinâmico no móvel: pega no JSON e constrói os ecrãs.
- **F4** Recolha offline: SQLite, registos, revisões, listagem, pesquisa, edição.
- **F5** Sincronização PowerSync ponta a ponta + conflitos.
- **F6** Atribuições, RBAC, RLS, âmbitos, auditoria.
- **F7** GNSS: abstracção, receptor externo, metadados, limiar.
- **F8** Mapa MapLibre + PMTiles + feições recolhidas.
- **F9** Anexos e fila de fotografias.
- **F10** Exportações, dashboards, endurecimento, teste de campo real.

---

## 13. Decisões tomadas no arranque (adenda ao PROMPT 0)

Registadas aqui porque a especificação é viva. Ver `docs/adr/` para o raciocínio.

| #   | Assunto                       | Decisão                                                                                                                                        |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Idioma dos rótulos            | `pt` é obrigatório em todos os `label`. Multilingue suportado desde o formato, UI de tradução fica para depois da F10.                         |
| 2   | Chave de projecção nas vistas | `name` do campo, saneado e desambiguado; `id` fica como comentário da coluna. Renomear um campo renomeia a coluna da vista, nunca perde dados. |
| 3   | Repetíveis nas vistas         | Vista-filha por grupo repetível, ligada por `record_id` + `idx`. Nada de achatar em colunas `_1`, `_2`.                                        |
| 4   | Geometria canónica            | `records.geom` é `geometry(Point,4326)` (não `geography`), com GiST. `geography` obriga a casts em todas as consultas do QGIS. Ver ADR-0009.   |
| 5   | `select_multiple` nas vistas  | Coluna `text[]`, mais uma coluna `_txt` com os valores juntos por espaço, para compatibilidade com ODK/Kobo.                                   |
| 6   | Multi-tenant                  | Uma base, uma organização por linha, RLS por `org_id`. Nada de schema-per-tenant.                                                              |
| 7   | Estado inicial dos registos   | O cliente escreve sempre `rascunho`; a transição para `submetido` é explícita do técnico.                                                      |
| 8   | Relógio do dispositivo        | `client_created_at` é dado do cliente e nunca é usado para ordenar. A ordenação canónica é `server_received_at` + `revision_no`.               |
| 9   | Fuso horário                  | Tudo em UTC (`timestamptz`). A apresentação converte para `Africa/Luanda`.                                                                     |
| 10  | Unidade de deploy             | Uma instância por organização não; multi-tenant desde o primeiro dia (ver 6).                                                                  |
