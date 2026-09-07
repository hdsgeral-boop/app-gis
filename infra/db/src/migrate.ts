/**
 * Corre as migrações contra a base apontada por DATABASE_URL.
 *
 * Uma migração falhada deixa a base no estado anterior: cada ficheiro corre
 * dentro da sua transacção. Não há passo manual entre migrar e arrancar a API.
 */
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { drizzle } from 'drizzle-orm/postgres-js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { createClient } from './index.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não está definida. Ver .env.example.');
  process.exit(1);
}

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
const client = createClient({ url, max: 1 });

try {
  await migrate(drizzle(client), { migrationsFolder });
  console.log('migrações aplicadas.');
} finally {
  await client.end();
}
