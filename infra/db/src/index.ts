import * as schema from './schema.js';

export * as schema from './schema.js';
export * from './schema.js';
export * from './views/index.js';
export * from './exports/index.js';

// A ligação vive em `cliente.ts`, sem dependências de nada compilado, para o
// `migrate.ts` a poder importar antes de haver um build. Ver o comentário lá.
export * from './cliente.js';

// `schema` fica importado para o tipo `Database` do `cliente.ts` continuar a
// ser o mesmo que este pacote expõe.
void schema;
