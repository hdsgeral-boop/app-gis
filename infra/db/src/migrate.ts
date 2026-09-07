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

// Do `cliente.ts` e NÃO do barrel: o barrel arrasta o `form-core`
// compilado, que ainda não existe quando isto corre. Ver `cliente.ts`.
import { createClient } from './cliente.js';

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
