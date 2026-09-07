import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

/**
 * A ligação à base, e nada mais.
 *
 * PORQUE É QUE ISTO NÃO ESTÁ NO `index.ts`. O `index.ts` é o barrel do pacote:
 * reexporta o gerador de vistas e as exportações, e esses importam o
 * `@cvforms/form-core` — que só existe compilado, em `dist/`.
 *
 * O `migrate.ts` corre com `tsx`, ANTES de haver qualquer build: é o primeiro
 * comando que toca numa base de dados nova. Se ele importar o barrel, arrasta
 * o `form-core` compilado e falha com
 * `Cannot find module '…/@cvforms/form-core/dist/index.js'` — um erro que fala
 * de módulos e não diz nada sobre migrações. Foi assim que o CI partiu: na
 * máquina de quem desenvolve o `dist/` já existe de compilações anteriores, e
 * num clone limpo não existe.
 *
 * A regra que isto impõe: **o que corre antes do build só pode importar daqui
 * ou do `schema.ts`.** Nenhum dos dois depende de nada compilado.
 */

export type Database = PostgresJsDatabase<typeof schema>;

export interface ConnectionOptions {
  url: string;
  /** O pool da API é pequeno de propósito: a carga pesada passa pelo PowerSync. */
  max?: number;
  ssl?: boolean;
}

export function createClient(options: ConnectionOptions) {
  return postgres(options.url, {
    max: options.max ?? 10,
    ssl: options.ssl ? 'require' : false,
    prepare: false,
    onnotice: () => {},
  });
}

export function createDatabase(options: ConnectionOptions): {
  db: Database;
  client: ReturnType<typeof createClient>;
} {
  const client = createClient(options);
  return { db: drizzle(client, { schema }), client };
}
