/**
 * Dados de arranque para desenvolvimento.
 *
 * Vive aqui, e não no código da aplicação, de propósito: dados falsos em
 * código de produção acabam sempre por chegar a produção. Isto corre por
 * `pnpm db:seed` e nunca é importado por nada.
 *
 * Os UUID são fixos para que o realm do Keycloak (`org_id` no atributo do
 * utilizador) e os testes manuais apontem sempre para as mesmas linhas.
 */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import { createDatabase } from './index.js';
import { forms, formVersions, organizations, projects, roles } from './schema.js';

const ORG_ID = '0192f400-0000-7000-8000-000000000001';
const PROJECT_ID = '0192f400-0000-7000-8000-000000000002';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL não está definida. Ver .env.example.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  console.error('o seed não corre em produção.');
  process.exit(1);
}

const { db, client } = createDatabase({ url, max: 1 });

try {
  await db
    .insert(organizations)
    .values({ id: ORG_ID, key: 'demo', name: 'Organização Demo' })
    .onConflictDoNothing();

  await db
    .insert(projects)
    .values({ id: PROJECT_ID, orgId: ORG_ID, key: 'piloto_bengo', name: 'Piloto Bengo' })
    .onConflictDoNothing();

  for (const [key, name] of [
    ['admin', 'Administrador'],
    ['gestor', 'Gestor de projecto'],
    ['tecnico', 'Técnico de campo'],
    ['leitor', 'Leitor'],
  ] as const) {
    await db
      .insert(roles)
      .values({ id: randomUUID(), orgId: ORG_ID, key, name, system: true })
      .onConflictDoNothing();
  }

  const contagem = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM forms WHERE org_id = ${ORG_ID}`,
  );
  const jaTemFormularios = Number((contagem as unknown as { n: number }[])[0]?.n ?? 0) > 0;

  console.log('seed aplicado:');
  console.log(`  organização  ${ORG_ID}  (demo)`);
  console.log(`  projecto     ${PROJECT_ID}  (piloto_bengo)`);
  console.log('  papéis       admin, gestor, tecnico, leitor');
  if (jaTemFormularios) {
    console.log('  formulários  já existem; nada a fazer');
  } else {
    console.log('  formulários  nenhum — cria-os no painel (a partir da F2)');
  }
  console.log('');
  console.log('Entra no Keycloak com admin.demo/demo ou tecnico.demo/demo.');
  // Evita o aviso "não usado" para tabelas que só a F2 vai preencher.
  void forms;
  void formVersions;
} finally {
  await client.end();
}
