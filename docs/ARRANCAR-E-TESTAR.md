# Arrancar, testar e alojar o Consul Colect

Guia de ponta a ponta: pôr tudo a correr na tua máquina, instalar a app no
telefone, os casos de uso a passar, e onde alojar para testar a sério.

---

## Parte 1 — Arrancar tudo na tua máquina

### 1.1 O que precisas

| Ferramenta     | Versão   | Como confirmar       |
| -------------- | -------- | -------------------- |
| Node           | 22+      | `node -v`            |
| pnpm           | 10+      | `pnpm -v`            |
| Docker Desktop | qualquer | `docker ps`          |
| JDK (só móvel) | 17       | `echo $JAVA_HOME`    |
| Android SDK    | 34+      | `echo $ANDROID_HOME` |

### 1.2 Ambiente

```bash
cd C:/xampp/htdocs/APP_GIS
pnpm install
cp .env.example .env
```

Abre o `.env` e confirma três coisas:

```dotenv
POSTGRES_PORT=5433
DATABASE_URL=postgres://cvforms:cvforms@localhost:5433/cvforms
POWERSYNC_URL=http://localhost:8090
```

> **O porto 5433 não é decoração.** Se deixares 5432 e tiveres um Postgres
> instalado na máquina, o Docker liga na mesma e o que responde é o outro
> Postgres. O erro que aparece é `role "cvforms" does not exist`, que parece
> um problema de permissões e é um problema de porto.

### 1.3 Serviços

```bash
POSTGRES_PORT=5433 docker compose -f infra/docker/docker-compose.yml up -d
pnpm db:migrate
pnpm db:seed
```

Confirma que os quatro estão de pé:

```bash
docker ps --format '{{.Names}}\t{{.Status}}'
```

Deves ver `cvforms-postgres`, `cvforms-keycloak`, `cvforms-powersync` e
`cvforms-minio`.

| Serviço   | Endereço                | Credenciais                      |
| --------- | ----------------------- | -------------------------------- |
| API       | <http://localhost:4000> | —                                |
| Painel    | <http://localhost:3000> | pelo Keycloak                    |
| Keycloak  | <http://localhost:8080> | `admin` / `admin`                |
| PowerSync | <http://localhost:8090> | —                                |
| MinIO     | <http://localhost:9001> | `cvforms` / `cvforms-dev-secret` |

Utilizadores de demonstração: **`admin.demo` / `demo`** e
**`tecnico.demo` / `demo`**.

### 1.4 API e painel

```bash
pnpm dev
```

Arranca os dois. Confirma:

```bash
curl -s http://localhost:4000/health | head -c 400
```

Deves ver `"status":"ok"` e as quatro dependências verdes. Se o
`armazenamento` ou o `powersync` estiverem a `false`, o contentor
correspondente não está de pé.

### 1.5 Painel

Abre <http://localhost:3000> e entra com `admin.demo` / `demo`.

O painel tem quatro sítios:

| Onde                  | Para quê                                            |
| --------------------- | --------------------------------------------------- |
| **Formulários**       | desenhar, publicar, atribuir                        |
| **Por rever**         | conflitos de sincronização e registos com problemas |
| **Pessoas**           | papéis e equipas                                    |
| `/admin/exports/{id}` | CSV, GeoJSON, anexos, qualidade                     |

---

## Parte 2 — A app no telefone

### 2.1 Preparar o telefone

1. **Definições → Acerca do telefone** → toca sete vezes em **Número de
   compilação**. Aparece «já és programador».
2. **Definições → Sistema → Opções de programador** → liga **Depuração USB**.
3. Liga o telefone por cabo e aceita o aviso **«Permitir depuração USB?»**,
   marcando «Sempre permitir a partir deste computador».

Confirma:

```bash
adb devices -l
```

Tem de dizer `device`. Se disser `unauthorized`, falta aceitar o aviso; se
disser `offline`, desliga e volta a ligar o cabo.

### 2.2 Compilar e instalar

A primeira vez demora — 15 a 40 minutos, conforme a máquina.

```bash
cd apps/mobile
pnpm exec expo prebuild --platform android --clean

cd android
JAVA_HOME='C:\Program Files\Eclipse Adoptium\jdk-17.0.19.10-hotspot' \
  ./gradlew assembleDebug --console=plain
```

O APK fica em `apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk`.
Instala:

