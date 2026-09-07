# Pôr o Consul Colect online

Do zero até técnicos a recolher, num servidor a sério. Uma hora, se os nomes
já apontarem para o servidor.

---

## O que precisas antes de começar

- Um servidor com **Docker** e **4 GB de RAM** (8 GB se forem mais de trinta
  técnicos). Um Hetzner CX32 ou um Contabo equivalente chegam bem.
- Um domínio, com acesso ao DNS.
- **Cinco nomes** a apontar para o IP do servidor, criados **antes** do
  primeiro arranque:

| Nome                      | Para quê                  |
| ------------------------- | ------------------------- |
| `painel.teudominio.ao`    | o painel web              |
| `api.teudominio.ao`       | a API                     |
| `sync.teudominio.ao`      | a sincronização           |
| `auth.teudominio.ao`      | o Keycloak                |
| `ficheiros.teudominio.ao` | anexos e mosaicos de mapa |

> **Cria os cinco antes de arrancar.** O Caddy pede os certificados ao primeiro
> arranque; se um nome ainda não resolver, a Let's Encrypt recusa e o Caddy
> entra em espera exponencial. Passa a parecer que o serviço está em baixo, e
> não está — está à espera de uma hora que já passou.

---

## 1. Preparar

```bash
git clone <o teu repositório> cvforms && cd cvforms
cp .env.producao.example .env.producao
```

Abre o `.env.producao` e gera **um valor diferente** para cada `TROCA-ME`:

```bash
for n in POSTGRES_PASSWORD APP_DB_PASSWORD KEYCLOAK_ADMIN_PASSWORD \
         NEXTAUTH_SECRET POWERSYNC_ADMIN_TOKEN MINIO_ROOT_PASSWORD; do
  echo "$n=$(openssl rand -base64 32 | tr -d '=+/' | cut -c1-32)"
done
```

Cola os cinco nomes nas variáveis `DOMINIO_*`.

> **Não reutilizes uma senha entre serviços.** A senha do Postgres e a do MinIO
> protegem coisas diferentes: uma protege o cadastro, a outra protege as
> fotografias. Se forem a mesma, protegem uma coisa só.

---

## 2. Arrancar

```bash
COMPOSE="docker compose -f infra/docker/docker-compose.prod.yml --env-file .env.producao"

$COMPOSE build            # 15 a 30 min à primeira; depois é cache
$COMPOSE up -d postgres
$COMPOSE run --rm migracoes
```

Agora dá senha ao papel com que a API corre:

```bash
set -a; . ./.env.producao; set +a
sh infra/scripts/criar-papel-app.sh
```

> **O que este passo faz, e porque não está numa migração.** A migração cria o
> papel `cvforms_app` **sem senha**, de propósito: uma senha numa migração é
> uma senha no repositório. O script dá-lhe a senha e **confirma que ele não é
> superutilizador nem tem BYPASSRLS** — se fosse, o isolamento entre
> organizações desaparecia sem erro nenhum (ADR-0010).

E finalmente tudo:

```bash
$COMPOSE up -d
$COMPOSE logs -f caddy   # até veres os certificados emitidos
```

---

## 3. Keycloak

```bash
$COMPOSE logs keycloak | grep -i "realm"
```

Entra em `https://auth.teudominio.ao` com as credenciais de administrador do
`.env.producao` e faz três coisas:

1. **Confirma o realm `cvforms`.** É importado do `infra/keycloak/`.
2. **Copia o segredo do cliente `cvforms-admin`** (Clients → cvforms-admin →
   Credentials) para `KEYCLOAK_ADMIN_CLIENT_SECRET` no `.env.producao`, e
   reinicia o painel: `$COMPOSE up -d painel`.
3. **Cria os utilizadores.** É aqui que se criam, e não no painel do Consul Colect —
   a identidade vive no Keycloak (ADR-0006) e a linha na base do Consul Colect
   aparece sozinha ao primeiro login.

Confirma que está tudo de pé:

```bash
curl -s https://api.teudominio.ao/health | jq
```

Os quatro `dependencias` a `true`. Se o `powersync` estiver a `false`, vê os
logs desse serviço — quase sempre é a URI da base sem `sslmode`.

---

## 4. A app dos técnicos

