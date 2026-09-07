import { z } from 'zod';

/**
 * Ambiente da API, validado ao arrancar.
 *
 * Falhar aqui, alto e cedo, é melhor do que falhar às três da manhã com um
 * `undefined` a chegar ao Postgres. Não há valores por omissão para segredos
 * (restrição inegociável 9): ou estão no ambiente, ou a API não arranca.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL é obrigatória'),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  /**
   * Papel restrito com que a API corre dentro de cada pedido. NÃO pode ser o
   * dono das tabelas nem ter BYPASSRLS — se for, o RLS é ignorado e o
   * isolamento entre organizações desaparece sem erro nenhum (ADR-0010).
   */
  DATABASE_APP_ROLE: z.string().default('cvforms_app'),
  /**
   * Saída de emergência para diagnóstico. `true` por omissão de propósito:
   * ninguém liga o isolamento por engano, mas alguém desliga-o por engano.
   */
  DATABASE_RLS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /** URL do realm, ex.: http://localhost:8080/realms/cvforms */
  KEYCLOAK_ISSUER: z.string().url('KEYCLOAK_ISSUER tem de ser um URL do realm'),
  /** Audiências aceites, separadas por vírgula. */
  KEYCLOAK_AUDIENCE: z.string().default('cvforms-mobile,cvforms-admin,cvforms-api'),
  /** Tolerância de relógio, em segundos. Telefones de campo desacertam. */
  JWT_CLOCK_TOLERANCE_S: z.coerce.number().int().nonnegative().default(120),

  /** Armazenamento de objectos para os anexos (F9). MinIO em desenvolvimento. */
  S3_ENDPOINT: z.string().url().default('http://localhost:9000'),
  /**
   * O endereço por onde o TELEFONE chega ao armazenamento.
   *
   * Em produção a API fala com o MinIO por dentro da rede
   * (`http://minio:9000`), mas o URL assinado é usado pelo telefone, que só
   * conhece o nome público. A assinatura SigV4 inclui o `host`: assinar com o
   * nome interno produz um URL que o telefone resolve e o armazenamento
   * recusa, com um `SignatureDoesNotMatch` que não diz o que se passou.
   *
   * Vazio = igual ao `S3_ENDPOINT`, que é o caso em desenvolvimento.
   */
  S3_PUBLIC_ENDPOINT: z.string().default(''),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('cvforms-attachments'),
  /** Balde dos mosaicos de mapa (F8). Separado dos anexos, ver OpcoesDeBalde. */
  S3_BUCKET_MAPAS: z.string().default('cvforms-mapas'),
  S3_ACCESS_KEY_ID: z.string().default('cvforms'),
  S3_SECRET_ACCESS_KEY: z.string().default('cvforms-dev-secret'),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  /**
   * Serviço de sincronização (F5). Vazio significa «não configurado», e o
   * `/health` não inventa uma falha por causa disso: em desenvolvimento é
   * normal correr a API sem ele.
   */
  POWERSYNC_URL: z.string().default(''),
  /**
   * A partir de que atraso é que um slot de replicação passa a ser um aviso.
   * 1 GB é o ponto em que já não é um pico de trabalho e passa a ser um
   * consumidor parado (ADR-0004).
   */
  REPLICACAO_ATRASO_ALERTA_MB: z.coerce.number().int().positive().default(1024),
  /**
   * A partir de onde deixa de ser aviso e passa a ser urgente: o
   * `/health/replicacao` responde 503 e quem estiver a monitorizá-lo dispara.
   * 8 GB num disco de 40 GB ainda dá tempo para alguém agir.
   */
  REPLICACAO_ATRASO_CRITICO_MB: z.coerce.number().int().positive().default(8192),
  /** Intervalo da verificação, em segundos. 0 desliga o vigia. */
  REPLICACAO_VIGIA_S: z.coerce.number().int().nonnegative().default(300),

  /**
   * Relato de erros (F10.6). Vazio = desligado, que é o normal fora de
   * produção. O DSN é um segredo e nunca entra no repositório (restrição 9).
   */
  SENTRY_DSN: z.string().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default('http://localhost:3000'),
});

export type Env = z.infer<typeof schema> & { audiences: string[]; corsOrigins: string[] };

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const detalhe = parsed.error.issues
      .map((i) => `  ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Ambiente inválido. Ver .env.example.\n${detalhe}`);
  }
  return {
    ...parsed.data,
    audiences: parsed.data.KEYCLOAK_AUDIENCE.split(',')
      .map((a) => a.trim())
      .filter(Boolean),
    corsOrigins: parsed.data.CORS_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  };
}

export const ENV = Symbol('CVFORMS_ENV');