```bash
adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

> **Se o build falhar com `Filename longer than 260 characters`:** é o limite
> de caminho do Windows. O `.npmrc` na raiz já traz `node-linker=hoisted` para
> o evitar; se o apagaste, volta a pô-lo e corre `pnpm install`.

> **Se falhar com `Unable to delete directory ... kotlin-classes`:** ficou um
> Gradle a correr de uma tentativa anterior. `./gradlew --stop` e repete.

### 2.3 Arrancar o Metro

A app é um _dev build_: o código JavaScript vem do teu computador enquanto
desenvolves.

```bash
cd apps/mobile
pnpm dev
```

Depois, para o telefone chegar ao teu computador por cabo:

```bash
adb reverse tcp:8081 tcp:8081   # Metro
adb reverse tcp:4000 tcp:4000   # API
adb reverse tcp:8080 tcp:8080   # Keycloak
adb reverse tcp:8090 tcp:8090   # PowerSync
adb reverse tcp:9000 tcp:9000   # MinIO
```

Com os `adb reverse` feitos, no `.env` da app usa `localhost` e não
`10.0.2.2`:

```dotenv
EXPO_PUBLIC_API_URL=http://localhost:4000
EXPO_PUBLIC_KEYCLOAK_ISSUER=http://localhost:8080/realms/cvforms
EXPO_PUBLIC_POWERSYNC_URL=http://localhost:8090
```

Abre a app no telefone. Deve ligar-se ao Metro sozinha.

---

## Parte 3 — Casos de uso para testar

Faz por esta ordem. Cada um depende do anterior.

### Caso 1 — Desenhar e publicar um formulário (F2)

1. Painel → **Formulários** → **criar**.
2. Chave `local_consumo`, título «Local de Consumo».
3. Acrescenta campos: texto `codigo` (marca **pesquisável**), decimal
   `potencia`, data `data_visita`, escolha múltipla `servicos`, geoponto
   `localizacao`, fotografia `foto_chapa`.
4. Em definições do formulário, põe `localizacao` como campo de geometria e um
   limiar de precisão de **2 m**.
5. **Publicar**.

**O que tem de acontecer:** o formulário fica com versão 1, e no Postgres
aparecem as vistas. Confirma:

```bash
docker exec cvforms-postgres psql -U cvforms -d cvforms \
  -c "\dv cvf_views.*"
```

**Onde falha, tipicamente:** um campo com `id` repetido, ou uma expressão com
ciclo. A publicação recusa e diz qual.

### Caso 2 — Atribuir a um técnico (F6)

1. Painel → **Pessoas**. Se `tecnico.demo` não aparecer, entra uma vez na app
   com ele — a linha aparece no primeiro login, de propósito.
2. Painel → **Formulários** → o formulário → **Atribuições** → atribui a
   `tecnico.demo` com **ler** e **criar**.

**O que tem de acontecer:** na app, com `tecnico.demo`, o formulário aparece.
Com outro utilizador sem atribuição, não aparece — nem a definição.

### Caso 3 — Recolher offline (F3, F4)

1. No telefone, **modo de avião**.
2. Abre o formulário e preenche.
3. **Fecha a app à força** (Recentes → deslizar).
4. Abre outra vez.

**O que tem de acontecer:** o rascunho está como o deixaste. Nada se perde.

### Caso 4 — O ponto GPS (F7)

1. **Definições do receptor** → GPS do telefone.
2. No formulário, **obter posição**, ao ar livre.

**O que tem de acontecer:** aparece a coordenada, a precisão em metros,
`single` e `internal`. Se a precisão for pior do que 2 m, aparece o aviso
laranja e uma caixa a pedir a justificação.

Com receptor externo: liga o telefone ao Wi-Fi dele, escolhe **Receptor
externo**, e confirma que o estado passa a `fixed` com poucos centímetros.

### Caso 5 — Fotografia (F9)

Toca em **tirar fotografia**. Confirma que a foto reduzida entra e que o
tamanho é muito menor do que o original.

```bash
docker exec cvforms-postgres psql -U cvforms -d cvforms \
  -c "SELECT field_id, bytes, upload_state FROM attachments ORDER BY created_at DESC LIMIT 5"
```

### Caso 6 — Sincronizar (F5)

1. Submete o registo com o telefone em modo de avião. Fica ⏳.
2. Desliga o modo de avião.

**O que tem de acontecer:** passa a ✅ sozinho. Confirma no servidor:

```bash
docker exec cvforms-postgres psql -U cvforms -d cvforms \
  -c "SELECT id, status, updated_at FROM records ORDER BY updated_at DESC LIMIT 5"
```

### Caso 7 — Conflito (F5.6, F5.7)

O caso mais importante de todos, porque é onde se perde trabalho.

1. Com o mesmo registo aberto em **dois telefones** (ou um telefone e a API
   por `curl`), edita nos dois com o telefone offline.
2. Põe os dois online.

**O que tem de acontecer:** as duas revisões ficam, o registo passa a ⚠️
(`needs_review`), e no painel → **Por rever** aparecem lado a lado com as
diferenças a negrito. Escolhes uma, escreves porquê, e o registo volta a
`submetido`. **A que não escolheste continua no histórico.**

### Caso 8 — Âmbito (F6.4)

1. Acrescenta ao formulário um campo `municipio` e publica.
2. No Postgres, marca-o como campo de âmbito:

```bash
docker exec cvforms-postgres psql -U cvforms -d cvforms \
  -c "UPDATE forms SET scope_field_id = 'f_municipio' WHERE key = 'local_consumo'"