O servidor entra **no pacote**, na compilação. O técnico nunca vê um URL nem
escreve um endereço — o que ele sabe é o utilizador e a senha, e mais nada.

```bash
cd apps/mobile
cat > .env.production <<'FIM'
EXPO_PUBLIC_API_URL=https://api.teudominio.ao
EXPO_PUBLIC_KEYCLOAK_ISSUER=https://auth.teudominio.ao/realms/cvforms
EXPO_PUBLIC_KEYCLOAK_CLIENT_ID=cvforms-mobile
EXPO_PUBLIC_POWERSYNC_URL=https://sync.teudominio.ao
FIM

node ../../node_modules/expo/bin/cli prebuild --platform android --clean
cd android && ./gradlew assembleRelease
```

O APK fica em `app/build/outputs/apk/release/`. Distribui por link ou por cabo.

> **Tudo o que começa por `EXPO_PUBLIC_` fica dentro do pacote e é legível por
> quem o descompilar.** URLs podem lá estar; segredos não, nunca. O cliente
> OIDC é público e usa PKCE precisamente para não precisar de nenhum.

Para actualizar a app depois, gera um APK novo com a versão subida e
distribui-o. Os registos por sincronizar sobrevivem a uma actualização — mas
confirma na mesma que a lista está a zero antes de mandar alguém actualizar.

---

## 5. Vigiar

Duas coisas, e chegam:

```bash
# Está de pé?
https://api.teudominio.ao/health

# O disco vai encher?
https://api.teudominio.ao/health/replicacao
```

Aponta um monitor gratuito (UptimeRobot, Better Stack) aos **dois**. O segundo
é o que interessa mais: responde **503** quando um slot de replicação está a
acumular WAL, e é o único aviso que existe antes de o disco encher e o Postgres
parar de aceitar registos de campo. Sem esse monitor, o 503 não chega a
ninguém.

### Backups

```bash
# Todos os dias, às 3 da manhã
0 3 * * * cd /caminho/cvforms && docker compose -f infra/docker/docker-compose.prod.yml \
  --env-file .env.producao exec -T postgres \
  pg_dump -U cvforms cvforms | gzip > /backups/cvforms-$(date +\%F).sql.gz
```

E as fotografias, que estão no MinIO:

```bash
0 4 * * * mc mirror --overwrite local/cvforms-anexos /backups/anexos/
```

> **Restaura um backup uma vez, antes de precisares.** Um backup que nunca foi
> restaurado não é um backup — é um ficheiro.

---

## 6. Quando alguma coisa corre mal

| Sintoma                                            | Quase sempre é                                                             |
| -------------------------------------------------- | -------------------------------------------------------------------------- |
| o Caddy não emite certificados                     | um dos cinco nomes ainda não resolve                                       |
| o painel dá 500 ao entrar                          | falta o `KEYCLOAK_ADMIN_CLIENT_SECRET`                                     |
| a API não arranca                                  | falta uma variável — a mensagem diz qual                                   |
| o `/health` diz `powersync: false`                 | falta `sslmode=disable` na `PS_DATABASE_URI`                               |
| o telefone não sincroniza                          | o `EXPO_PUBLIC_POWERSYNC_URL` do APK aponta para outro lado                |
| o upload de fotografias dá `SignatureDoesNotMatch` | o `S3_PUBLIC_ENDPOINT` não bate certo com o `DOMINIO_FICHEIROS`            |
| a API vê dados de todas as organizações            | **pára tudo.** Está a correr como dono das tabelas, não como `cvforms_app` |

A última é a única da lista que é uma emergência. As outras esperam.

---

## O que este desenho deliberadamente não faz

**Não há Kubernetes.** Para trinta técnicos, um `docker compose` num servidor é
mais fiável do que um cluster que uma equipa de três pessoas não consegue
depurar às três da manhã.

**Não há réplica de leitura nem alta disponibilidade.** Se o servidor cair, os
técnicos continuam a recolher — a app escreve primeiro no telefone e a
sincronização é uma consequência, nunca uma condição. Essa é a alta
disponibilidade que interessa neste sistema, e já está feita.

**O MinIO é um serviço deste compose, e não um S3 gerido.** Quando os anexos
passarem de umas dezenas de GB, muda as variáveis `S3_*` para um Cloudflare R2
ou equivalente e não mudes mais nada. O código já fala S3.
