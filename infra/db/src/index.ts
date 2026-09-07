import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from './schema.js';

export * as schema from './schema.js';
export * from './schema.js';
export * from './views/index.js';
export * from './exports/index.js';

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