```

3. Na atribuição do técnico, põe `scope_filter = {"valores": ["Bengo"]}`.

**O que tem de acontecer:** o técnico deixa de ver os registos do Uíge — na
API e no telefone. Os que ele próprio recolheu continua a ver (ADR-0011).

> O campo de âmbito tem de ser declarado **antes** de haver registos. Com
> registos, a base recusa a alteração.

### Caso 9 — Exportar (F10)

```bash
TOKEN="<o teu token de admin>"
FORM="<o id do formulário>"

curl -H "authorization: Bearer $TOKEN" \
  "http://localhost:4000/admin/exports/$FORM?format=csv" -o dados.csv
curl -H "authorization: Bearer $TOKEN" \
  "http://localhost:4000/admin/exports/$FORM?format=geojson" -o dados.geojson
curl -H "authorization: Bearer $TOKEN" \
  "http://localhost:4000/admin/exports/$FORM/anexos?format=sh" -o descarregar.sh
sh descarregar.sh
```

Abre o `dados.csv` no Excel: os cabeçalhos são os rótulos das perguntas e os
acentos estão certos. Abre o `dados.geojson` no QGIS. As fotografias ficam em
`anexos/<record_id>/`.

### Caso 10 — QGIS (F2, F10.4)

Segue o `docs/QGIS.md`. Liga-te à vista `cvf_views.v_<projecto>_<form>_actual`.

**O que tem de acontecer:** os pontos aparecem no mapa, com uma coluna por
campo e os `_accuracy_m` / `_fix_type` / `_source` ao lado.

### Caso 11 — O alerta silencioso (F10.9)

```bash
docker stop cvforms-powersync
curl -s http://localhost:4000/health/replicacao
```

**O que tem de acontecer:** o slot do PowerSync aparece como inactivo e o
atraso começa a subir. Quando passar o limiar crítico, o endpoint responde
**503** — que é o que faz um monitor disparar. O `/health` normal continua
verde, de propósito.

```bash
docker start cvforms-powersync
```

---

### Caso 12 — Mapa offline (F8)

1. Prepara um `.pmtiles` pequeno de uma área conhecida (ver o painel →
   **Mapas** → «Como preparar um ficheiro»).
2. Painel → **Mapas** → dá-lhe um nome, marca **usar como mapa de fundo**, e
   escolhe o ficheiro. O browser calcula o hash e envia-o directamente para o
   armazenamento — não passa pelo painel nem pela API.
3. Na app: **Definições → Mapas offline → descarregar**. Confirma o aviso do
   tamanho em MB antes de começar.
4. Põe o telefone em **modo de avião** e abre o **Mapa**.

**O que tem de acontecer:** o mapa desenha-se sem rede nenhuma, com os teus
registos por cima e a cor a distinguir o que já subiu do que não subiu.

**O outro caminho:** copia o `.pmtiles` para o telefone por cabo e usa
**Escolher um ficheiro do telefone**. Não gasta um byte de rede — é assim que
uma brigada inteira fica com mapas numa manhã.

---

## Parte 4 — Alojar para testar a sério

> **Para pôr online a sério, segue o `docs/PRODUCAO.md`.** Traz o
> `docker-compose.prod.yml`, os Dockerfiles, o Caddy com HTTPS automático, e a
> lista do que tem de mudar. O que está abaixo é o resumo das alternativas.

### 4.1 A escolha mais simples: Railway

Para um piloto com uma brigada, é o que dá menos trabalho. Uma conta, quatro
serviços, e o Postgres com PostGIS.

| Serviço     | O que é                         | Notas                              |
| ----------- | ------------------------------- | ---------------------------------- |
| `postgres`  | imagem `postgis/postgis:16-3.4` | **não** o Postgres de origem       |
| `api`       | `apps/api`                      | `pnpm --filter @cvforms/api start` |
| `painel`    | `apps/admin`                    | Next.js                            |
| `powersync` | `journeyapps/powersync-service` | monta o `sync-rules.yaml`          |
| `keycloak`  | `quay.io/keycloak/keycloak`     | com volume, senão perdes o realm   |

Armazenamento de anexos: **não uses um volume**. Usa um S3 a sério —
Cloudflare R2 é o mais barato para este caso (sem custo de saída) e fala
S3 nativamente. Só mudam as variáveis `S3_*`.

**Passos:**

1. `railway init` na raiz do repositório.
2. Cria o Postgres a partir da imagem PostGIS e corre `pnpm db:migrate` uma vez.
3. Nas variáveis da API, define tudo o que está no `.env.example` **menos os
   valores de demonstração** — senha do Postgres, `KEYCLOAK_*`, `S3_*`.
4. Aponta o healthcheck do serviço `api` a `/health`.
5. Cria um segundo healthcheck (ou um UptimeRobot) a apontar a
   **`/health/replicacao`** — é o que te avisa antes de o WAL encher o disco.

### 4.2 O que tem de mudar de desenvolvimento para produção

Isto não é opcional. Cada linha aqui é uma forma de perder dados ou de os
expor.

- [ ] **Senha do papel `cvforms_app`.** A migração cria o papel sem senha, de
      propósito (restrição 9). Em produção:
      `ALTER ROLE cvforms_app LOGIN PASSWORD '…'` e a `DATABASE_URL` da API
      aponta lá. **Nunca ligues a API como dono das tabelas** — o dono ignora
      o RLS e o isolamento entre organizações desaparece sem erro nenhum.
- [ ] **`PS_ADMIN_TOKEN` do PowerSync** com um valor gerado, não o do compose.
- [ ] **Realm do Keycloak** com senhas próprias e o utilizador `admin` do
      Keycloak trocado.
- [ ] **`CORS_ORIGINS`** só com o domínio do painel.
- [ ] **`DATABASE_SSL=true`** e `sslmode=require` no URI do PowerSync.
- [ ] **Backups do Postgres**, diários, com restauro testado uma vez. Um
      backup que nunca foi restaurado não é um backup.
- [ ] **`SENTRY_DSN`** se quiseres relato de erros. Sem ele fica desligado,
      que é o normal.

### 4.3 Alternativas, e quando escolhê-las

| Onde                   | Quando faz sentido                                                                                             |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Railway**            | piloto, uma brigada, quem não quer administrar servidores                                                      |
| **Hetzner / Contabo**  | quando o volume crescer; um VPS de 8 GB custa uma fracção                                                      |
| **Servidor em Luanda** | quando a latência ou a soberania dos dados o exigirem                                                          |
| Vercel + Neon          | painel na Vercel funciona; o PowerSync **não** — precisa de replicação lógica e de um processo sempre a correr |

Um VPS com `docker compose` é o mesmo ficheiro que já usas, mais um Caddy à
frente para HTTPS. Não precisas de Kubernetes para trinta técnicos.

### 4.4 A app no telefone, em produção

Para um piloto, um APK assinado chega:

```bash
cd apps/mobile
pnpm exec eas build --profile preview --platform android
```

Distribui o `.apk` por link. Só vale a pena a Play Store quando houver muitos
telefones para actualizar.

Antes de gerar o APK, aponta o `.env` da app ao servidor a sério
(`EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_KEYCLOAK_ISSUER`,
`EXPO_PUBLIC_POWERSYNC_URL`). **Tudo o que começa por `EXPO_PUBLIC_` fica
dentro do pacote e é legível por quem o descompilar** — nunca ponhas lá um
segredo.

---

## Parte 5 — Como me relatar um erro

Quanto mais completo, mais depressa se resolve. O mínimo útil:

1. **O que estavas a fazer**, em duas frases.
2. **O que esperavas** e **o que aconteceu**.
3. **Onde**: painel, app, ou API.
4. **Se foi na app**, o modelo do telefone e se tinhas rede.

E, conforme o sítio, o que dá para copiar:

**Da API:**

```bash
curl -s http://localhost:4000/health
docker logs --tail 100 cvforms-postgres
```

Se a resposta trouxe um `request_id`, manda-o — é o que liga o erro que viste
à linha do log.

**Do painel:** F12 → separador **Console** → copia a mensagem a vermelho.

**Do telefone**, com o cabo ligado:

```bash
adb logcat -d | grep -i cvforms | tail -50
```

**Da base**, se suspeitares de dados:

```bash
docker exec cvforms-postgres psql -U cvforms -d cvforms \
  -c "SELECT id, status, updated_at FROM records ORDER BY updated_at DESC LIMIT 10"
```

> **Nunca me mandes senhas nem o conteúdo do `.env`.** Se um log trouxer um
> URL de base de dados, apaga a parte da senha antes de o colar.

### O que é urgente e o que não é

| Urgente                                  | Pode esperar             |
| ---------------------------------------- | ------------------------ |
| um registo desapareceu                   | um botão desalinhado     |
| um técnico vê dados de outra organização | um texto mal traduzido   |
| a app não deixa gravar                   | a procura devolve muitos |
| `/health/replicacao` responde 503        | uma exportação demora    |

Se um registo desapareceu, **não mexas em nada** e diz logo. As revisões são
append-only e quase de certeza o registo está lá — o que falhou foi mostrá-lo.
